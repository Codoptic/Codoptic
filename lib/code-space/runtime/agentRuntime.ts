import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { classifyCodeSpaceIntent } from '@/lib/code-space/core';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import type { ProviderSession } from '@/lib/agent/providers';
import { normalizeCodeSpaceAgentMode, type CodeSpaceAgentMode } from '@/lib/code-space/agentModes';
import { extractBuildPlanPath } from '@/lib/code-space/planBuild';
import { guardPath } from '@/lib/security/pathGuard';
import { ContextGraphEngine, type ContextAttachment, type ContextGraphResult } from './contextGraphEngine';
import { getEventStore, type EventStore } from './eventStore';
import { createAgentEvent, type AgentEventType } from './events';
import { InstructionLoader } from './instructionLoader';
import { PlanningEngine } from './planningEngine';
import { createRunState, transitionRunState, type CodeSpaceRunPhase, type CodeSpaceRunState } from './runState';
import { ValidationRunner, progressiveOrder, type ValidationRunResult } from './validationRunner';
import { IntegrationVerifier } from './integrationVerifier';
import { Supervisor } from './supervisor';
import { SubagentRunner } from './subagentRunner';
import type { TerminalCommand } from './terminalPolicy';
import type { LoadedInstruction } from './instructionLoader';
import { RepairLoop } from './repairLoop';
import { buildAskFinalResponse, buildCodeFinalResponse, buildCodeProposalResponse, buildPlanFinalResponse, tightenAgentSummary } from './responsePolicy';
import { CodeAgentLoop, buildCodeSystemPrompt, buildCodeSeedMessage, type CodeAgentLoopOptions } from './codeAgentLoop';
import { PLAN_MODE_TOOL_SPECS, buildPlanSystemPrompt, buildPlanSeedMessage, buildPlanFinalizationDirective } from './planAgentLoop';
import { ToolExecutor, createRunRevertCheckpoint, buildEditEscalationDirective, formatUnresolvedEditFailures, type CodeAgentContext, type LedgerEntry } from './toolExecutor';
import { ToolBudget } from './toolBudget';
import { createDefaultToolRegistry } from './toolRegistry';
import { PermissionManager } from './permissionManager';
import { TerminalRunner } from './terminalRunner';
import { getCodeSpaceStore } from './serverStore';
import type { FileCheckpoint } from './checkpointManager';
import { AutonomyLevelSchema } from '@/lib/code-space/domain';
import {
  assessContextSufficiency,
  assessPromptAmbiguity,
  buildRecallDirective,
  type ContextSufficiencyReport,
} from './workflowPolicy';
import { createUnifiedDiff } from '@/lib/code-space/agent/editBlocks';
import { GitManager } from './gitManager';
import { loadPendingValidation, removePendingValidation, savePendingValidation, type PendingValidationRecord } from './pendingValidation';
import {
  KNOWLEDGE_GRAPH_DIR,
  buildKnowledgeGraph,
  knowledgeGraphMetadata,
  knowledgeGraphSignals,
  loadKnowledgeGraph,
  type KnowledgeGraphMetadata,
} from './knowledgeGraph';
import {
  addValidationCoverage,
  createImplementationContract,
  summarizeContract,
} from './implementationContract';
import { MemoryManager, type MemoryContext } from './memoryManager';
import { DelegationPlanner, toSubagentRequest, type DelegationReport } from './delegationPlanner';
import { AgentOrchestrator } from './agentOrchestrator';
import { ContextLedger } from './contextLedger';
import { BrowserController } from './browserController';
import { normalizeRuntimeScaleProfile, runtimeScaleLimits } from './scaleProfile';
import { CoworkingRunManager } from './coworkingRunManager';
import { HookRunner } from './hookRunner';

export const ResumeValidationRequestSchema = z.object({
  runId: z.string(),
  projectRoot: z.string(),
  projectName: z.string().optional().default(''),
  model: z.string().optional().default(''),
  providerId: z.enum(['anthropic', 'openai', 'gemini', 'grok', 'foundry', 'local', 'mistral', 'deepseek', 'nvidia', 'openrouter']).optional().default('openai'),
  apiKey: z.string().optional().default(''),
  endpoint: z.string().optional(),
  toolBudget: z.number().optional().default(50),
  decision: z.enum(['confirm', 'cancel']).optional().default('confirm'),
});

export type ResumeValidationRequest = z.infer<typeof ResumeValidationRequestSchema>;

export const RuntimeMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
});

export const RuntimeAttachmentSchema = z.object({
  kind: z.enum(['file', 'folder']),
  relativePath: z.string().min(1),
  displayName: z.string().min(1).optional(),
});

export const AgentRuntimeRequestSchema = z.object({
  sessionId: z.string(),
  projectRoot: z.string(),
  projectName: z.string(),
  messages: z.array(RuntimeMessageSchema).min(1),
  model: z.string().optional().default(''),
  providerId: z.enum(['anthropic', 'openai', 'gemini', 'grok', 'foundry', 'local', 'mistral', 'deepseek', 'nvidia', 'openrouter']).optional().default('openai'),
  apiKey: z.string().optional().default(''),
  endpoint: z.string().optional(),
  openTabs: z.array(z.string()).default([]),
  mode: z.enum(['ask', 'plan', 'code']).optional().default('code'),
  toolBudget: z.number().default(50),
  autonomy: AutonomyLevelSchema.optional().default('auto_safe_tools'),
  scaleProfile: z.enum(['standard', 'deep', 'massive', 'full_access_local']).optional(),
  attachments: z.array(RuntimeAttachmentSchema).optional().default([]),
});

export type AgentRuntimeRequest = z.infer<typeof AgentRuntimeRequestSchema>;
export type AgentRuntimeEmit = (event: AgentSSEEvent) => void | Promise<void>;

export class AgentRuntime {
  constructor(
    private readonly context = new ContextGraphEngine(),
    private readonly instructions = new InstructionLoader(),
    private readonly planning = new PlanningEngine(),
    private readonly validation = new ValidationRunner(),
    private readonly repairLoop = new RepairLoop(),
    private readonly events: EventStore = getEventStore(),
    private readonly memories = new MemoryManager(),
    private readonly delegation = new DelegationPlanner(),
    private readonly coworking = new CoworkingRunManager(),
  ) {}

  async run(request: AgentRuntimeRequest, emit: AgentRuntimeEmit, signal?: AbortSignal): Promise<void> {
    const guarded = guardPath(request.projectRoot);
    if (!guarded.ok) throw new Error(guarded.reason ?? 'Invalid project root');
    const root = guarded.resolved;
    const mode = normalizeCodeSpaceAgentMode(request.mode);
    const latestUserMessage = [...request.messages].reverse().find((message) => message.role === 'user');
    if (!latestUserMessage) throw new Error('A user message is required to start the agent.');

    const runId = `run:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    let state = createRunState(runId);
    const projectId = request.projectName;
    const prompt = mode === 'plan' ? findOriginalPlanPrompt(request.messages, latestUserMessage.content) : latestUserMessage.content;
    const buildPlanPath = extractBuildPlanPath(latestUserMessage.content);

    const emitRuntime = async (type: AgentEventType, payload: unknown) => {
      const event = await this.events.append(createAgentEvent({ type, projectId, sessionId: request.sessionId, runId, payload }));
      await emit({ type: 'structured_event', event });
    };
    const setPhase = async (phase: CodeSpaceRunPhase, payload: Record<string, unknown> = {}) => {
      state = transitionRunState(state, phase);
      await emitRuntime('plan.updated', { phase, state, ...payload });
    };

    const scaleProfile = normalizeRuntimeScaleProfile(request.scaleProfile, mode);
    await emitRuntime('run.created', { mode, toolBudget: request.toolBudget, scaleProfile });
    await emitRuntime('run.started', { projectName: request.projectName });

    try {
      await setPhase('classifying');
      const intents = classifyCodeSpaceIntent(prompt);
      await emitTool(emit, emitRuntime, 'classify_task', { mode, intents }, async () => ({ mode, intents, contract: describeModeContract(mode) }));

      await setPhase('loading_project_rules');
      const loadedInstructions = await emitTool(emit, emitRuntime, 'load_project_rules', { buildPlanPath }, async () =>
        this.instructions.loadProjectInstructions(root, buildPlanPath),
      );
      const memoryContext = await emitTool(emit, emitRuntime, 'load_project_memories', { root: 'memories' }, async () =>
        this.memories.collectRelevant(root, prompt),
      );
      await emitRuntime('memory.loaded', {
        paths: memoryContext.entries.map((entry) => entry.path),
        recommendedFiles: memoryContext.recommendedFiles,
      });

      await setPhase('mapping_repository');
      await this.ensureKnowledgeGraph(root, request.projectName, emit, emitRuntime);
      await setPhase('gathering_context');
      // Knowledge-graph context reuse: a previously built graph biases file selection toward the
      // repository's architectural hubs (god nodes). The project-level cache is refreshed before
      // context gathering so subsequent sessions and modes all reuse the same current map.
      const cachedGraph = await loadKnowledgeGraph(root);
      const structuralSignals = cachedGraph ? knowledgeGraphSignals(cachedGraph) : undefined;
      const context = await emitTool(emit, emitRuntime, 'context_graph', { openTabs: request.openTabs, attachments: request.attachments, mode }, async () =>
        this.context.collectProjectContext(root, prompt, {
          mode,
          openTabs: request.openTabs,
          attachments: request.attachments as ContextAttachment[],
          buildPlanPath,
          structuralSignals,
          limitHint: mode === 'ask' ? 15 : mode === 'plan' ? 35 : 50,
        }),
      );
      await emitRuntime('context.search.completed', {
        selectedFiles: context.selectedFiles,
        omittedRelevantCandidates: context.omittedRelevantCandidates,
        confidence: context.confidence,
        missingContextWarnings: context.missingContextWarnings,
      });

      await setPhase('tracing_dependencies', { dependencyEdges: context.dependencyEdges.length });
      const todos = this.planning.buildTodos(mode, context);
      emit({ type: 'plan_created', items: todos });
      todos.forEach((text, index) => emit({ type: 'todo_created', todo: { id: `todo:${runId}:${index}`, text, done: false } }));

      await setPhase('planning');
      const validationCommands = await emitTool(emit, emitRuntime, 'validation_strategy', { mode }, async () =>
        this.validation.detectValidationCommands(root),
      );
      const sufficiency = assessContextSufficiency({ mode, prompt, context, buildPlanPath, validationCommands });
      await emitRuntime('context.sufficiency.completed', sufficiency);

      if (mode === 'ask') {
        await this.finishAsk(request, prompt, context, emit, emitRuntime, runId, state, todos);
        return;
      }
      if (mode === 'plan') {
        await this.finishPlan(request, root, prompt, context, validationCommands, emit, emitRuntime, runId, todos, loadedInstructions, sufficiency, memoryContext, signal);
        return;
      }
      await this.finishCode(request, root, prompt, context, validationCommands, emit, emitRuntime, runId, todos, loadedInstructions, sufficiency, memoryContext, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setPhase('failed', { message });
      await emitRuntime('run.failed', { message });
      await emit({ type: 'agent_error', message, recoverable: true });
    }
  }

  /**
   * Build the project knowledge graph on the first run (cached and reused thereafter), then
   * emit a `knowledge_graph_ready` event so the UI can surface the "Knowledge graph" link + modal.
   * The build uses the offline AST/regex pipeline; failures are non-fatal to the agent run.
   */
  private async ensureKnowledgeGraph(
    root: string,
    projectId: string,
    emit: AgentRuntimeEmit,
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
  ): Promise<void> {
    try {
      let metadata: KnowledgeGraphMetadata | null = await knowledgeGraphMetadata(root);
      if (!metadata || metadata.stale) {
        await emitRuntime('knowledge_graph.building', { root, stale: Boolean(metadata?.stale) });
        metadata = await buildKnowledgeGraph(root, { maxFiles: 4000, timeoutMs: 90_000 });
      }
      const viewUrl = `/api/code-space/knowledge-graph/view?root=${encodeURIComponent(root)}`;
      emit({
        type: 'knowledge_graph_ready',
        projectId,
        nodeCount: metadata.nodeCount,
        edgeCount: metadata.edgeCount,
        viewUrl,
        reportPath: `${KNOWLEDGE_GRAPH_DIR}/GRAPH_REPORT.md`,
        createdAt: metadata.generatedAt,
      });
      await emitRuntime('knowledge_graph.ready', {
        nodeCount: metadata.nodeCount,
        edgeCount: metadata.edgeCount,
        communityCount: metadata.communityCount,
        viewUrl,
      });
    } catch (error) {
      await emitRuntime('knowledge_graph.failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async runAutomaticDelegation(params: {
    runId: string;
    prompt: string;
    context: ContextGraphResult;
    validationCommands: TerminalCommand[];
    subagentRunner: SubagentRunner;
    scaleProfile: ReturnType<typeof normalizeRuntimeScaleProfile>;
    contextLedger?: ContextLedger;
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>;
  }): Promise<DelegationReport> {
    const planner = new DelegationPlanner(params.scaleProfile);
    const plan = planner.plan({
      runId: params.runId,
      prompt: params.prompt,
      context: params.context,
      validationCommands: params.validationCommands,
      mode: 'code',
      scaleProfile: params.scaleProfile,
    });
    const results: DelegationReport['results'] = [];
    if (!plan.required) return { plan, results, reconciled: true };

    await params.emitRuntime('subagent.plan.created', {
      reasons: plan.reasons,
      tasks: plan.tasks.map((task) => ({ id: task.id, role: task.role, reason: task.reason, readOnly: task.readOnly })),
      scaleProfile: params.scaleProfile,
      limits: plan.workGraph?.limits,
    });

    const limits = plan.workGraph?.limits ?? runtimeScaleLimits(params.scaleProfile, 'code');
    const queue = [...plan.tasks];
    for (let offset = 0; offset < queue.length; offset += limits.maxSubagentConcurrency) {
      const batch = queue.slice(offset, offset + limits.maxSubagentConcurrency);
      const batchResults = await Promise.all(
        batch.map(async (task) => {
          try {
            return await params.subagentRunner.spawn(toSubagentRequest(task));
          } catch (error) {
            return {
              role: task.role,
              summary: error instanceof Error ? error.message : String(error),
              success: false,
              toolCalls: 0,
            };
          }
        }),
      );
      results.push(...batchResults);
      for (const result of batchResults) {
        params.contextLedger?.add({ kind: 'subagent', summary: `${result.role}: ${result.summary}`, status: result.success ? 'completed' : 'failed' });
      }
    }

    if (plan.workGraph) {
      const reconciliation = new AgentOrchestrator(params.scaleProfile).reconcile(plan.workGraph, results);
      if (reconciliation.continuationNeeded) {
        params.contextLedger?.markContinuation(reconciliation.continuationReason ?? 'Subagent work remains queued.', plan.workGraph.packages.slice(results.length).map((pkg) => pkg.id));
      }
    }

    const reconciled = results.length === plan.tasks.length;
    await params.emitRuntime('subagent.reconciled', {
      required: plan.required,
      reconciled,
      results: results.map((result) => ({ role: result.role, success: result.success, summary: result.summary })),
    });
    return { plan, results, reconciled };
  }

  private async finishAsk(
    request: AgentRuntimeRequest,
    prompt: string,
    context: ContextGraphResult,
    emit: AgentRuntimeEmit,
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
    runId: string,
    state: CodeSpaceRunState,
    todos: string[],
  ) {
    const answer = buildAskFinalResponse({
      projectName: request.projectName,
      prompt,
      evidence: context.files.map((file) => ({ path: file.path, summary: file.summary, content: file.content })),
      missingContextWarnings: context.missingContextWarnings,
    });
    todos.forEach((_, index) => emit({ type: 'todo_updated', todoId: `todo:${runId}:${index}`, done: true }));
    await streamAnswer(answer, emit, emitRuntime);
    await emitRuntime('validation.completed', { status: 'passed', summary: 'Ask mode completed read-only.' });
    await emitRuntime('run.completed', { status: 'verified', phase: 'verified', filesChanged: [], state: transitionRunState(state, 'verified') });
    emit({ type: 'agent_done', summary: answer, filesChanged: [] });
  }

  private async finishPlan(
    request: AgentRuntimeRequest,
    root: string,
    prompt: string,
    context: ContextGraphResult,
    validationCommands: TerminalCommand[],
    emit: AgentRuntimeEmit,
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
    runId: string,
    todos: string[],
    loadedInstructions: LoadedInstruction[],
    sufficiency: ContextSufficiencyReport,
    memoryContext: MemoryContext,
    signal?: AbortSignal,
  ) {
    const credentials = await resolveProviderCredentials(root, request);
    if (!credentials.apiKey && request.providerId !== 'local') {
      const answer = `The "${request.providerId}" provider is not configured (no API key found), so Plan mode cannot research the repository and author a grounded plan. Add a provider key and retry.`;
      await streamAnswer(answer, emit, emitRuntime);
      await emitRuntime('run.completed', { status: 'needs_review', phase: 'needs_review', filesChanged: [] });
      emit({ type: 'agent_done', summary: answer, filesChanged: [] });
      return;
    }

    const clarificationAnswers = [...request.messages]
      .reverse()
      .find((message) => message.role === 'user' && message.content.includes('Plan clarification answers:'))?.content;

    const ambiguity = assessPromptAmbiguity({ prompt, context, hasClarificationAnswers: Boolean(clarificationAnswers) });

    const ctx: CodeAgentContext = {
      root,
      runId,
      projectId: request.projectName,
      sessionId: request.sessionId,
      autonomy: request.autonomy,
      emit,
      emitRuntime,
      ledger: new Map<string, LedgerEntry>(),
      proposedFiles: new Set<string>(),
      proposedLedger: new Map(),
      editFailures: new Map(),
      readFiles: new Set(context.files.map((file) => file.path)),
      artifacts: new Map(),
      checkpoints: [],
      registry: createDefaultToolRegistry(),
      permission: new PermissionManager(),
      terminal: new TerminalRunner(),
      signal,
    };

    const budget = new ToolBudget(request.toolBudget, resolveMaxTurns(request.toolBudget));
    const session: ProviderSession = { id: request.providerId, model: request.model, endpoint: credentials.endpoint, apiKey: credentials.apiKey || 'local' };
    const loopOptions: CodeAgentLoopOptions = { session, budget, signal, tools: PLAN_MODE_TOOL_SPECS };

    const loop = new CodeAgentLoop(new ToolExecutor(ctx.registry, ctx.permission));
    loop.seed(
      buildPlanSystemPrompt(request.projectName, loadedInstructions.map((item) => item.path)),
      await buildPlanSeedMessage(
        root,
        prompt,
        context,
        validationCommands.map((command) => ({ command: command.command, args: command.args, reason: command.reason })),
        sufficiency,
        clarificationAnswers,
        request.model,
        ambiguity,
        memoryContext,
      ),
    );

    await loop.run(ctx, loopOptions);

    // Keep the agent working until it asks clarifying questions or authors the plan. We never let
    // the loop quit early: it recalls more evidence when the gate wants it and is forced to finalize
    // via write_plan_artifact (models otherwise tend to answer in prose and stop).
    const MAX_PLAN_ESCALATIONS = 4;
    for (let attempt = 0; attempt < MAX_PLAN_ESCALATIONS; attempt += 1) {
      if (ctx.planClarification || ctx.planArtifactRequest) break;
      if (loopOptions.budget.turnsExhausted()) break;
      await loop.continueWith(buildPlanFinalizationDirective(sufficiency), ctx, loopOptions);
    }

    if (ctx.planClarification && !ctx.planArtifactRequest) {
      await emitRuntime('plan.updated', { phase: 'awaiting_clarification' });
      emit({ type: 'clarifying_questions_created', questions: ctx.planClarification.questions });
      const answer = `I need a few details before finalizing the plan for ${request.projectName}. Answer the clarifying questions and I will ground the plan in your intent.`;
      await streamAnswer(answer, emit, emitRuntime);
      await emitRuntime('run.completed', { status: 'awaiting_review', phase: 'awaiting_clarification', filesChanged: [] });
      emit({ type: 'agent_done', summary: answer, filesChanged: [] });
      return;
    }

    if (ctx.planArtifactRequest) {
      const artifact = await emitTool(emit, emitRuntime, 'write_plan_artifact', { inspectedFiles: ctx.planArtifactRequest.inspectedFiles }, async () =>
        this.planning.writePlanContent(root, request.sessionId, ctx.planArtifactRequest!.planMarkdown),
      );
      emit({ type: 'plan_markdown_created', filePath: artifact.filePath, content: artifact.content });
      todos.forEach((_, index) => emit({ type: 'todo_updated', todoId: `todo:${runId}:${index}`, done: true }));
      const answer = buildPlanFinalResponse({
        projectName: request.projectName,
        planPath: artifact.filePath,
        planContent: artifact.content,
        inspectedFiles: context.files.map((file) => ({ path: file.path, summary: file.summary })),
        validationCommands: validationCommands.map((command) => ({ command: [command.command, ...command.args].join(' '), reason: command.reason })),
      });
      await streamAnswer(answer, emit, emitRuntime);
      const status = ctx.planArtifactRequest.status === 'ready' ? 'verified' : 'needs_review';
      await emitRuntime('run.completed', { status, phase: status, filesChanged: [artifact.filePath] });
      emit({ type: 'agent_done', summary: answer, filesChanged: [artifact.filePath] });
      return;
    }

    // Guarantee a previewable plan: the model never called write_plan_artifact (or ran out of turns),
    // so synthesize an evidence-grounded plan from the gathered context. A plan file must ALWAYS exist.
    const fallback = await emitTool(emit, emitRuntime, 'write_plan_artifact', { inspectedFiles: context.selectedFiles, synthesized: true }, async () =>
      this.planning.writePlanArtifact(root, request.sessionId, request.projectName, prompt, context, validationCommands),
    );
    emit({ type: 'plan_markdown_created', filePath: fallback.filePath, content: fallback.content });
    todos.forEach((_, index) => emit({ type: 'todo_updated', todoId: `todo:${runId}:${index}`, done: true }));
    const answer = [
      buildPlanFinalResponse({
        projectName: request.projectName,
        planPath: fallback.filePath,
        planContent: fallback.content,
        inspectedFiles: context.files.map((file) => ({ path: file.path, summary: file.summary })),
        validationCommands: validationCommands.map((command) => ({ command: [command.command, ...command.args].join(' '), reason: command.reason })),
      }),
      'Note: this plan was auto-synthesized from the gathered evidence because the model did not finalize one itself. Review it before building.',
    ].join('\n\n');
    await streamAnswer(answer, emit, emitRuntime);
    await emitRuntime('run.completed', { status: 'needs_review', phase: 'needs_review', filesChanged: [fallback.filePath] });
    emit({ type: 'agent_done', summary: answer, filesChanged: [fallback.filePath] });
  }

  private async finishCode(
    request: AgentRuntimeRequest,
    root: string,
    prompt: string,
    context: ContextGraphResult,
    validationCommands: TerminalCommand[],
    emit: AgentRuntimeEmit,
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
    runId: string,
    todos: string[],
    loadedInstructions: LoadedInstruction[],
    sufficiency: ContextSufficiencyReport,
    memoryContext: MemoryContext,
    signal?: AbortSignal,
  ) {
    const credentials = await resolveProviderCredentials(root, request);
    if (!credentials.apiKey && request.providerId !== 'local') {
      const answer = `The "${request.providerId}" provider is not configured (no API key found), so Code mode cannot run autonomously. Add a provider key and retry.`;
      await streamAnswer(answer, emit, emitRuntime);
      await emitRuntime('run.completed', { status: 'needs_review', phase: 'needs_review', filesChanged: [] });
      emit({ type: 'agent_done', summary: answer, filesChanged: [] });
      return;
    }

    await emitRuntime('plan.updated', { phase: 'proposing_patch' });
    const buildPlanPath = extractBuildPlanPath(prompt);
    const scaleProfile = normalizeRuntimeScaleProfile(request.scaleProfile, 'code');
    const limits = runtimeScaleLimits(scaleProfile, 'code');
    const contextLedger = new ContextLedger(runId, scaleProfile);
    const coworkingRun = await this.coworking.create({
      runId,
      sessionId: request.sessionId,
      projectId: request.projectName,
      projectRoot: root,
      prompt,
      scaleProfile,
    });
    await emitRuntime('coworking.run.created', {
      runId,
      phase: coworkingRun.phase,
      scaleProfile,
      syncMode: coworkingRun.syncMode,
      artifactsPath: `.agent/runs/${runId}`,
    });
    const store = getCodeSpaceStore();
    const ledger = new Map<string, LedgerEntry>();
    const persistCheckpoint = async (checkpoint: FileCheckpoint) => {
      await store.upsert('checkpoints', {
        id: checkpoint.id,
        projectId: checkpoint.projectId,
        runId: checkpoint.runId,
        reason: checkpoint.reason,
        snapshotRef: checkpoint.snapshotRef,
        createdAt: checkpoint.createdAt,
      });
    };

    const ctx: CodeAgentContext = {
      root,
      runId,
      projectId: request.projectName,
      sessionId: request.sessionId,
      autonomy: request.autonomy,
      emit,
      emitRuntime,
      ledger,
      patchHistory: [],
      implementationContract: createImplementationContract(prompt, await readPlanMarkdown(root, buildPlanPath)),
      proposedFiles: new Set<string>(),
      proposedLedger: new Map(),
      editFailures: new Map(),
      readFiles: new Set(context.files.map((file) => file.path)),
      artifacts: new Map(),
      checkpoints: [],
      memoryUpdateProposals: [],
      contextLedger,
      scaleProfile,
      browser: new BrowserController(),
      registry: createDefaultToolRegistry(),
      permission: new PermissionManager(),
      terminal: new TerminalRunner(),
      onCheckpoint: persistCheckpoint,
      signal,
    };
    emit({ type: 'coverage_updated', contract: ctx.implementationContract! });
    emit({
      type: 'agent_status',
      status: {
        id: `status:${runId}:contract`,
        title: 'Tracking implementation contract',
        detail: summarizeContract(ctx.implementationContract),
        phase: 'proposing_patch',
        status: 'running',
        createdAt: Date.now(),
      },
    });

    const budget = new ToolBudget(Math.max(request.toolBudget, limits.maxSpendUnits), resolveMaxTurns(Math.max(request.toolBudget, limits.maxSpendUnits)));
    const session: ProviderSession = { id: request.providerId, model: request.model, endpoint: credentials.endpoint, apiKey: credentials.apiKey || 'local' };
    const loopOptions: CodeAgentLoopOptions = { session, budget, signal };

    const subagentRunner = new SubagentRunner(ctx, session, request.projectName);
    ctx.spawnSubagent = (subRequest) => subagentRunner.spawn(subRequest);
    const delegationReport = await this.runAutomaticDelegation({
      runId,
      prompt,
      context,
      validationCommands,
      subagentRunner,
      scaleProfile,
      contextLedger,
      emitRuntime,
    });
    if (delegationReport.plan.workGraph) {
      const persistedGraph = await this.coworking.persistGraph(coworkingRun, delegationReport.plan.workGraph);
      await emitRuntime('coworking.workgraph.persisted', {
        runId,
        graphId: persistedGraph.id,
        packageCount: persistedGraph.packages.length,
        readyCount: persistedGraph.packages.filter((pkg) => pkg.status === 'ready').length,
      });
      for (const [index, result] of delegationReport.results.entries()) {
        const pkg = persistedGraph.packages[index];
        if (!pkg) continue;
        await this.coworking.recordDeliverable(runId, {
          packageId: pkg.id,
          role: pkg.role,
          status: result.success ? 'done' : 'blocked',
          changedFiles: [],
          evidence: [{ kind: 'review', summary: result.summary }],
          blockers: result.success ? [] : [result.summary],
          handoffNotes: result.summary,
          validationRequested: [],
          confidence: result.success ? 'medium' : 'low',
        });
        await emitRuntime('coworking.deliverable.recorded', {
          runId,
          packageId: pkg.id,
          role: pkg.role,
          status: result.success ? 'done' : 'blocked',
        });
      }
    }
    await this.coworking.transition(runId, 'executing', 'Parent agent is integrating governed package findings.');
    await emitRuntime('coworking.phase.changed', { runId, phase: 'executing' });

    const loop = new CodeAgentLoop(new ToolExecutor(ctx.registry, ctx.permission));
    loop.seed(
      buildCodeSystemPrompt(request.projectName, loadedInstructions.map((item) => item.path), request.autonomy),
      await buildCodeSeedMessage(
        root,
        prompt,
        context,
        validationCommands.map((command) => ({ command: command.command, args: command.args, reason: command.reason })),
        sufficiency,
        request.model,
        memoryContext,
        delegationReport,
        contextLedger.summarize(),
        request.autonomy,
      ),
    );

    let loopResult = await loop.run(ctx, loopOptions);

    const MAX_CONTEXT_RECALL_ESCALATIONS = 2;
    for (let attempt = 0; attempt < MAX_CONTEXT_RECALL_ESCALATIONS; attempt += 1) {
      if (ledger.size > 0 || ctx.proposedFiles.size > 0 || (ctx.createdDirectories?.size ?? 0) > 0 || sufficiency.status === 'ready') break;
      if (loopOptions.budget.turnsExhausted()) break;
      loopResult = await loop.continueWith(buildRecallDirective(sufficiency), ctx, loopOptions);
    }

    // Motivation vs Logic: models surrender after recoverable edit_file diagnostics. Escalate back into
    // the live thread when nothing was applied/proposed but unresolved edit failures remain.
    const MAX_EDIT_ESCALATIONS = 3;
    for (let attempt = 0; attempt < MAX_EDIT_ESCALATIONS; attempt += 1) {
      if (loopResult.success !== false) break;
      if (ledger.size > 0 || ctx.proposedFiles.size > 0 || (ctx.createdDirectories?.size ?? 0) > 0) break;
      if (ctx.editFailures.size === 0) break;
      if (loopOptions.budget.turnsExhausted() || loopOptions.budget.mutationBudgetExhausted()) break;
      loopResult = await loop.continueWith(buildEditEscalationDirective(ctx), ctx, loopOptions);
    }

    // Confirm mode (suggest_only): the loop proposed diffs but wrote nothing. Surface them for
    // accept/reject instead of validating/fixing unchanged code or reporting an autonomy failure.
    if (ledger.size === 0 && ctx.proposedFiles.size > 0) {
      const proposed = Array.from(ctx.proposedFiles);
      await this.coworking.persistLedger(runId, contextLedger);
      await emitRuntime('coworking.ledger.persisted', { runId, entries: contextLedger.list().length });
      await emitRuntime('plan.updated', { phase: 'awaiting_diff_confirmation' });
      // Pre-validation diff confirmation gate (Confirm mode): surface the full proposed
      // change set so the user reviews every change before accepting + validating. We persist
      // a pending-validation record keyed off the proposed before/after so that, once the user
      // accepts the patches (written to disk via /patches), POST /runs/validate can run the
      // detected validation/repair phase against the now-applied workspace.
      const proposalEntries = Array.from(ctx.proposedLedger.entries()).map(([filePath, entry]) => ({
        path: filePath,
        beforeContent: entry.beforeContent,
        afterContent: entry.afterContent,
        deleted: false,
        existedBefore: entry.existedBefore,
      }));
      const diffReport = await buildAggregatedDiff(root, proposalEntries);
      await savePendingValidation({
        runId,
        sessionId: request.sessionId,
        projectRoot: root,
        projectName: request.projectName,
        prompt,
        instructionPaths: loadedInstructions.map((item) => item.path),
        isGit: diffReport.isGit,
        unifiedDiff: diffReport.unifiedDiff,
        createdAt: Date.now(),
        files: proposalEntries.map((entry) => ({
          path: entry.path,
          beforeContent: entry.beforeContent,
          afterContent: entry.afterContent,
          deleted: false,
          existedBefore: entry.existedBefore,
        })),
      });
      // Concise-output guard: tighten the model summary so a verbose multi-section dump
      // never leaks into the proposal chat reply (the rich diff is shown elsewhere in the UI).
      const tightenedProposalSummary = tightenAgentSummary(loopResult.summary);
      const proposalSummary = [
        `Proposed ${proposed.length} change(s) to ${request.projectName}. Review the full diff, accept the patches, then confirm to run validation.`,
        diffReport.isGit ? '(diff source: git)' : '(diff source: in-memory change ledger — no git repo detected)',
        '',
        tightenedProposalSummary,
      ]
        .filter((line) => line !== undefined && line !== '')
        .join('\n');
      emit({
        type: 'diff_confirmation_required',
        runId,
        sessionId: request.sessionId,
        filesChanged: proposed,
        files: diffReport.files,
        unifiedDiff: diffReport.unifiedDiff,
        isGit: diffReport.isGit,
        summary: proposalSummary,
      });
      const proposalAnswer = buildCodeProposalResponse(request.projectName, proposed, tightenedProposalSummary);
      await streamAnswer(proposalAnswer, emit, emitRuntime);
      await emitRuntime('run.completed', { status: 'awaiting_review', phase: 'awaiting_diff_confirmation', filesChanged: proposed });
      emit({ type: 'agent_done', summary: proposalAnswer, filesChanged: proposed });
      return;
    }

    if (ledger.size === 0 && (ctx.createdDirectories?.size ?? 0) > 0) {
      const directoriesChanged = Array.from(ctx.createdDirectories ?? []);
      const answer = tightenAgentSummary(loopResult.summary) || `Created ${directoriesChanged.length} director${directoriesChanged.length === 1 ? 'y' : 'ies'}.`;
      await this.coworking.persistLedger(runId, contextLedger);
      await emitRuntime('coworking.ledger.persisted', { runId, entries: contextLedger.list().length });
      await streamAnswer(answer, emit, emitRuntime);
      await emitRuntime('run.completed', { status: 'verified', phase: 'verified', filesChanged: directoriesChanged });
      emit({ type: 'agent_done', summary: answer, filesChanged: directoriesChanged });
      return;
    }

    if (ledger.size === 0) {
      // Concise-output guard: blocked agents tend to dump multi-section reports here
      // ("Summary of intent and actions", "DoD status vs checklist", "Options for you"). Tighten
      // to a single short paragraph and only attach a brief blocker/warning suffix when present —
      // never the full v3.2 boilerplate the runtime used to append.
      const tightened = tightenAgentSummary(loopResult.summary) || 'No files were changed.';
      const blocker = sufficiency.blockers[0];
      const suffix = blocker ? ` Blocker: ${blocker}` : sufficiency.warnings[0] ? ` Note: ${sufficiency.warnings[0]}` : '';
      const answer = `${tightened}${suffix}`.trim();
      contextLedger.markContinuation('Code mode stopped without concrete changes after recall/repair gates.', []);
      await this.coworking.transition(runId, 'blocked', 'Code mode stopped without concrete changes.', [answer]);
      await this.coworking.persistLedger(runId, contextLedger);
      await emitRuntime('coworking.phase.changed', { runId, phase: 'blocked', blockers: [answer] });
      await streamAnswer(answer, emit, emitRuntime);
      await emitRuntime('run.completed', { status: 'needs_review', phase: 'needs_review', filesChanged: [] });
      emit({ type: 'validation_result', id: `validation:${runId}:no_changes`, command: 'v3.2 implementation gate', status: 'failed', output: 'Code mode produced no applied files after recall/repair gates.' });
      emit({ type: 'agent_done', summary: answer, filesChanged: [] });
      return;
    }

    // Surface the FULL aggregated diff of every applied change before validation starts. In the
    // default auto-safe Code path this is an informational review event, not a terminal pause: the
    // runtime continues into validation/repair and only completes after supervisor reconciliation.
    // Review-gated autonomy still persists the pending record and pauses for /runs/validate.
    const diffReport = await buildAggregatedDiff(
      root,
      Array.from(ctx.ledger.entries()).map(([filePath, entry]) => ({
        path: filePath,
        beforeContent: entry.beforeContent,
        afterContent: entry.afterContent,
        deleted: entry.deleted,
      })),
    );
    const filesChanged = Array.from(ctx.ledger.keys());
    const editHooks = new HookRunner().runAll(ctx, filesChanged);
    for (const hook of editHooks) {
      contextLedger.add({
        kind: 'decision',
        summary: `${hook.hook}: ${hook.summary}`,
        status: hook.status === 'passed' ? 'passed' : hook.status === 'blocked' ? 'failed' : 'skipped',
      });
      await emitRuntime('coworking.hook.completed', hook);
    }
    await this.coworking.persistLedger(runId, contextLedger);
    await emitRuntime('coworking.ledger.persisted', { runId, entries: contextLedger.list().length });
    await emitRuntime('plan.updated', { phase: 'diff_review_emitted' });
    const tightenedGateSummary = tightenAgentSummary(loopResult.summary);
    const reviewSummary = [
      `Applied ${filesChanged.length} change(s) to ${request.projectName}. Review event emitted; validation is running now.`,
      diffReport.isGit ? '(diff source: git)' : '(diff source: in-memory change ledger — no git repo detected)',
      '',
      tightenedGateSummary,
      '',
      'Files changed:',
      ...filesChanged.map((file) => `- ${file}`),
    ]
      .filter((line) => line !== undefined)
      .join('\n');
    emit({
      type: 'diff_confirmation_required',
      runId,
      sessionId: request.sessionId,
      filesChanged,
      files: diffReport.files,
      unifiedDiff: diffReport.unifiedDiff,
      isGit: diffReport.isGit,
      summary: reviewSummary,
    });

    if (request.autonomy === 'approval_required') {
      await savePendingValidation({
        runId,
        sessionId: request.sessionId,
        projectRoot: root,
        projectName: request.projectName,
        prompt,
        instructionPaths: loadedInstructions.map((item) => item.path),
        isGit: diffReport.isGit,
        unifiedDiff: diffReport.unifiedDiff,
        createdAt: Date.now(),
        files: Array.from(ctx.ledger.entries()).map(([filePath, entry]) => ({
          path: filePath,
          beforeContent: entry.beforeContent,
          afterContent: entry.afterContent,
          deleted: entry.deleted,
          existedBefore: entry.existedBefore,
        })),
      });
      await emitRuntime('plan.updated', { phase: 'awaiting_diff_confirmation' });
      const gateSummary = reviewSummary.replace('Review event emitted; validation is running now.', 'Review the full diff below and confirm to run validation.');
      await streamAnswer(gateSummary, emit, emitRuntime);
      await emitRuntime('run.completed', { status: 'awaiting_review', phase: 'awaiting_diff_confirmation', filesChanged });
      emit({ type: 'agent_done', summary: gateSummary, filesChanged });
      return;
    }

    await this.runValidationPhase({
      projectName: request.projectName,
      root,
      prompt,
      runId,
      todos,
      validationCommands: await this.validation.detectValidationCommands(root, filesChanged),
      ctx,
      loop,
      loopOptions,
      subagentRunner,
      delegationReport,
      loopSummary: tightenedGateSummary,
      emit,
      emitRuntime,
      signal,
    });
  }

  /**
   * Validation + repair + supervisor phase. Extracted from finishCode so it can be invoked both
   * inline and (now) by the resume endpoint after the user confirms the pre-validation diff gate.
   */
  private async runValidationPhase(params: {
    projectName: string;
    root: string;
    prompt: string;
    runId: string;
    todos: string[];
    validationCommands: TerminalCommand[];
    ctx: CodeAgentContext;
    loop: CodeAgentLoop;
    loopOptions: CodeAgentLoopOptions;
    subagentRunner: SubagentRunner;
    delegationReport?: DelegationReport;
    loopSummary?: string;
    emit: AgentRuntimeEmit;
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>;
    signal?: AbortSignal;
  }): Promise<void> {
    const { projectName, root, prompt, runId, todos, validationCommands, ctx, loop, loopOptions, subagentRunner, emit, emitRuntime, signal } = params;
    const store = getCodeSpaceStore();
    const persistCheckpoint = async (checkpoint: FileCheckpoint) => {
      await store.upsert('checkpoints', {
        id: checkpoint.id,
        projectId: checkpoint.projectId,
        runId: checkpoint.runId,
        reason: checkpoint.reason,
        snapshotRef: checkpoint.snapshotRef,
        createdAt: checkpoint.createdAt,
      });
    };

    await emitRuntime('plan.updated', { phase: 'validating' });
    await this.coworking.transition(runId, 'validating', 'Validation and supervisor reconciliation are running.');
    await emitRuntime('coworking.phase.changed', { runId, phase: 'validating' });
    const verifier = new IntegrationVerifier(this.validation, subagentRunner);

    // Step 1: review the cumulative diff for integration coherence.
    const coherence = await verifier.reviewDiffCoherence(ctx);
    emit({ type: 'integration_review', findings: coherence.findings });
    await emitRuntime('integration.reviewed', { findings: coherence.findings });

    // Step 2: run validation progressively (syntax → typecheck → lint → test → e2e → build).
    let validationRuns = await this.runAndEmitValidation(root, runId, progressiveOrder(validationCommands), signal, emit, emitRuntime, ctx);

    // Step 3: generate + run focused test scripts via a test-writer subagent (in .agent/tests/<runId>/).
    const testScripts = await verifier.generateAndRunTestScripts(ctx, runId, prompt);

    if (this.repairLoop.shouldRepair(validationRuns) && ctx.ledger.size) {
      await emitRuntime('plan.updated', { phase: 'repairing' });
      const repair = await this.repairLoop.run({
        loop,
        ctx,
        loopOptions,
        initialResults: validationRuns,
        runValidation: () => verifier.progressiveValidate(root, runId, validationCommands, signal),
        emit,
        emitRuntime,
        runId,
        maxAttempts: ctx.scaleProfile ? runtimeScaleLimits(ctx.scaleProfile, 'code').maxRepairAttempts : undefined,
        repeatedFailureLimit: ctx.scaleProfile ? runtimeScaleLimits(ctx.scaleProfile, 'code').repeatedFailureLimit : undefined,
      });
      validationRuns = repair.results;
    }

    // Re-review coherence after any repair edits shifted the diff.
    const finalCoherence = await verifier.reviewDiffCoherence(ctx);

    const revertCheckpoint = await createRunRevertCheckpoint(ctx);
    if (revertCheckpoint) await persistCheckpoint(revertCheckpoint);

    const filesChanged = Array.from(ctx.ledger.keys());
    const completionHooks = new HookRunner().runAll(ctx, filesChanged, validationRuns, [
      ...finalCoherence.findings.map((finding) => `${finding.path}: ${finding.message}`),
    ]);
    const blockedHookSummaries = completionHooks
      .filter((hook) => hook.status === 'blocked')
      .map((hook) => hook.summary)
      .filter((summary) => summary !== 'Unresolved edit failures remain.');
    for (const hook of completionHooks) {
      ctx.contextLedger?.add({
        kind: 'decision',
        summary: `${hook.hook}: ${hook.summary}`,
        status: hook.status === 'passed' ? 'passed' : hook.status === 'blocked' ? 'failed' : 'skipped',
      });
      await emitRuntime('coworking.hook.completed', hook);
    }
    if (ctx.contextLedger) {
      await this.coworking.persistLedger(runId, ctx.contextLedger);
      await emitRuntime('coworking.ledger.persisted', { runId, entries: ctx.contextLedger.list().length });
    }

    // Supervisor reconciles every gate before confirmation — verified only when all pass.
    const verdict = new Supervisor().reconcile({
      ledgerSize: ctx.ledger.size,
      coherence: finalCoherence.findings,
      validationRuns,
      unresolvedEditFailures: [formatUnresolvedEditFailures(ctx), ...blockedHookSummaries].filter(Boolean).join('\n'),
      subagentResults: [...(params.delegationReport?.results ?? []), ...(testScripts.result ? [testScripts.result] : [])],
      delegationRequired: params.delegationReport?.plan.required,
      delegationReconciled: params.delegationReport ? params.delegationReport.reconciled : true,
      implementationContract: ctx.implementationContract,
      browserEvidenceRequired: requiresBrowserEvidence(prompt, filesChanged),
      browserEvidenceCount: ctx.contextLedger?.list('browser').length ?? 0,
    });
    emit({ type: 'supervisor_verdict', status: verdict.status, blockers: verdict.blockers });
    await emitRuntime('supervisor.verdict', { status: verdict.status, blockers: verdict.blockers });

    const terminalPhase = verdict.status === 'verified' ? 'verified' : 'needs_review';
    todos.forEach((_, index) => emit({ type: 'todo_updated', todoId: `todo:${runId}:${index}`, done: verdict.status === 'verified' || index < 3 }));

    const answer = [
      buildCodeFinalResponse({
        projectName,
        files: filesChanged.map((filePath) => ({ path: filePath, explanation: ctx.ledger.get(filePath)?.deleted ? 'Removed.' : 'Edited.' })),
        validationRuns,
        summary: params.loopSummary ?? '',
        checkpointRef: revertCheckpoint?.id,
      }),
      verdict.status === 'needs_review' && verdict.blockers.length ? `Supervisor verdict: needs_review — ${verdict.blockers.join(' ')}` : '',
      testScripts.scripts.length ? `Generated ${testScripts.scripts.length} test script(s) under ${testScripts.folder}.` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    await this.coworking.transition(
      runId,
      verdict.status === 'verified' ? 'complete' : 'syncing',
      verdict.status === 'verified' ? 'Supervisor verified all completion gates.' : 'Supervisor requires user review before completion.',
      verdict.blockers,
    );
    await emitRuntime('coworking.phase.changed', {
      runId,
      phase: verdict.status === 'verified' ? 'complete' : 'syncing',
      blockers: verdict.blockers,
    });
    await streamAnswer(answer, emit, emitRuntime);
    await emitRuntime('run.completed', { status: terminalPhase, phase: terminalPhase, filesChanged, checkpointId: revertCheckpoint?.id });
    emit({ type: 'agent_done', summary: answer, filesChanged });
  }

  /**
   * Resume a code run after the user confirms (or cancels) the pre-validation diff gate.
   * On confirm: reconstructs a minimal code context (ledger from the persisted snapshot +
   * current disk content) and runs the validation/repair/supervisor phase. On cancel: reverts
   * every applied change. Provider credentials come from the resume request, not from disk.
   */
  async resumeValidation(request: ResumeValidationRequest, emit: AgentRuntimeEmit, signal?: AbortSignal): Promise<void> {
    const guarded = guardPath(request.projectRoot);
    if (!guarded.ok) throw new Error(guarded.reason ?? 'Invalid project root');
    const root = guarded.resolved;
    const record = await loadPendingValidation(request.runId);
    if (!record || record.projectRoot !== root) {
      throw new Error('No pending diff confirmation was found for this run. It may have expired or already been processed.');
    }
    const runId = record.runId;
    const projectId = request.projectName || record.projectName;
    const emitRuntime = async (type: AgentEventType, payload: unknown) => {
      const event = await this.events.append(createAgentEvent({ type, projectId, sessionId: record.sessionId, runId, payload }));
      await emit({ type: 'structured_event', event });
    };

    await emitRuntime('run.created', { mode: 'code', resumed: true, decision: request.decision });

    if (request.decision === 'cancel') {
      await this.revertPendingChanges(record, emit, emitRuntime);
      await removePendingValidation(runId);
      const answer = `Reverted ${record.files.length} change(s). Validation was not run.`;
      await streamAnswer(answer, emit, emitRuntime);
      await emitRuntime('run.completed', { status: 'cancelled', phase: 'cancelled', filesChanged: [] });
      emit({ type: 'agent_done', summary: answer, filesChanged: [] });
      return;
    }

    const credentials = await resolveProviderCredentials(root, {
      providerId: request.providerId,
      apiKey: request.apiKey,
      endpoint: request.endpoint,
    } as AgentRuntimeRequest);
    if (!credentials.apiKey && request.providerId !== 'local') {
      throw new Error(`The "${request.providerId}" provider is not configured; cannot run validation/repair.`);
    }

    const validationCommands = await this.validation.detectValidationCommands(root);
    const context = await this.context.collectProjectContext(root, record.prompt, { mode: 'code', openTabs: [], attachments: [], limitHint: 50 });
    const sufficiency = assessContextSufficiency({ mode: 'code', prompt: record.prompt, context, validationCommands });

    const store = getCodeSpaceStore();
    const persistCheckpoint = async (checkpoint: FileCheckpoint) => {
      await store.upsert('checkpoints', {
        id: checkpoint.id,
        projectId: checkpoint.projectId,
        runId: checkpoint.runId,
        reason: checkpoint.reason,
        snapshotRef: checkpoint.snapshotRef,
        createdAt: checkpoint.createdAt,
      });
    };

    const ctx: CodeAgentContext = {
      root,
      runId,
      projectId,
      sessionId: record.sessionId,
      autonomy: 'auto_safe_tools',
      emit,
      emitRuntime,
      ledger: new Map<string, LedgerEntry>(),
      patchHistory: [],
      implementationContract: createImplementationContract(record.prompt, await readPlanMarkdown(root, extractBuildPlanPath(record.prompt))),
      proposedFiles: new Set<string>(),
      proposedLedger: new Map(),
      editFailures: new Map(),
      readFiles: new Set(context.files.map((file) => file.path)),
      artifacts: new Map(),
      checkpoints: [],
      contextLedger: new ContextLedger(runId, normalizeRuntimeScaleProfile(request.toolBudget >= 600 ? 'massive' : 'deep', 'code')),
      scaleProfile: normalizeRuntimeScaleProfile(request.toolBudget >= 600 ? 'massive' : 'deep', 'code'),
      browser: new BrowserController(),
      registry: createDefaultToolRegistry(),
      permission: new PermissionManager(),
      terminal: new TerminalRunner(),
      onCheckpoint: persistCheckpoint,
      signal,
    };
    emit({ type: 'coverage_updated', contract: ctx.implementationContract! });

    // Rebuild the ledger from the persisted snapshot, refreshing afterContent from disk so the
    // coherence/syntax review reflects exactly what is on disk right now.
    for (const file of record.files) {
      let after = file.afterContent;
      try {
        after = await fs.readFile(path.join(root, file.path), 'utf8');
      } catch {
        if (file.deleted) after = '';
      }
      ctx.ledger.set(file.path, { beforeContent: file.beforeContent, afterContent: after, deleted: file.deleted, existedBefore: file.existedBefore });
    }

    const budget = new ToolBudget(request.toolBudget, resolveMaxTurns(request.toolBudget));
    const session: ProviderSession = { id: request.providerId, model: request.model, endpoint: credentials.endpoint, apiKey: credentials.apiKey || 'local' };
    const loopOptions: CodeAgentLoopOptions = { session, budget, signal };
    const subagentRunner = new SubagentRunner(ctx, session, projectId);
    ctx.spawnSubagent = (subRequest) => subagentRunner.spawn(subRequest);

    const loop = new CodeAgentLoop(new ToolExecutor(ctx.registry, ctx.permission));
    loop.seed(
      buildCodeSystemPrompt(projectId, record.instructionPaths),
      await buildCodeSeedMessage(root, record.prompt, context, validationCommands.map((command) => ({ command: command.command, args: command.args, reason: command.reason })), sufficiency, request.model),
    );

    const todos = this.planning.buildTodos('code', context);
    await this.runValidationPhase({ projectName: projectId, root, prompt: record.prompt, runId, todos, validationCommands, ctx, loop, loopOptions, subagentRunner, emit, emitRuntime, signal });
    await removePendingValidation(runId);
  }

  /** Restore every file captured in a pending-validation record to its pre-run content. */
  private async revertPendingChanges(
    record: PendingValidationRecord,
    emit: AgentRuntimeEmit,
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
  ): Promise<void> {
    for (const file of record.files) {
      const absolute = path.join(record.projectRoot, file.path);
      try {
        if (file.existedBefore) {
          await fs.mkdir(path.dirname(absolute), { recursive: true });
          await fs.writeFile(absolute, file.beforeContent, 'utf8');
        } else {
          await fs.rm(absolute, { force: true });
        }
        await emitRuntime('file.reverted', { path: file.path });
      } catch (error) {
        await emitRuntime('file.revert.failed', { path: file.path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    void emit;
  }

  private async runAndEmitValidation(
    root: string,
    runId: string,
    validationCommands: TerminalCommand[],
    signal: AbortSignal | undefined,
    emit: AgentRuntimeEmit,
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
    ctx?: CodeAgentContext,
  ): Promise<ValidationRunResult[]> {
    const validationRuns = await this.validation.runValidationCommands(root, runId, validationCommands, signal, {
      onStart: async (command) => {
        const display = [command.command, ...command.args].join(' ');
        emit({
          type: 'agent_status',
          status: {
            id: `status:${runId}:validation:${command.kind}`,
            title: `Running ${command.kind}`,
            detail: display,
            phase: 'validating',
            status: 'running',
            createdAt: Date.now(),
          },
        });
        await emitRuntime('validation.started', { command: display, kind: command.kind });
      },
      onChunk: async (chunk) => {
        emit({ type: 'terminal_chunk', chunk: chunk.chunk, stream: chunk.stream, command: chunk.command });
        await emitRuntime('terminal.output', { command: chunk.command, stream: chunk.stream, chunk: chunk.chunk });
      },
    });
    for (const result of validationRuns) {
      if (ctx) {
        ctx.implementationContract = addValidationCoverage(ctx.implementationContract, result);
        if (result.artifact) ctx.contextLedger?.addArtifact('validation', result.artifact, `${result.command}: ${result.status}`);
        if (ctx.implementationContract) emit({ type: 'coverage_updated', contract: ctx.implementationContract });
      }
      emit({
        type: 'validation_result',
        id: `validation:${runId}:${result.kind}`,
        command: result.command,
        status: result.status,
        output: result.output,
        durationMs: result.durationMs,
        artifactId: result.artifact?.artifactId,
      });
      await emitRuntime(result.status === 'failed' ? 'validation.failed' : 'validation.completed', { command: result.command, status: result.status, artifact: result.artifact });
    }
    return validationRuns;
  }
}

async function emitTool<T>(
  emit: AgentRuntimeEmit,
  emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
  tool: string,
  input: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const toolCallId = `tool:${Date.now()}:${tool}:${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  emit({ type: 'tool_start', toolCallId, tool, input });
  await emitRuntime('tool.started', { tool, input });
  try {
    const output = await run();
    emit({ type: 'tool_result', toolCallId, tool, output, durationMs: Date.now() - startedAt });
    await emitRuntime('tool.completed', { tool, output });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'tool_result', toolCallId, tool, output: null, durationMs: Date.now() - startedAt, error: message });
    await emitRuntime('tool.failed', { tool, message });
    throw error;
  }
}

async function streamAnswer(answer: string, emit: AgentRuntimeEmit, emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>) {
  for (const chunk of chunkText(answer)) {
    emit({ type: 'text_delta', delta: chunk });
    await emitRuntime('message.assistant.delta', { text: chunk });
  }
  await emitRuntime('message.assistant.completed', { content: answer });
}

function describeModeContract(mode: CodeSpaceAgentMode): string {
  if (mode === 'ask') return 'Ask mode is read-only: inspect, trace, and answer without patches or checkpoints.';
  if (mode === 'plan') return 'Plan mode is read-only except for .agent/plans artifacts; it must score context sufficiency and produce an implementation-grade artifact before Build.';
  return 'Code mode must read before edit, recall missing evidence autonomously, apply or propose concrete diffs, checkpoint through the unified apply path, validate honestly, and never claim implementation success with zero changed files.';
}

function requiresBrowserEvidence(prompt: string, filesChanged: string[]): boolean {
  const haystack = `${prompt}\n${filesChanged.join('\n')}`;
  return /\b(ui|ux|browser|preview|layout|responsive|click|scroll|screenshot|website|web app|frontend|css|tsx|jsx|page|component)\b/i.test(haystack);
}

async function resolveProviderCredentials(root: string, request: AgentRuntimeRequest): Promise<{ apiKey: string; endpoint?: string }> {
  const endpoint = request.endpoint ?? process.env.OPENAI_BASE_URL;
  if (request.apiKey) return { apiKey: request.apiKey, endpoint };
  const keyName = (prefix: string) => `${prefix}_${'KEY'}`;
  const keys =
    request.providerId === 'anthropic'
      ? [keyName('ANTHROPIC_API'), keyName('CLAUDE_API')]
      : request.providerId === 'gemini'
        ? [keyName('GOOGLE_GENERATIVE_AI_API'), keyName('GEMINI_API'), keyName('GOOGLE_API')]
        : request.providerId === 'grok'
          ? [keyName('XAI_API'), keyName('GROK_API')]
          : request.providerId === 'foundry'
            ? [keyName('FOUNDRY_API'), keyName('AZURE_OPENAI_API'), keyName('AZURE_AI_FOUNDRY_API')]
            : request.providerId === 'mistral'
              ? [keyName('MISTRAL_API')]
              : request.providerId === 'deepseek'
                ? [keyName('DEEPSEEK_API')]
                : request.providerId === 'nvidia'
                  ? [keyName('NVIDIA_API')]
                  : request.providerId === 'openrouter'
                    ? [keyName('OPENROUTER_API')]
                    : [keyName('OPENAI_API')];
  const env = await loadWorkspaceEnv(root);
  return { apiKey: keys.map((key) => env[key] ?? process.env[key]).find(Boolean) ?? '', endpoint };
}

async function loadWorkspaceEnv(root: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const file of ['.env.local', '.env', '.env.development.local', '.env.development']) {
    try {
      Object.assign(env, parseEnv(await fs.readFile(path.join(root, file), 'utf8')));
    } catch {}
  }
  return env;
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key) env[key] = value;
  }
  return env;
}

function findOriginalPlanPrompt(messages: AgentRuntimeRequest['messages'], fallback: string): string {
  return messages.find((message) => message.role === 'user' && !message.content.startsWith('Plan clarification answers:'))?.content ?? fallback;
}

async function readPlanMarkdown(root: string, buildPlanPath?: string | null): Promise<string> {
  if (!buildPlanPath) return '';
  try {
    return await fs.readFile(path.join(root, buildPlanPath), 'utf8');
  } catch {
    return '';
  }
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 220) chunks.push(text.slice(index, index + 220));
  return chunks;
}

/**
 * Hard cap on model round-trips. Read-only exploration is free against the mutation
 * budget, so the turn cap (higher than the mutation budget) is what ultimately stops a
 * runaway loop while still leaving generous room to read and search.
 */
function resolveMaxTurns(toolBudget: number): number {
  return Math.max(20, Math.min(160, Math.floor(Math.max(1, toolBudget) * 2) + 20));
}

/**
 * Build the full aggregated diff of every applied change for the pre-validation gate.
 * Prefers the real `git diff` when the repo is git-connected, and always appends a
 * ledger-derived unified diff for files git omits (e.g. newly created untracked files),
 * so the user reviews a complete picture. Falls back entirely to the change ledger when
 * there is no git repository.
 */
interface DiffLedgerEntry {
  path: string;
  beforeContent: string;
  afterContent: string;
  deleted: boolean;
}

async function buildAggregatedDiff(
  root: string,
  entries: DiffLedgerEntry[],
): Promise<{ isGit: boolean; unifiedDiff: string; files: Array<{ path: string; deleted: boolean; unifiedDiff: string }> }> {
  const files = entries.map((entry) => ({
    path: entry.path,
    deleted: entry.deleted,
    unifiedDiff: createUnifiedDiff(entry.path, entry.beforeContent, entry.deleted ? '' : entry.afterContent),
  }));

  const git = await new GitManager().diff(root);
  if (!git.unavailable) {
    const combined = [git.stagedDiff, git.diff].filter(Boolean).join('\n');
    const missing = files.filter((file) => file.unifiedDiff && !combined.includes(file.path)).map((file) => file.unifiedDiff);
    const aggregate = [combined, ...missing].filter(Boolean).join('\n');
    if (aggregate.trim()) return { isGit: true, unifiedDiff: aggregate, files };
  }

  const ledgerDiff = files.map((file) => file.unifiedDiff).filter(Boolean).join('\n');
  return { isGit: false, unifiedDiff: ledgerDiff, files };
}

export function runtimeSourceFingerprintForTests(): string {
  return createHash('sha256').update('AgentRuntime').digest('hex');
}

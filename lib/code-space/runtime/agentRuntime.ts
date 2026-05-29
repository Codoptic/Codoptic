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
import { buildAskFinalResponse, buildCodeFinalResponse, buildCodeProposalResponse, buildPlanFinalResponse } from './responsePolicy';
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
import { assessContextSufficiency, buildRecallDirective, type ContextSufficiencyReport } from './workflowPolicy';

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
  providerId: z.enum(['anthropic', 'openai', 'gemini', 'grok', 'foundry', 'local']).optional().default('openai'),
  apiKey: z.string().optional().default(''),
  endpoint: z.string().optional(),
  openTabs: z.array(z.string()).default([]),
  mode: z.enum(['ask', 'plan', 'code']).optional().default('code'),
  toolBudget: z.number().default(50),
  autonomy: AutonomyLevelSchema.optional().default('auto_safe_tools'),
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

    await emitRuntime('run.created', { mode, toolBudget: request.toolBudget });
    await emitRuntime('run.started', { projectName: request.projectName });

    try {
      await setPhase('classifying');
      const intents = classifyCodeSpaceIntent(prompt);
      await emitTool(emit, emitRuntime, 'classify_task', { mode, intents }, async () => ({ mode, intents, contract: describeModeContract(mode) }));

      await setPhase('loading_project_rules');
      const loadedInstructions = await emitTool(emit, emitRuntime, 'load_project_rules', { buildPlanPath }, async () =>
        this.instructions.loadProjectInstructions(root, buildPlanPath),
      );

      await setPhase('mapping_repository');
      await setPhase('gathering_context');
      const context = await emitTool(emit, emitRuntime, 'context_graph', { openTabs: request.openTabs, attachments: request.attachments, mode }, async () =>
        this.context.collectProjectContext(root, prompt, {
          mode,
          openTabs: request.openTabs,
          attachments: request.attachments as ContextAttachment[],
          buildPlanPath,
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
        await this.finishPlan(request, root, prompt, context, validationCommands, emit, emitRuntime, runId, todos, loadedInstructions, sufficiency, signal);
        return;
      }
      await this.finishCode(request, root, prompt, context, validationCommands, emit, emitRuntime, runId, todos, loadedInstructions, sufficiency, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setPhase('failed', { message });
      await emitRuntime('run.failed', { message });
      await emit({ type: 'agent_error', message, recoverable: true });
    }
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
      .find((message) => message.role === 'user' && message.content.startsWith('Plan clarification answers:'))?.content;

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
      `Note: this plan was auto-synthesized from the gathered evidence because the model did not finalize one itself. Context gate: ${sufficiency.status} (${sufficiency.score}/100). Review it before building.`,
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
      proposedFiles: new Set<string>(),
      proposedLedger: new Map(),
      editFailures: new Map(),
      readFiles: new Set(context.files.map((file) => file.path)),
      artifacts: new Map(),
      checkpoints: [],
      registry: createDefaultToolRegistry(),
      permission: new PermissionManager(),
      terminal: new TerminalRunner(),
      onCheckpoint: persistCheckpoint,
      signal,
    };

    const budget = new ToolBudget(request.toolBudget, resolveMaxTurns(request.toolBudget));
    const session: ProviderSession = { id: request.providerId, model: request.model, endpoint: credentials.endpoint, apiKey: credentials.apiKey || 'local' };
    const loopOptions: CodeAgentLoopOptions = { session, budget, signal };

    const subagentRunner = new SubagentRunner(ctx, session, request.projectName);
    ctx.spawnSubagent = (subRequest) => subagentRunner.spawn(subRequest);

    const loop = new CodeAgentLoop(new ToolExecutor(ctx.registry, ctx.permission));
    loop.seed(
      buildCodeSystemPrompt(request.projectName, loadedInstructions.map((item) => item.path)),
      await buildCodeSeedMessage(root, prompt, context, validationCommands.map((command) => ({ command: command.command, args: command.args, reason: command.reason })), sufficiency),
    );

    let loopResult = await loop.run(ctx, loopOptions);

    const MAX_CONTEXT_RECALL_ESCALATIONS = 2;
    for (let attempt = 0; attempt < MAX_CONTEXT_RECALL_ESCALATIONS; attempt += 1) {
      if (ledger.size > 0 || ctx.proposedFiles.size > 0 || sufficiency.status === 'ready') break;
      if (loopOptions.budget.turnsExhausted()) break;
      loopResult = await loop.continueWith(buildRecallDirective(sufficiency), ctx, loopOptions);
    }

    // Motivation vs Logic: models surrender after recoverable edit_file diagnostics. Escalate back into
    // the live thread when nothing was applied/proposed but unresolved edit failures remain.
    const MAX_EDIT_ESCALATIONS = 3;
    for (let attempt = 0; attempt < MAX_EDIT_ESCALATIONS; attempt += 1) {
      if (loopResult.success !== false) break;
      if (ledger.size > 0 || ctx.proposedFiles.size > 0) break;
      if (ctx.editFailures.size === 0) break;
      if (loopOptions.budget.turnsExhausted() || loopOptions.budget.mutationBudgetExhausted()) break;
      loopResult = await loop.continueWith(buildEditEscalationDirective(ctx), ctx, loopOptions);
    }

    // Confirm mode (suggest_only): the loop proposed diffs but wrote nothing. Surface them for
    // accept/reject instead of validating/fixing unchanged code or reporting an autonomy failure.
    if (ledger.size === 0 && ctx.proposedFiles.size > 0) {
      const proposed = Array.from(ctx.proposedFiles);
      await emitRuntime('plan.updated', { phase: 'awaiting_patch_review' });
      const proposalAnswer = buildCodeProposalResponse(request.projectName, proposed, loopResult.summary);
      await streamAnswer(proposalAnswer, emit, emitRuntime);
      await emitRuntime('run.completed', { status: 'awaiting_review', phase: 'awaiting_patch_review', filesChanged: proposed });
      emit({ type: 'agent_done', summary: proposalAnswer, filesChanged: proposed });
      return;
    }

    if (ledger.size === 0) {
      const answer = [
        loopResult.summary || 'Code mode ended without applying a patch.',
        '',
        'No files were changed. The run is marked needs_review because v3.2 requires concrete file changes for implementation tasks or an exact blocker after context recall.',
        `Context gate: ${sufficiency.status} (${sufficiency.score}/100).`,
        sufficiency.blockers.length ? `Blockers: ${sufficiency.blockers.join('; ')}` : '',
        sufficiency.warnings.length ? `Warnings: ${sufficiency.warnings.join('; ')}` : '',
      ].filter(Boolean).join('\n');
      await streamAnswer(answer, emit, emitRuntime);
      await emitRuntime('run.completed', { status: 'needs_review', phase: 'needs_review', filesChanged: [] });
      emit({ type: 'validation_result', id: `validation:${runId}:no_changes`, command: 'v3.2 implementation gate', status: 'failed', output: 'Code mode produced no applied files after recall/repair gates.' });
      emit({ type: 'agent_done', summary: answer, filesChanged: [] });
      return;
    }

    await emitRuntime('plan.updated', { phase: 'awaiting_patch_review' });

    const verifier = new IntegrationVerifier(this.validation, subagentRunner);

    // Validation/testing agent — step 1: review the cumulative diff for integration coherence.
    const coherence = await verifier.reviewDiffCoherence(ctx);
    emit({ type: 'integration_review', findings: coherence.findings });
    await emitRuntime('integration.reviewed', { findings: coherence.findings });

    // Step 2: run validation progressively (syntax → typecheck → lint → test → e2e → build).
    let validationRuns = await this.runAndEmitValidation(root, runId, progressiveOrder(validationCommands), signal, emit, emitRuntime);

    // Step 3: generate + run focused test scripts via a test-writer subagent (in .agent/tests/<runId>/).
    const testScripts = await verifier.generateAndRunTestScripts(ctx, runId, prompt);

    if (this.repairLoop.shouldRepair(validationRuns) && ledger.size) {
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
      });
      validationRuns = repair.results;
    }

    // Re-review coherence after any repair edits shifted the diff.
    const finalCoherence = await verifier.reviewDiffCoherence(ctx);

    const revertCheckpoint = await createRunRevertCheckpoint(ctx);
    if (revertCheckpoint) await persistCheckpoint(revertCheckpoint);

    const filesChanged = Array.from(ledger.keys());

    // Supervisor reconciles every gate before confirmation — verified only when all pass.
    const verdict = new Supervisor().reconcile({
      ledgerSize: ledger.size,
      coherence: finalCoherence.findings,
      validationRuns,
      unresolvedEditFailures: formatUnresolvedEditFailures(ctx),
      subagentResults: testScripts.result ? [testScripts.result] : [],
    });
    emit({ type: 'supervisor_verdict', status: verdict.status, blockers: verdict.blockers });
    await emitRuntime('supervisor.verdict', { status: verdict.status, blockers: verdict.blockers });

    const terminalPhase = verdict.status === 'verified' ? 'verified' : 'needs_review';
    todos.forEach((_, index) => emit({ type: 'todo_updated', todoId: `todo:${runId}:${index}`, done: verdict.status === 'verified' || index < 3 }));

    const answer = [
      buildCodeFinalResponse({
        projectName: request.projectName,
        files: filesChanged.map((filePath) => ({ path: filePath, explanation: ledger.get(filePath)?.deleted ? 'Removed.' : 'Edited.' })),
        validationRuns,
        summary: loopResult.summary,
        checkpointRef: revertCheckpoint?.id,
      }),
      verdict.status === 'needs_review' && verdict.blockers.length ? `Supervisor verdict: needs_review — ${verdict.blockers.join(' ')}` : '',
      testScripts.scripts.length ? `Generated ${testScripts.scripts.length} test script(s) under ${testScripts.folder}.` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    await streamAnswer(answer, emit, emitRuntime);
    await emitRuntime('run.completed', { status: terminalPhase, phase: terminalPhase, filesChanged, checkpointId: revertCheckpoint?.id });
    emit({ type: 'agent_done', summary: answer, filesChanged });
  }

  private async runAndEmitValidation(
    root: string,
    runId: string,
    validationCommands: TerminalCommand[],
    signal: AbortSignal | undefined,
    emit: AgentRuntimeEmit,
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
  ): Promise<ValidationRunResult[]> {
    const validationRuns = await this.validation.runValidationCommands(root, runId, validationCommands, signal);
    for (const result of validationRuns) {
      emit({ type: 'validation_result', id: `validation:${runId}:${result.kind}`, command: result.command, status: result.status, output: result.output });
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

export function runtimeSourceFingerprintForTests(): string {
  return createHash('sha256').update('AgentRuntime').digest('hex');
}

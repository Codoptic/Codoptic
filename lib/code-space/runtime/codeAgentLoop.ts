import type { AssistantTurn, ChatMessage, ProviderSession, ToolSpec } from '@/lib/agent/providers';
import { chatTurnWithToolsStream } from '@/lib/agent/providers';
import type { ContextGraphResult } from './contextGraphEngine';
import { listRepositoryFiles } from './repoMap';
import { ToolBudget, isReadOnlyTool } from './toolBudget';
import { validateSyntaxLightweight } from '@/lib/code-space/agent/editBlocks';
import {
  CODE_MODE_TOOL_SPECS,
  ToolExecutor,
  formatUnresolvedEditFailures,
  type CodeAgentContext,
  type RecoverableToolFailure,
  type ToolExecutionResult,
} from './toolExecutor';
import {
  buildWorkflowKernelPrompt,
  formatContextSufficiencyMarkdown,
  formatWorkflowDodMarkdown,
  type ContextSufficiencyReport,
} from './workflowPolicy';
import { allocateContextBudget, compressMessageHistory, formatEvidenceBody, isReduciblePromptError, skeletonizeFileContent } from './contextWindowManager';
import { formatMemoryContext, type MemoryContext } from './memoryManager';
import { formatDelegationReport, type DelegationReport } from './delegationPlanner';

export interface CodeAgentLoopResult {
  /** attempt_completion was called (the model declared the task done). */
  completed: boolean;
  /** attempt_completion success flag; false on dead-ends or forced stops. */
  success: boolean;
  /** Final summary text the model produced (or a forced-stop reason). */
  summary: string;
  stopReason: 'completed' | 'provider_end' | 'turns_exhausted' | 'aborted';
}

export interface CodeAgentLoopOptions {
  session: ProviderSession;
  budget: ToolBudget;
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * The agentic Code-mode loop. Holds a single conversation thread that the model
 * drives with native tool calls (read → search → edit → run → fix). Read-only
 * exploration is free; only mutating tools spend the budget. The same instance is
 * reused by the repair loop so failures feed back into the live thread.
 */
export class CodeAgentLoop {
  readonly messages: ChatMessage[] = [];
  private budgetWarned = false;
  private contextPruneCount = 0;

  constructor(private readonly executor: ToolExecutor = new ToolExecutor()) {}

  /** Seed the thread with the system contract and the task brief. */
  seed(systemPrompt: string, userPrompt: string): void {
    this.messages.length = 0;
    this.contextPruneCount = 0;
    this.messages.push({ role: 'system', content: systemPrompt });
    this.messages.push({ role: 'user', content: userPrompt });
  }

  /** Run the loop from the current thread state until the model is quiescent. */
  async run(ctx: CodeAgentContext, opts: CodeAgentLoopOptions): Promise<CodeAgentLoopResult> {
    return this.continueUntilQuiescent(ctx, opts);
  }

  /** Inject feedback (e.g. validation failures) and continue the live thread. */
  async continueWith(feedback: string, ctx: CodeAgentContext, opts: CodeAgentLoopOptions): Promise<CodeAgentLoopResult> {
    this.messages.push({ role: 'user', content: feedback });
    return this.continueUntilQuiescent(ctx, opts);
  }

  /**
   * Skeletonizes evidence files embedded in the initial seed user message.
   * Used on the first reducible-prompt retry to strip implementation bodies.
   */
  private skeletonizeSeedEvidence(): void {
    const seed = this.messages.find((m) => m.role === 'user');
    if (!seed) return;
    seed.content = seed.content.replace(
      /--- FILE ([^\s]+) \([^)]+\) ---\n([\s\S]*?)(?=\n--- FILE |\nRepository file index|$)/g,
      (_match, filePath: string, body: string) => {
        const skeletonized = skeletonizeFileContent(filePath, body);
        return `--- FILE ${filePath} (skeletonized) ---\n${skeletonized}`;
      },
    );
  }

  /**
   * Strips all evidence file blocks from the seed user message.
   * Last-resort fallback after skeletonization still triggers a content filter.
   */
  private stripSeedEvidence(): void {
    const seed = this.messages.find((m) => m.role === 'user');
    if (!seed) return;
    seed.content = seed.content.replace(
      /Initial evidence already gathered for you[\s\S]*$/,
      'Initial evidence: stripped due to provider content limit — use read_file to load files on demand.',
    );
  }

  private async continueUntilQuiescent(ctx: CodeAgentContext, opts: CodeAgentLoopOptions): Promise<CodeAgentLoopResult> {
    const tools = opts.tools ?? CODE_MODE_TOOL_SPECS;

    while (true) {
      if (opts.signal?.aborted) return { completed: false, success: false, summary: 'Run aborted.', stopReason: 'aborted' };
      if (opts.budget.turnsExhausted()) {
        return { completed: false, success: false, summary: 'Reached the maximum number of agent turns before completing the task.', stopReason: 'turns_exhausted' };
      }

      if (opts.budget.nearExhaustion() && !this.budgetWarned) {
        this.budgetWarned = true;
        await ctx.emit({ type: 'tool_budget_warning', used: opts.budget.mutationsUsed, max: opts.budget.max });
        this.messages.push({
          role: 'user',
          content:
            'You are close to the tool budget. Use the evidence already gathered, make only the edits strictly required to finish the task, run validation once, and then call attempt_completion.',
        });
      }

      opts.budget.recordTurn();
      let turn: AssistantTurn;
      try {
        turn = await this.streamTurn(ctx, opts, tools);
      } catch (err) {
        if (isReduciblePromptError(err) && this.contextPruneCount < 2) {
          this.contextPruneCount++;
          if (this.contextPruneCount === 1) {
            // First retry: skeletonize evidence files + compress old tool results.
            compressMessageHistory(this.messages);
            this.skeletonizeSeedEvidence();
          } else {
            // Second retry: strip all evidence, agent reads on demand.
            this.stripSeedEvidence();
          }
          opts.budget.recordTurn();
          turn = await this.streamTurn(ctx, opts, tools);
        } else {
          throw err;
        }
      }

      await this.recordAssistantTurn(turn, ctx);

      if (!turn.toolCalls.length) {
        const recoverableFeedback = buildRecoverableFailureDirective(ctx);
        if (recoverableFeedback && !opts.budget.turnsExhausted() && !opts.budget.mutationBudgetExhausted()) {
          this.messages.push({ role: 'user', content: recoverableFeedback });
          continue;
        }
        return {
          completed: false,
          success: turn.stopReason === 'end_turn',
          summary: turn.text || 'The model ended its turn without calling a tool or producing a summary.',
          stopReason: 'provider_end',
        };
      }

      const completion = await this.executeToolCalls(turn, ctx, opts);
      if (completion) return completion;
    }
  }

  private async streamTurn(ctx: CodeAgentContext, opts: CodeAgentLoopOptions, tools: ToolSpec[]): Promise<AssistantTurn> {
    let finalTurn: AssistantTurn | null = null;
    let streamedText = '';
    for await (const event of chatTurnWithToolsStream(opts.session, this.messages, tools, {
          signal: opts.signal,
          toolChoice: 'auto',
          maxTokens: opts.maxTokens,
    })) {
      if (event.type === 'status') {
        await ctx.emit({
          type: 'agent_status',
          status: {
            id: `status:${ctx.runId}:model:${Date.now()}`,
            title: event.message,
            phase: 'model_turn',
            status: 'running',
            createdAt: Date.now(),
          },
        });
      } else if (event.type === 'text_delta') {
        streamedText += event.delta;
        const sentence = latestProgressSentence(streamedText);
        if (sentence) {
          await ctx.emit({
            type: 'agent_status',
            status: {
              id: `status:${ctx.runId}:model:text`,
              title: sentence,
              phase: 'model_turn',
              status: 'running',
              createdAt: Date.now(),
            },
          });
        }
      } else if (event.type === 'tool_call_delta') {
        await ctx.emit({
          type: 'agent_status',
          status: {
            id: `status:${ctx.runId}:tool-draft:${event.toolCallId}`,
            title: event.name ? `Preparing ${event.name}` : 'Preparing tool call',
            detail: event.inputDelta,
            phase: 'model_turn',
            status: 'running',
            createdAt: Date.now(),
          },
        });
      } else if (event.type === 'final') {
        finalTurn = event.turn;
      }
    }
    if (!finalTurn) throw new Error('Provider stream ended without a final assistant turn.');
    return finalTurn;
  }

  private async recordAssistantTurn(turn: AssistantTurn, ctx: CodeAgentContext): Promise<void> {
    this.messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });
    if (turn.text.trim()) {
      await ctx.emit({ type: 'agent_reasoning_delta', delta: turn.text });
    }
  }

  private async executeToolCalls(
    turn: AssistantTurn,
    ctx: CodeAgentContext,
    opts: CodeAgentLoopOptions,
  ): Promise<CodeAgentLoopResult | null> {
    const toolResults: ChatMessage['toolResults'] = [];
    let completion: CodeAgentLoopResult | null = null;
    const tools = opts.tools ?? CODE_MODE_TOOL_SPECS;
    const canMutateSource = tools.some((tool) => ['edit_file', 'apply_patch', 'propose_patch', 'propose_edit_blocks'].includes(tool.name));

    for (const call of turn.toolCalls) {
      if (call.name === 'attempt_completion') {
        const pendingSyntax = ctx.autonomy === 'suggest_only'
          ? Array.from(ctx.proposedLedger.entries()).flatMap(([filePath, entry]) => validateSyntaxLightweight(filePath, entry.afterContent))
          : [];
        if (pendingSyntax.length) {
          const detail = pendingSyntax
            .map((diagnostic) => `- ${diagnostic.path} [${diagnostic.code}]${diagnostic.line ? ` line ${diagnostic.line}` : ''}: ${diagnostic.message}`)
            .join('\n');
          toolResults.push({
            toolCallId: call.id,
            content: `Cannot complete: proposed patches still fail syntax pre-validation. Fix the edits and call edit_file again before attempt_completion:\n${detail}`,
            isError: true,
          });
          continue;
        }

        const recoverableDetail = formatRecoverableToolFailures(ctx);
        if (recoverableDetail && !opts.budget.turnsExhausted() && !opts.budget.mutationBudgetExhausted()) {
          toolResults.push({
            toolCallId: call.id,
            isError: true,
            content: `Cannot complete: a validation or verification command failed and is still recoverable. Replan from the output, edit the smallest affected area if needed, and retry the failed step before attempt_completion:\n${recoverableDetail}`,
          });
          continue;
        }

        const unresolvedDetail = formatUnresolvedEditFailures(ctx);
        if (unresolvedDetail) {
          toolResults.push({
            toolCallId: call.id,
            isError: true,
            content: `Cannot complete: edit_file failed on these files and you have not produced a working edit. Re-read the failing range and issue a corrected edit_file before attempt_completion:\n${unresolvedDetail}`,
          });
          continue;
        }

        const success = call.input?.success !== false;
        const summary = typeof call.input?.summary === 'string' ? call.input.summary : '';
        if (success && canMutateSource && ctx.ledger.size === 0 && ctx.proposedFiles.size === 0) {
          toolResults.push({
            toolCallId: call.id,
            isError: true,
            content:
              'Cannot complete successfully: this is a mutating implementation run but no source edits were applied or proposed. Read the target files, make the required edit_file call, or call attempt_completion with success=false and the exact blocker.',
          });
          continue;
        }
        if (success && canMutateSource && call.input?.completedOriginalRequest !== true) {
          toolResults.push({
            toolCallId: call.id,
            isError: true,
            content:
              'Cannot complete successfully yet: compare the full diff against the original Task and Definition of Done, finish any missing requested work, then call attempt_completion with completedOriginalRequest=true. If anything remains incomplete, use success=false with the exact blocker.',
          });
          continue;
        }
        completion = { completed: true, success, summary: summary || (success ? 'Task completed.' : 'Task could not be completed.'), stopReason: 'completed' };
        toolResults.push({ toolCallId: call.id, content: 'Completion recorded.' });
        continue;
      }

      await ctx.emit({ type: 'tool_start', toolCallId: call.id, tool: call.name, input: call.input });
      await ctx.emitRuntime('tool.started', { tool: call.name, input: call.input });
      const startedAt = Date.now();

      const mutating = !isReadOnlyTool(call.name);
      let result: ToolExecutionResult;
      if (mutating && opts.budget.mutationBudgetExhausted()) {
        result = { content: `Mutation budget exhausted (${opts.budget.mutationsUsed}/${opts.budget.max}). Finish with the current state and exact blockers.`, isError: true };
      } else {
        result = await this.executor.execute(call, ctx);
        if (mutating && !result.isError) opts.budget.charge(call.name);
      }

      updateRecoverableToolFailures(ctx, call.name, result);
      if (result.isError && result.recoverable) {
        const validationLike = Boolean(result.command) || call.name === 'run_validation_matrix' || call.name === 'run_command';
        await ctx.emit({
          type: 'agent_status',
          status: {
            id: `status:${ctx.runId}:recoverable:${call.id}`,
            title: validationLike ? 'Validation failed; replanning automatically' : 'Replanning automatically',
            phase: 'model_turn',
            status: 'warning',
            createdAt: Date.now(),
          },
        });
      }
      await ctx.emit({
        type: 'tool_result',
        toolCallId: call.id,
        tool: call.name,
        output: result.content,
        durationMs: Date.now() - startedAt,
        error: result.isError && !result.recoverable ? result.content : undefined,
        recoverable: result.isError && result.recoverable ? true : undefined,
      });
      await ctx.emitRuntime(result.isError && !result.recoverable ? 'tool.failed' : 'tool.completed', { tool: call.name, recoverable: result.recoverable, command: result.command });
      toolResults.push({ toolCallId: call.id, content: result.content, isError: result.isError });
    }

    this.messages.push({ role: 'tool', content: '', toolResults });
    return completion;
  }
}

function recoverableFailureMap(ctx: CodeAgentContext): Map<string, RecoverableToolFailure> {
  if (!ctx.recoverableFailures) ctx.recoverableFailures = new Map();
  return ctx.recoverableFailures;
}

function updateRecoverableToolFailures(ctx: CodeAgentContext, tool: string, result: ToolExecutionResult): void {
  if (tool === 'edit_file') return;
  const failures = recoverableFailureMap(ctx);
  if (result.isError && result.recoverable) {
    const command = result.command || tool;
    failures.set(command, {
      tool,
      command,
      artifactId: result.artifactId,
      output: result.content,
      at: Date.now(),
    });
    return;
  }

  if (!result.isError && result.command) {
    failures.delete(result.command);
  }
  if (!result.isError && tool === 'edit_file') {
    failures.delete('edit_file');
  }
  if (!result.isError && tool === 'run_validation_matrix') {
    failures.clear();
  }
}

function formatRecoverableToolFailures(ctx: CodeAgentContext): string {
  const failures = Array.from(recoverableFailureMap(ctx).values());
  if (!failures.length) return '';
  return failures
    .slice(-3)
    .map((failure) => {
      const output = failure.output.length > 1600 ? `${failure.output.slice(0, 1600)}\n…[truncated; read full output via read_artifact id=${failure.artifactId ?? 'n/a'}]` : failure.output;
      return [`Command: ${failure.command} → FAILED`, failure.artifactId ? `artifactId: ${failure.artifactId}` : '', 'Output:', output].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

function buildRecoverableFailureDirective(ctx: CodeAgentContext): string {
  const detail = formatRecoverableToolFailures(ctx);
  if (!detail) return '';
  return [
    'The previous tool, validation, or verification step failed, but this is recoverable. Do not answer the user with the raw failure.',
    'Autonomously diagnose the output, read the named files if needed, edit the smallest affected area, and retry the failed step. Only call attempt_completion after the issue is resolved or the tool/turn budget is exhausted.',
    '',
    detail,
  ].join('\n');
}

export function buildCodeSystemPrompt(projectName: string, instructionFiles: string[]): string {
  return [
    buildWorkflowKernelPrompt('code'),
    '',
    `You are Code Space, an autonomous software engineer working in the "${projectName}" repository.`,
    'Operate like a senior engineer pairing in a real editor: investigate first, then make precise edits, then prove they work.',
    '',
    'Workflow you must follow:',
    '1. Understand the task. Read relevant files with read_file and search the repo with search_text before editing.',
    '2. Make focused edits with edit_file using exact SEARCH/REPLACE blocks. If edit_file returns a diagnostic, re-read the failing region, use a smaller SEARCH, and try a corrected edit.',
    '3. Use external helpers only when they materially improve the result: research_web with queries/URLs for current docs and OSS examples, harness_context before large unfamiliar changes, and scan_code_quality for refactors, reviews, duplication, secret, or bug-hunting work.',
    '4. After editing, run project validation with run_validation_matrix first (pass changedPaths when known); use run_command for targeted checks that the matrix does not cover.',
    '5. If validation fails, inspect the output, repair the smallest affected area, and re-run the relevant validation.',
    '6. Before completion, compare the cumulative diff, validation output, and files touched against the original Task and Definition of Done. Finish every requested item, including nearby tests/docs/config updates implied by the request.',
    '7. When the work is done, call attempt_completion with success=true, completedOriginalRequest=true, and a concise summary of what changed.',
    '',
    'Hard rules:',
    '- Do not fabricate results or write markdown notes as a substitute for real code changes.',
    '- Reserve success=false for impossible, contradictory, or blocked tasks with exact evidence.',
    '- Do not call attempt_completion(success=true) after only a partial patch. If any part of the user request is unfinished, keep working or report success=false with the exact blocker.',
    '- Never use attempt_completion to echo raw validation, lint, test, build, or verify output. Treat those failures as repair feedback: inspect the named files, fix the smallest affected area, and re-run the failed command.',
    '- Only edit files that the task requires. Avoid unrelated refactors or speculative abstractions.',
    '- Prefer the smallest change that correctly solves the problem.',
    '- Edits are checkpointed and can be restored if a change makes the result worse.',
    '- The user sees applied diffs, validation results, and your final attempt_completion summary.',
    '',
    // Motivation vs Logic: models often hand back multi-section technical reports ("Summary of intent
    // and actions", "DoD status vs checklist", "Options for you") when they get stuck. That output is
    // confusing for end users. Pin the communication contract here so every Code-mode reply is short
    // and decisive, and so blockers are surfaced via tool calls rather than menu prose.
    'Communication style (the user only sees this — keep it tight):',
    '- attempt_completion.summary MUST be at most 4 short sentences (~240 chars). One paragraph, no markdown headings, no bullet sections.',
    '- Never produce sectioned reports like "Summary of intent and actions", "Evidence inspected", "DoD status vs checklist", "Validation plan", "Next steps / Options for you", "If you want me to proceed".',
    '- Never offer the user a menu ("Option A: retry edit / Option B: repair & edit / Option C: apply manually"). If the next step needs a real human decision, surface it as a single sentence blocker — do not list options.',
    '- Do not narrate tool internals (e.g. "the edit tool rejected the change with a syntax pre-validation error"). Either retry the edit with a smaller SEARCH or report the exact unresolved blocker.',
    '- Lead with what changed (or that nothing matched), then validation status, then the single blocker if any. Skip preambles like "I will now…" / "Let me…".',
    '',
    // Motivation vs Logic: the previous failure mode was the agent searching once for the literal
    // URL, finding zero hits, and then inventing an adjacent normalization task. Pin a regex-first
    // protocol so find-replace work is comprehensive but bounded.
    'Find-and-replace protocol (URLs, hostnames, env keys, identifiers, deprecated symbols):',
    '- Use search_text with a regex (it is case-insensitive). Do not rely on a single literal substring match.',
    '- Try at least three variants before declaring zero matches: the exact literal, a host/path-only fragment (e.g. `binkhoale1812[-_]?medical[-_]?chatbot\\.hf\\.space`), and the most distinctive identifier substring (e.g. `binkhoale1812`).',
    '- For URLs, anchor on the host and accept any scheme/path: `https?://[^/\\s"\\\'\\)]*<host-fragment>`.',
    '- Also search the replacement string. If the replacement already coexists with the old value, the migration may be partially done — note it briefly and proceed with the remaining occurrences.',
    '- If every variant returns zero matches, briefly say "no occurrences of <pattern> found" via attempt_completion and stop. Do NOT invent unrelated normalization, casing fixes, or refactors the user did not request.',
    '- When matches exist, replace every occurrence in a single edit_file batch (one edit per file), then re-run the same regex to confirm the count is zero.',
    instructionFiles.length ? `\nProject instruction files in effect: ${instructionFiles.join(', ')}. Honor their conventions.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function buildCodeSeedMessage(
  root: string,
  prompt: string,
  context: ContextGraphResult,
  validationCommands: Array<{ command: string; args: string[]; reason: string }>,
  sufficiency?: ContextSufficiencyReport,
  model = '',
  memoryContext?: MemoryContext,
  delegationReport?: DelegationReport,
  contextLedgerSummary?: string,
): Promise<string> {
  const budget = allocateContextBudget(model);
  const evidence = selectEvidenceFiles(context, prompt, budget.maxFiles)
    .map((file) => {
      const body = formatEvidenceBody(file.path, file.content, budget);
      return [`--- FILE ${file.path} (${file.summary}) ---`, body, file.truncated ? '[TRUNCATED]' : ''].filter(Boolean).join('\n');
    })
    .join('\n\n');

  const repositoryFiles = await listRepositoryFiles(root);
  const fileIndex = repositoryFiles.slice(0, budget.maxIndexEntries).join('\n');
  const validation = validationCommands.length
    ? validationCommands.map((command) => `- ${[command.command, ...command.args].join(' ')} (${command.reason})`).join('\n')
    : '- No validation command auto-detected. After editing, call run_validation_matrix and then choose any targeted check with run_command if needed.';
  const sufficiencyBlock = sufficiency
    ? ['Context sufficiency gate:', formatContextSufficiencyMarkdown(sufficiency)].join('\n')
    : 'Context sufficiency gate: not provided; treat the initial evidence as incomplete until verified.';

  return [
    'Task:',
    prompt,
    '',
    sufficiencyBlock,
    '',
    'Definition of Done for this implementation run:',
    formatWorkflowDodMarkdown(),
    '',
    memoryContext ? formatMemoryContext(memoryContext) : 'Project memories: not loaded.',
    '',
    contextLedgerSummary || 'Context ledger: not initialized.',
    '',
    formatDelegationReport(delegationReport),
    '',
    'Completion gate before attempt_completion(success=true):',
    '- Re-read the Task above and verify the final diff satisfies the complete original request, not just the first obvious subtask.',
    '- Check affected call sites, tests, docs/configs, and validation output for follow-through implied by the request.',
    '- Only set completedOriginalRequest=true after that comparison is complete; otherwise continue editing or return success=false with the exact blocker.',
    '',
    'Validation commands expected after changes:',
    validation,
    '',
    'Repository file index (read any of these with read_file; this is not the full tree if truncated):',
    fileIndex || '(empty)',
    '',
    'Initial evidence already gathered for you (read more as needed):',
    evidence || '(none — start by exploring with list_files / search_text)',
  ].join('\n');
}

export function selectEvidenceFiles(context: ContextGraphResult, prompt: string, limit = 24): ContextGraphResult['files'] {
  const lowerPrompt = prompt.toLowerCase();
  const isCodeSpacePageWork = /\bcode\s*space\b/.test(lowerPrompt) && /\b(page|workspace|sidebar|editor|diff|patch|accept|reject|changes?)\b/.test(lowerPrompt);
  const isAgentCapabilityWork = /\b(agent|tool|grep|shell|terminal|context|evidence|explor|self[-\s]?explor|analy[sz]e?|harness|workflow|patch|planner|runtime|apply|edit)\b/.test(lowerPrompt);

  const weighted = context.files.map((file, originalIndex) => {
    const lowerPath = file.path.toLowerCase();
    let weight = file.score;
    if (file.reasons.some((reason) => reason === 'explicit_file' || reason === 'explicit_folder' || reason === 'open_tab' || reason === 'current_editor')) weight += 1000;
    if (isCodeSpacePageWork && /^components\/code-space\//.test(lowerPath)) weight += 500;
    if (isCodeSpacePageWork && /components\/code-space\/(codespaceworkspace|agentpanel)/i.test(file.path)) weight += 450;
    if (isCodeSpacePageWork && /components\/code-space\/__tests__/.test(lowerPath)) weight += 260;
    if (isCodeSpacePageWork && lowerPath === 'app/page.tsx') weight += 220;
    if (isCodeSpacePageWork && /patch|diff|terminal|toolregistry|agentruntime|permissionmanager/.test(lowerPath)) weight += 120;
    if (isAgentCapabilityWork && /lib\/code-space\/runtime\/(agentruntime|contextgraphengine|toolregistry|terminalpolicy|permissionmanager|terminalrunner|workflowpolicy)/.test(lowerPath)) weight += 360;
    if (isAgentCapabilityWork && /app\/api\/code-space\/(agent|terminal)/.test(lowerPath)) weight += 300;
    if (/(workflowpolicy|planningengine|codeagentloop|repairloop|validationrunner)/.test(lowerPath)) weight += 220;
    if (/(__tests__|\.test\.|\.spec\.)/.test(lowerPath)) weight += 80;
    if (file.reasons.includes('project_rule')) weight += 180;
    if (file.reasons.includes('package_config')) weight += 80;
    return { file, weight, originalIndex };
  });

  return weighted
    .sort((a, b) => b.weight - a.weight || a.originalIndex - b.originalIndex)
    .slice(0, Math.max(1, limit))
    .map((item) => item.file);
}

function latestProgressSentence(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const sentences = normalized.match(/[^.!?]+[.!?]?/g) ?? [normalized];
  const latest = sentences[sentences.length - 1]?.trim() ?? normalized;
  const clipped = latest.length > 96 ? `${latest.slice(0, 95).trimEnd()}…` : latest;
  return clipped;
}

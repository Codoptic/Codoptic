import type { AssistantTurn, ChatMessage, ProviderSession, ToolSpec } from '@/lib/agent/providers';
import { chatTurnWithTools } from '@/lib/agent/providers';
import type { ContextGraphResult } from './contextGraphEngine';
import { listRepositoryFiles } from './repoMap';
import { ToolBudget, isReadOnlyTool } from './toolBudget';
import { validateSyntaxLightweight } from '@/lib/code-space/agent/editBlocks';
import { CODE_MODE_TOOL_SPECS, ToolExecutor, formatUnresolvedEditFailures, type CodeAgentContext } from './toolExecutor';
import {
  buildWorkflowKernelPrompt,
  formatContextSufficiencyMarkdown,
  formatWorkflowDodMarkdown,
  type ContextSufficiencyReport,
} from './workflowPolicy';
import { allocateContextBudget, compressMessageHistory, isReduciblePromptError, skeletonizeFileContent } from './contextWindowManager';

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
        turn = await chatTurnWithTools(opts.session, this.messages, tools, {
          signal: opts.signal,
          toolChoice: 'auto',
          maxTokens: opts.maxTokens,
        });
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
          turn = await chatTurnWithTools(opts.session, this.messages, tools, {
            signal: opts.signal,
            toolChoice: 'auto',
            maxTokens: opts.maxTokens,
          });
        } else {
          throw err;
        }
      }

      await this.recordAssistantTurn(turn, ctx);

      if (!turn.toolCalls.length) {
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
        completion = { completed: true, success, summary: summary || (success ? 'Task completed.' : 'Task could not be completed.'), stopReason: 'completed' };
        toolResults.push({ toolCallId: call.id, content: 'Completion recorded.' });
        continue;
      }

      await ctx.emit({ type: 'tool_start', toolCallId: call.id, tool: call.name, input: call.input });
      await ctx.emitRuntime('tool.started', { tool: call.name, input: call.input });
      const startedAt = Date.now();

      const mutating = !isReadOnlyTool(call.name);
      let result: { content: string; isError?: boolean };
      if (mutating && opts.budget.mutationBudgetExhausted()) {
        result = { content: `Mutation budget exhausted (${opts.budget.mutationsUsed}/${opts.budget.max}). Finish with the current state and exact blockers.`, isError: true };
      } else {
        result = await this.executor.execute(call, ctx);
        if (mutating && !result.isError) opts.budget.charge(call.name);
      }

      await ctx.emit({ type: 'tool_result', toolCallId: call.id, tool: call.name, output: result.content, durationMs: Date.now() - startedAt, error: result.isError ? result.content : undefined });
      await ctx.emitRuntime(result.isError ? 'tool.failed' : 'tool.completed', { tool: call.name });
      toolResults.push({ toolCallId: call.id, content: result.content, isError: result.isError });
    }

    this.messages.push({ role: 'tool', content: '', toolResults });
    return completion;
  }
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
    '3. After editing, run project validation commands with run_command where available.',
    '4. If validation fails, inspect the output, repair the smallest affected area, and re-run the relevant validation.',
    '5. When the work is done, call attempt_completion with success=true and a concise summary of what changed.',
    '',
    'Hard rules:',
    '- Do not fabricate results or write markdown notes as a substitute for real code changes.',
    '- Reserve success=false for impossible, contradictory, or blocked tasks with exact evidence.',
    '- Only edit files that the task requires. Avoid unrelated refactors or speculative abstractions.',
    '- Prefer the smallest change that correctly solves the problem.',
    '- Edits are checkpointed and can be restored if a change makes the result worse.',
    '- The user sees applied diffs, validation results, and your final attempt_completion summary.',
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
): Promise<string> {
  const budget = allocateContextBudget(model);
  const evidence = selectEvidenceFiles(context, prompt, budget.maxFiles)
    .map((file) => {
      let body = file.content.length > budget.maxCharsPerFile
        ? `${file.content.slice(0, budget.maxCharsPerFile)}\n[TRUNCATED — read_file for the rest]`
        : file.content;
      if (budget.useSkeleton) body = skeletonizeFileContent(file.path, body);
      return [`--- FILE ${file.path} (${file.summary}) ---`, body, file.truncated ? '[TRUNCATED]' : ''].filter(Boolean).join('\n');
    })
    .join('\n\n');

  const repositoryFiles = await listRepositoryFiles(root);
  const fileIndex = repositoryFiles.slice(0, budget.maxIndexEntries).join('\n');
  const validation = validationCommands.length
    ? validationCommands.map((command) => `- ${[command.command, ...command.args].join(' ')} (${command.reason})`).join('\n')
    : '- No validation command auto-detected. After editing, choose an appropriate check with run_command.';
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

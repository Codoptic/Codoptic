import { validateSyntaxLightweight } from '@/lib/code-space/agent/editBlocks';
import type { TerminalCommand } from './terminalPolicy';
import type { CodeAgentContext } from './toolExecutor';
import { ValidationRunner, progressiveOrder, type ValidationRunResult } from './validationRunner';
import type { SubagentRunner, SubagentResult } from './subagentRunner';
import { listRepositoryFiles } from './repoMap';

export interface CoherenceFinding {
  path: string;
  kind: 'missing_in_diff' | 'syntax' | 'leftover_reference';
  message: string;
}

export interface DiffCoherenceReport {
  findings: CoherenceFinding[];
  diff: string;
}

/**
 * The validation/testing agent. Runs AFTER edits are applied and BEFORE the final verdict:
 * reviews the cumulative git diff for integration coherence, runs validation progressively,
 * and (optionally) spawns a test-writer subagent to generate + run focused scripts.
 */
export class IntegrationVerifier {
  constructor(
    private readonly validation: ValidationRunner = new ValidationRunner(),
    private readonly subagents?: SubagentRunner,
  ) {}

  /** Cross-check the cumulative ledger against the real git diff and re-validate syntax. */
  async reviewDiffCoherence(ctx: CodeAgentContext): Promise<DiffCoherenceReport> {
    const findings: CoherenceFinding[] = [];
    const command: TerminalCommand = { kind: 'explore', command: 'git', args: ['diff'], cwd: ctx.root, reason: 'Integration review of the cumulative diff.', timeoutMs: 30_000 };
    const gitResult = await ctx.terminal.run(command, ctx.root, ctx.signal);
    const diff = gitResult.status === 'failed' ? '' : gitResult.output;
    const diffUsable = Boolean(diff.trim());

    for (const [path, entry] of ctx.ledger) {
      if (entry.deleted) continue;
      // Only assert presence-in-diff when git produced a usable diff (else we'd false-positive).
      if (diffUsable && !diff.includes(path)) {
        findings.push({ path, kind: 'missing_in_diff', message: `Edited file ${path} is not present in the git diff — the change may be partial or out of sync with disk.` });
      }
      for (const diagnostic of validateSyntaxLightweight(path, entry.afterContent)) {
        findings.push({ path, kind: 'syntax', message: diagnostic.message });
      }
    }

    return { findings, diff };
  }

  /** Run validation commands in the progressive strategy order. */
  async progressiveValidate(root: string, runId: string, commands: TerminalCommand[], signal?: AbortSignal): Promise<ValidationRunResult[]> {
    return this.validation.runValidationCommands(root, runId, progressiveOrder(commands), signal);
  }

  /** Spawn a test-writer subagent that writes focused scripts to .agent/tests/{runId}/ and runs them. */
  async generateAndRunTestScripts(ctx: CodeAgentContext, runId: string, task: string): Promise<{ folder: string; scripts: string[]; result?: SubagentResult }> {
    const folder = `.agent/tests/${runId}`;
    if (!this.subagents) return { folder, scripts: [] };
    const changed = Array.from(ctx.ledger.keys()).slice(0, 12).join(', ') || '(see git diff)';
    const result = await this.subagents.spawn({
      role: 'test-writer',
      task: [
        `Write focused, runnable test scripts under ${folder}/ that exercise the changes made for this task: ${task}.`,
        `Changed files: ${changed}.`,
        'Use edit_file to create the scripts under that folder, then run them with run_command and report any failures honestly. Do not modify source files.',
      ].join('\n'),
      readOnly: false,
      maxToolCalls: 16,
    });
    const scripts = (await listRepositoryFiles(ctx.root)).filter((file) => file.startsWith(`${folder}/`));
    return { folder, scripts, result };
  }
}

import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import type { AgentEventType } from './events';
import type { ValidationRunResult } from './validationRunner';
import type { CodeAgentLoop, CodeAgentLoopOptions } from './codeAgentLoop';
import type { CodeAgentContext } from './toolExecutor';
import { RepairStateMachine } from './repairStateMachine';

export interface RepairRunResult {
  /** Validation results after the final repair attempt (or the initial run if none needed). */
  results: ValidationRunResult[];
  /** Number of repair attempts actually performed. */
  attempts: number;
  repaired: boolean;
}

export interface RepairRunParams {
  loop: CodeAgentLoop;
  ctx: CodeAgentContext;
  loopOptions: CodeAgentLoopOptions;
  initialResults: ValidationRunResult[];
  runValidation: () => Promise<ValidationRunResult[]>;
  emit: (event: AgentSSEEvent) => void | Promise<void>;
  emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>;
  runId: string;
  maxAttempts?: number;
  repeatedFailureLimit?: number;
}

const MAX_FEEDBACK_OUTPUT = 4000;

/**
 * Real review/test/fix cycle. When validation fails, the failing command + output
 * is fed back into the SAME live tool loop so the model reads, edits, and fixes,
 * then validation is re-run. Repeats up to a bounded attempt count.
 */
export class RepairLoop {
  constructor(private readonly maxAttempts = 3) {}

  shouldRepair(results: ValidationRunResult[]): boolean {
    return results.some((result) => result.status === 'failed');
  }

  async run(params: RepairRunParams): Promise<RepairRunResult> {
    let results = params.initialResults;
    let attempts = 0;
    const maxAttempts = params.maxAttempts ?? this.maxAttempts;
    const state = new RepairStateMachine(params.repeatedFailureLimit ?? 3);

    while (this.shouldRepair(results) && attempts < maxAttempts) {
      if (params.loopOptions.signal?.aborted) break;
      if (params.loopOptions.budget.turnsExhausted() || params.loopOptions.budget.mutationBudgetExhausted()) break;
      attempts += 1;

      const failures = results.filter((result) => result.status === 'failed');
      const decisions = failures.map((failure) => state.observe(failure));
      const blocker = decisions.find((decision) => decision.blocker)?.blocker;
      for (const decision of decisions) {
        params.ctx.contextLedger?.add({
          kind: 'repair',
          command: decision.fingerprint.command,
          summary: `${decision.fingerprint.category} failure fingerprint ${decision.fingerprint.hash} seen ${decision.count} time(s): ${decision.fingerprint.anchor}`,
          status: decision.blocker ? 'failed' : 'pending',
        });
      }
      if (blocker) {
        await params.emitRuntime('review.completed', { attempts, repaired: false, stillFailing: failures.map((result) => result.command), blocker });
        break;
      }
      await params.emitRuntime('review.started', { attempt: attempts, failedCommands: failures.map((result) => result.command) });

      for (const failure of failures) {
        if (failure.artifact) params.ctx.artifacts.set(failure.artifact.artifactId, failure.artifact);
      }

      const feedback = this.buildFeedback(failures, attempts);
      await params.loop.continueWith(feedback, params.ctx, params.loopOptions);

      results = await params.runValidation();
      for (const result of results) {
        await params.emit({ type: 'validation_result', id: `validation:${params.runId}:repair${attempts}:${result.kind}`, command: result.command, status: result.status, output: result.output });
        await params.emitRuntime(result.status === 'failed' ? 'validation.failed' : 'validation.completed', { command: result.command, status: result.status, artifact: result.artifact, repairAttempt: attempts });
      }
      await params.emitRuntime('review.comment.created', { attempt: attempts, stillFailing: results.filter((result) => result.status === 'failed').map((result) => result.command) });
    }

    const repaired = attempts > 0 && !this.shouldRepair(results);
    await params.emitRuntime('review.completed', { attempts, repaired, stillFailing: results.filter((result) => result.status === 'failed').map((result) => result.command) });
    return { results, attempts, repaired };
  }

  private buildFeedback(failures: ValidationRunResult[], attempt: number): string {
    const blocks = failures.map((failure) => {
      const output = failure.output.length > MAX_FEEDBACK_OUTPUT ? `${failure.output.slice(0, MAX_FEEDBACK_OUTPUT)}\n…[truncated; read full output via read_artifact id=${failure.artifact?.artifactId ?? 'n/a'}]` : failure.output;
      return [`Command: ${failure.command} → FAILED`, failure.artifact ? `artifactId: ${failure.artifact.artifactId}` : '', 'Output:', output].filter(Boolean).join('\n');
    });
    return [
      `Validation failed (repair attempt ${attempt}). Diagnose the root cause from the output below, edit the necessary files to fix it, and do not stop until validation passes or you are certain it cannot be fixed automatically.`,
      '',
      blocks.join('\n\n'),
      '',
      'After fixing, the validation commands will be run again. When done, call attempt_completion.',
    ].join('\n');
  }
}

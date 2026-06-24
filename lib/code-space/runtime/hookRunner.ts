import type { CodeAgentContext } from './toolExecutor';
import type { ValidationRunResult } from './validationRunner';

export type CoworkingHook = 'after_edit' | 'after_ui_edit' | 'after_validation_failure' | 'before_completion';

export interface HookResult {
  hook: CoworkingHook;
  status: 'passed' | 'blocked' | 'skipped';
  summary: string;
  evidenceKind?: 'validation' | 'browser' | 'repair' | 'supervisor';
}

export class HookRunner {
  afterEdit(ctx: CodeAgentContext, changedPaths: string[]): HookResult {
    const hasChanges = changedPaths.length > 0 || ctx.ledger.size > 0 || ctx.proposedFiles.size > 0;
    return {
      hook: 'after_edit',
      status: hasChanges ? 'passed' : 'skipped',
      summary: hasChanges ? `Edit hook recorded ${changedPaths.length || ctx.ledger.size} changed path(s).` : 'No edits to validate.',
      evidenceKind: 'validation',
    };
  }

  afterUiEdit(ctx: CodeAgentContext, changedPaths: string[]): HookResult {
    const uiChanged = changedPaths
      .filter((filePath) => !filePath.startsWith('.agent/'))
      .some((filePath) => /\.(tsx|jsx|css|scss)$/.test(filePath) || /(^|\/)(app|pages|components)\/.*\.(ts|js)$/.test(filePath));
    const browserEvidence = ctx.contextLedger?.list('browser').length ?? 0;
    return {
      hook: 'after_ui_edit',
      status: !uiChanged ? 'skipped' : browserEvidence > 0 ? 'passed' : 'blocked',
      summary: !uiChanged
        ? 'No UI paths changed.'
        : browserEvidence > 0
          ? `Browser QA evidence recorded (${browserEvidence} item(s)).`
          : 'UI paths changed; browser screenshot and console/network evidence are required.',
      evidenceKind: 'browser',
    };
  }

  afterValidationFailure(results: ValidationRunResult[]): HookResult {
    const failed = results.filter((result) => result.status === 'failed');
    return {
      hook: 'after_validation_failure',
      status: failed.length ? 'blocked' : 'skipped',
      summary: failed.length ? `Repair planner required for ${failed.map((result) => result.command).join(', ')}.` : 'No validation failures.',
      evidenceKind: 'repair',
    };
  }

  beforeCompletion(ctx: CodeAgentContext, packageBlockers: string[] = []): HookResult {
    const blockers = [...packageBlockers];
    if (!ctx.ledger.size && !ctx.proposedFiles.size) blockers.push('No source changes or proposals exist.');
    if (ctx.editFailures.size > 0) blockers.push('Unresolved edit failures remain.');
    return {
      hook: 'before_completion',
      status: blockers.length ? 'blocked' : 'passed',
      summary: blockers.length ? blockers.join(' ') : 'Completion hook passed.',
      evidenceKind: 'supervisor',
    };
  }

  runAll(ctx: CodeAgentContext, changedPaths: string[], validationResults: ValidationRunResult[] = [], packageBlockers: string[] = []): HookResult[] {
    return [
      this.afterEdit(ctx, changedPaths),
      this.afterUiEdit(ctx, changedPaths),
      this.afterValidationFailure(validationResults),
      this.beforeCompletion(ctx, packageBlockers),
    ];
  }
}

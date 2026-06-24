import { describe, expect, it } from 'vitest';
import { Supervisor } from '../supervisor';
import type { ValidationRunResult } from '../validationRunner';
import type { CoherenceFinding } from '../integrationVerifier';

function passing(command: string): ValidationRunResult {
  return { kind: 'test', command, status: 'passed', output: '', durationMs: 1 };
}
function failing(command: string): ValidationRunResult {
  return { kind: 'test', command, status: 'failed', output: 'boom', durationMs: 1 };
}
function skipped(command: string): ValidationRunResult {
  return { kind: 'test', command, status: 'skipped', output: 'skipped', durationMs: 1 };
}

describe('Supervisor.reconcile', () => {
  const supervisor = new Supervisor();

  it('verifies only when every gate passes', () => {
    const verdict = supervisor.reconcile({
      ledgerSize: 2,
      coherence: [],
      validationRuns: [passing('npm run test')],
      unresolvedEditFailures: '',
    });
    expect(verdict.status).toBe('verified');
    expect(verdict.blockers).toHaveLength(0);
  });

  it('blocks on zero changed files', () => {
    const verdict = supervisor.reconcile({ ledgerSize: 0, coherence: [], validationRuns: [passing('x')], unresolvedEditFailures: '' });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.blockers.join(' ')).toMatch(/no files were changed/i);
  });

  it('blocks on failed validation', () => {
    const verdict = supervisor.reconcile({ ledgerSize: 1, coherence: [], validationRuns: [failing('npm run lint')], unresolvedEditFailures: '' });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.blockers.join(' ')).toMatch(/validation failed/i);
  });

  it('blocks on skipped runnable validation', () => {
    const verdict = supervisor.reconcile({ ledgerSize: 1, coherence: [], validationRuns: [skipped('npm run test')], unresolvedEditFailures: '' });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.blockers.join(' ')).toMatch(/validation skipped/i);
  });

  it('allows the explicit no-command manual review sentinel when other gates are clean', () => {
    const verdict = supervisor.reconcile({ ledgerSize: 1, coherence: [], validationRuns: [skipped('manual review')], unresolvedEditFailures: '' });
    expect(verdict.status).toBe('verified');
  });

  it('blocks on integration coherence findings', () => {
    const findings: CoherenceFinding[] = [{ path: 'a.ts', kind: 'syntax', message: 'imbalance' }];
    const verdict = supervisor.reconcile({ ledgerSize: 1, coherence: findings, validationRuns: [passing('x')], unresolvedEditFailures: '' });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.blockers.join(' ')).toMatch(/integration review/i);
  });

  it('blocks on unresolved edit failures', () => {
    const verdict = supervisor.reconcile({ ledgerSize: 1, coherence: [], validationRuns: [passing('x')], unresolvedEditFailures: '- a.ts [SYNTAX_ERROR]' });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.blockers.join(' ')).toMatch(/edit_file failures/i);
  });

  it('blocks when a subagent reports failure', () => {
    const verdict = supervisor.reconcile({
      ledgerSize: 1,
      coherence: [],
      validationRuns: [passing('x')],
      unresolvedEditFailures: '',
      subagentResults: [{ role: 'verifier', summary: 'could not run', success: false, toolCalls: 3 }],
    });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.blockers.join(' ')).toMatch(/subagent/i);
  });

  it('does not block on advisory helper failures caused by scoped policy or non-git state', () => {
    const verdict = supervisor.reconcile({
      ledgerSize: 1,
      coherence: [],
      validationRuns: [passing('x')],
      unresolvedEditFailures: '',
      subagentResults: [
        { role: 'docs-reader', summary: 'The advisory helper is read-only and cannot modify files.', success: false, toolCalls: 2, advisory: true },
        { role: 'explorer', summary: 'fatal: not a git repository; workspace is not git-managed.', success: false, toolCalls: 1, advisory: true },
      ],
    });

    expect(verdict.status).toBe('verified');
    expect(verdict.blockers).toHaveLength(0);
  });

  it('still blocks required mutating subagent failures', () => {
    const verdict = supervisor.reconcile({
      ledgerSize: 1,
      coherence: [],
      validationRuns: [passing('x')],
      unresolvedEditFailures: '',
      subagentResults: [{ role: 'test-writer', summary: 'Could not write focused tests.', success: false, toolCalls: 3, advisory: false }],
    });

    expect(verdict.status).toBe('needs_review');
    expect(verdict.blockers.join(' ')).toMatch(/subagent/i);
  });

  it('blocks when required delegation was not reconciled', () => {
    const verdict = supervisor.reconcile({
      ledgerSize: 1,
      coherence: [],
      validationRuns: [passing('x')],
      unresolvedEditFailures: '',
      delegationRequired: true,
      delegationReconciled: false,
    });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.blockers.join(' ')).toMatch(/delegation/i);
  });
});

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
});

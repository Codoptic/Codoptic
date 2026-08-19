import { describe, expect, it } from 'vitest';
import { DelegationPlanner } from '../delegationPlanner';
import type { ContextGraphResult } from '../contextGraphEngine';
import type { TerminalCommand } from '../terminalPolicy';

function context(overrides: Partial<ContextGraphResult> = {}): ContextGraphResult {
  return {
    filesConsidered: 20,
    files: [],
    selectedFiles: ['lib/code-space/runtime/agentRuntime.ts'],
    omittedRelevantCandidates: [],
    terms: [],
    dependencyEdges: [],
    testCandidates: [],
    validationCandidates: [],
    missingContextWarnings: [],
    confidence: 'high',
    ...overrides,
  };
}

const validation: TerminalCommand[] = [
  { kind: 'test', command: 'npm', args: ['run', 'test'], reason: 'Run tests.', timeoutMs: 120_000 },
];

describe('DelegationPlanner', () => {
  it('does not delegate simple implementation tasks by default', () => {
    const plan = new DelegationPlanner().plan({
      mode: 'code',
      prompt: 'Update answer in src.ts',
      context: context(),
      validationCommands: validation,
    });
    expect(plan.required).toBe(false);
    expect(plan.tasks).toHaveLength(0);
  });

  it('delegates complex workflow review tasks with profile-bounded helpers', () => {
    const plan = new DelegationPlanner('deep').plan({
      runId: 'run:test',
      mode: 'code',
      prompt: 'Comprehensively review the agent workflow, subagent delegation, memory, docs, and validation risks',
      context: context({
        selectedFiles: Array.from({ length: 24 }, (_, index) => `src/file-${index}.ts`),
        confidence: 'medium',
        missingContextWarnings: ['Possible omitted integration surface.'],
      }),
      validationCommands: validation,
    });

    expect(plan.required).toBe(false);
    expect(plan.tasks).toHaveLength(0);
    expect(plan.workGraph?.packages ?? []).toHaveLength(0);
  });

  it('spawns validation-heavy verifier tasks with command-running capability', () => {
    const plan = new DelegationPlanner('deep').plan({
      runId: 'run:test',
      mode: 'code',
      prompt: 'Fix the implementation and verify test, typecheck, lint, and build results',
      context: context({ testCandidates: ['a.test.ts', 'b.test.ts', 'c.test.ts'] }),
      validationCommands: validation,
    });

    expect(plan.required).toBe(false);
    expect(plan.tasks).toHaveLength(0);
    expect(plan.workGraph?.packages ?? []).toHaveLength(0);
  });

  it('keeps standard profile near the legacy helper size', () => {
    const plan = new DelegationPlanner('standard').plan({
      runId: 'run:test',
      mode: 'code',
      prompt: 'Comprehensively review the agent workflow, subagent delegation, memory, docs, and validation risks',
      context: context({
        selectedFiles: Array.from({ length: 24 }, (_, index) => `src/file-${index}.ts`),
        missingContextWarnings: ['Possible omitted integration surface.'],
      }),
      validationCommands: validation,
    });

    expect(plan.required).toBe(false);
    expect(plan.tasks).toHaveLength(0);
  });
});

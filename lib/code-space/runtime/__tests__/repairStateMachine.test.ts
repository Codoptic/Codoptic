import { describe, expect, it } from 'vitest';
import { RepairStateMachine } from '../repairStateMachine';
import type { ValidationRunResult } from '../validationRunner';

function failed(output: string): ValidationRunResult {
  return {
    kind: 'typecheck',
    command: 'npm run typecheck',
    status: 'failed',
    output,
    durationMs: 10,
  };
}

describe('RepairStateMachine', () => {
  it('escalates repeated identical validation failures', () => {
    const machine = new RepairStateMachine(2);
    expect(machine.observe(failed('src/app.ts:12 TS2322: Type string is not assignable')).blocker).toBeUndefined();
    const second = machine.observe(failed('src/app.ts:13 TS2322: Type string is not assignable'));
    expect(second.repeated).toBe(true);
    expect(second.blocker).toMatch(/Repeated typecheck failure/);
  });
});

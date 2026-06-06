import { describe, expect, it } from 'vitest';
import { ToolBudget, isReadOnlyTool } from '../toolBudget';

describe('ToolBudget', () => {
  it('treats read/explore tools as free and mutating tools as costly', () => {
    expect(isReadOnlyTool('read_file')).toBe(true);
    expect(isReadOnlyTool('search_text')).toBe(true);
    expect(isReadOnlyTool('git_diff')).toBe(true);
    expect(isReadOnlyTool('research_web')).toBe(true);
    expect(isReadOnlyTool('harness_context')).toBe(true);
    expect(isReadOnlyTool('scan_code_quality')).toBe(true);
    expect(isReadOnlyTool('run_validation_matrix')).toBe(false);
    expect(isReadOnlyTool('edit_file')).toBe(false);
    expect(isReadOnlyTool('run_command')).toBe(false);
  });

  it('never exhausts the mutation budget from read-only calls', () => {
    const budget = new ToolBudget(2, 100);
    for (let i = 0; i < 50; i += 1) budget.charge('read_file');
    expect(budget.mutationsUsed).toBe(0);
    expect(budget.mutationBudgetExhausted()).toBe(false);
  });

  it('charges mutating tools against the mutation budget', () => {
    const budget = new ToolBudget(2, 100);
    budget.charge('edit_file');
    expect(budget.mutationBudgetExhausted()).toBe(false);
    budget.charge('run_command');
    expect(budget.mutationsUsed).toBe(2);
    expect(budget.mutationBudgetExhausted()).toBe(true);
  });

  it('enforces a hard turn cap independent of tool cost', () => {
    const budget = new ToolBudget(100, 3);
    budget.recordTurn();
    budget.recordTurn();
    expect(budget.turnsExhausted()).toBe(false);
    budget.recordTurn();
    expect(budget.turnsExhausted()).toBe(true);
    expect(budget.exhausted()).toBe(true);
  });

  it('flags nearExhaustion before the limit so the loop can converge', () => {
    const budget = new ToolBudget(2, 10);
    expect(budget.nearExhaustion()).toBe(false);
    budget.charge('edit_file');
    expect(budget.nearExhaustion()).toBe(true);
  });
});

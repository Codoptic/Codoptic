import { describe, expect, it } from 'vitest';
import { appendInstructionToPrompt, buildPlanImplementationPrompt } from '../planBuild';

describe('plan build prompt helpers', () => {
  it('appends instruction preferences as a separate prompt section', () => {
    const result = appendInstructionToPrompt('Implement the requested feature.', 'Prefer small patches.');

    expect(result).toContain('Implement the requested feature.');
    expect(result).toContain('Additional instruction for user customization:');
    expect(result).toContain('Prefer small patches.');
  });

  it('leaves the prompt unchanged when no instruction is set', () => {
    expect(appendInstructionToPrompt('Implement the requested feature.', '   ')).toBe(
      'Implement the requested feature.',
    );
  });

  it('keeps the plan helper focused on the source plan file', () => {
    const prompt = buildPlanImplementationPrompt('.agent/plans/demo.md');

    expect(prompt).toContain('Build from the approved plan at .agent/plans/demo.md.');
    expect(prompt).toContain('New Implementations');
    expect(prompt).toContain('create_files/create_directory');
  });
});

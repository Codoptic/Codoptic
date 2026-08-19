export function buildCleanCriticPrompt(input: {
  diff: string;
  acceptance: string[];
  tests: string[];
}): string {
  return [
    'You are a clean-context critic. You do not inherit the writer transcript.',
    'Review only the diff, acceptance criteria, and test results.',
    'Report concrete bugs, missing acceptance, and would-not-merge risks.',
    '',
    'Acceptance:',
    ...(input.acceptance.length ? input.acceptance.map((item) => `- ${item}`) : ['- none']),
    '',
    'Tests:',
    ...(input.tests.length ? input.tests.map((item) => `- ${item}`) : ['- none']),
    '',
    'Diff:',
    input.diff.slice(0, 24_000) || '(empty)',
  ].join('\n');
}

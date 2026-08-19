export interface SessionNoteProposal {
  path: string;
  content: string;
  reason: string;
}

export function buildSessionNoteProposal(input: {
  runId: string;
  decisions: string[];
  pitfalls: string[];
  commands: string[];
}): SessionNoteProposal {
  return {
    path: 'memories/research-notes.md',
    reason: `Sleep-time consolidation from ${input.runId}`,
    content: [
      `# Session notes (${input.runId})`,
      '',
      '## Decisions',
      ...(input.decisions.length ? input.decisions.map((item) => `- ${item}`) : ['- none']),
      '',
      '## Pitfalls',
      ...(input.pitfalls.length ? input.pitfalls.map((item) => `- ${item}`) : ['- none']),
      '',
      '## Commands',
      ...(input.commands.length ? input.commands.map((item) => `- \`${item}\``) : ['- none']),
      '',
    ].join('\n'),
  };
}

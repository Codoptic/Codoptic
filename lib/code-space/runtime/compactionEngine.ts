import type { ChatMessage } from '@/lib/agent/providers';

export interface CompactResult {
  messages: ChatMessage[];
  layer: 'wipe' | 'summary' | 'none';
  flushed: boolean;
}

export function wipeOldToolResults(messages: ChatMessage[], keepRecent = 4): ChatMessage[] {
  let toolTurns = 0;
  const next = messages.map((message) => ({ ...message, toolResults: message.toolResults?.map((result) => ({ ...result })) }));
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (!message || message.role !== 'tool' || !message.toolResults) continue;
    toolTurns += 1;
    if (toolTurns <= keepRecent) continue;
    for (const result of message.toolResults) {
      if (result.isError) continue;
      if (result.content.length <= 160) continue;
      result.content = `${result.content.slice(0, 120)}\n[prior tool result wiped; re-fetch via read_artifact/read_file]`;
    }
  }
  return next;
}

export function structuredCompactSummary(input: {
  task: string;
  decisions?: string[];
  files?: string[];
  failingCommands?: string[];
  blockers?: string[];
}): string {
  return [
    'Compacted working state (constitution reloads after this):',
    `Task: ${input.task}`,
    input.decisions?.length ? `Decisions: ${input.decisions.join('; ')}` : 'Decisions: none recorded.',
    input.files?.length ? `Files: ${input.files.join(', ')}` : 'Files: none.',
    input.failingCommands?.length ? `Failing commands: ${input.failingCommands.join('; ')}` : 'Failing commands: none.',
    input.blockers?.length ? `Blockers: ${input.blockers.join('; ')}` : 'Blockers: none.',
  ].join('\n');
}

export function applyLayeredCompact(messages: ChatMessage[], summary?: string, opaque?: string): CompactResult {
  if (messages.length < 8) return { messages, layer: 'none', flushed: false };
  const wiped = wipeOldToolResults(messages);
  if (!summary && !opaque) return { messages: wiped, layer: 'wipe', flushed: true };
  const kept = wiped.slice(-6);
  return {
    layer: 'summary',
    flushed: true,
    messages: [
      wiped[0],
      opaque ? { role: 'user' as const, content: `Opaque compact: ${opaque}` } : undefined,
      summary ? { role: 'user' as const, content: summary } : undefined,
      ...kept.filter((message) => message.role !== 'system'),
    ].filter((message): message is ChatMessage => Boolean(message)),
  };
}

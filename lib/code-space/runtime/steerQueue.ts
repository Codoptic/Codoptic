export type SteerMode = 'queue' | 'steer' | 'interrupt';

export interface SteerMessage {
  id: string;
  text: string;
  mode: SteerMode;
  createdAt: number;
}

const queues = new Map<string, SteerMessage[]>();

export function enqueueSteer(runId: string, text: string, mode: SteerMode = 'queue'): SteerMessage {
  const message: SteerMessage = {
    id: `steer:${runId}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    text: text.trim(),
    mode,
    createdAt: Date.now(),
  };
  const existing = queues.get(runId) ?? [];
  existing.push(message);
  queues.set(runId, existing);
  return message;
}

export function drainSteerQueue(runId: string): SteerMessage[] {
  const items = queues.get(runId) ?? [];
  queues.delete(runId);
  return items.filter((item) => item.text);
}

export function peekSteerQueue(runId: string): SteerMessage[] {
  return [...(queues.get(runId) ?? [])];
}

export function formatSteerInjection(messages: SteerMessage[]): string {
  if (!messages.length) return '';
  return [
    'User steering (keep going unless interrupt was requested; do not restart from scratch):',
    ...messages.map((item) => `- [${item.mode}] ${item.text}`),
  ].join('\n');
}

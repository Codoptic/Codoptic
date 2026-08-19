export interface ParkedToolCall {
  toolCallId: string;
  runId: string;
  name: string;
  input: Record<string, unknown>;
  cwd?: string;
  createdAt: number;
}

const parked = new Map<string, ParkedToolCall>();

export function parkToolCall(call: ParkedToolCall): void {
  parked.set(call.toolCallId, call);
}

export function takeParkedToolCall(toolCallId: string): ParkedToolCall | undefined {
  const call = parked.get(toolCallId);
  parked.delete(toolCallId);
  return call;
}

export function getParkedToolCall(toolCallId: string): ParkedToolCall | undefined {
  return parked.get(toolCallId);
}

export function listParkedToolCalls(runId: string): ParkedToolCall[] {
  return [...parked.values()].filter((call) => call.runId === runId);
}

export function sessionApprovalKey(name: string, input: Record<string, unknown>): string {
  const path = typeof input.path === 'string' ? input.path : '';
  const command = typeof input.command === 'string' ? input.command : '';
  return `${name}:${path || command || 'session'}`;
}

const sessionApprovals = new Set<string>();
const waiters = new Map<string, { resolve: (decision: 'approved' | 'rejected') => void }>();

export function approveForSession(key: string): void {
  sessionApprovals.add(key);
}

export function isApprovedForSession(key: string): boolean {
  return sessionApprovals.has(key);
}

export function waitForApproval(toolCallId: string, signal?: AbortSignal): Promise<'approved' | 'rejected'> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      waiters.delete(toolCallId);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.set(toolCallId, {
      resolve: (decision) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(decision);
      },
    });
  });
}

export function resolveApproval(toolCallId: string, decision: 'approved' | 'rejected'): boolean {
  const waiter = waiters.get(toolCallId);
  waiters.delete(toolCallId);
  if (!waiter) return false;
  waiter.resolve(decision);
  return true;
}

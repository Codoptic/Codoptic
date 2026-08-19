const registry = new Map<string, AbortController>();

export function registerRunAbort(runId: string, controller = new AbortController()): AbortController {
  const existing = registry.get(runId);
  if (existing && !existing.signal.aborted) existing.abort();
  registry.set(runId, controller);
  return controller;
}

export function abortRun(runId: string, reason = 'Run cancelled.'): boolean {
  const controller = registry.get(runId);
  if (!controller) return false;
  if (!controller.signal.aborted) controller.abort(reason);
  registry.delete(runId);
  return true;
}

export function getRunAbortSignal(runId: string): AbortSignal | undefined {
  return registry.get(runId)?.signal;
}

export function clearRunAbort(runId: string): void {
  registry.delete(runId);
}

export function composeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      onAbort();
      break;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

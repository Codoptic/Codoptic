/** 0 = no Document Mode stage wall-clock timeout (generation runs until complete or user cancel). */
export const INSTRUCTION_STAGE_TIMEOUT_MS = 0;

export function instructionTimeoutMarkdown(timeoutMs = INSTRUCTION_STAGE_TIMEOUT_MS): string {
  const seconds = timeoutMs > 0 ? Math.round(timeoutMs / 1000) : 180;
  return [
    '# Document Mode guide not completed',
    '',
    `The diagram was generated and saved, but the Document Mode guide exceeded the ${seconds}s generation budget.`,
    'Run Document Mode again with Quick Mode or a narrower focus if you need the full guide.',
  ].join('\n');
}

/** Fallback markdown when Document Mode fails for a non-abort reason (diagram still saved). */
export function instructionFailureMarkdown(message: string): string {
  return [
    '# Document Mode guide not completed',
    '',
    'The diagram was generated and saved, but the Document Mode guide failed.',
    '',
    `Error: ${message}`,
  ].join('\n');
}

export async function withInstructionTimeout<T>(
  parentSignal: AbortSignal | undefined,
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs = INSTRUCTION_STAGE_TIMEOUT_MS,
): Promise<T> {
  // Motivation vs Logic: large Document Mode runs often exceed a fixed wall-clock budget
  // even when provider calls are healthy. When timeoutMs <= 0, skip the timer entirely
  // and only honor explicit user/parent cancellation.
  if (timeoutMs <= 0) {
    const signal = parentSignal ?? new AbortController().signal;
    return task(signal);
  }

  const ac = new AbortController();
  let timedOut = false;
  const abortFromParent = () => ac.abort(parentSignal?.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort(new DOMException('Timed out', 'TimeoutError'));
  }, timeoutMs);

  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  try {
    return await task(ac.signal);
  } catch (err) {
    if (parentSignal?.aborted) throw err;
    if (timedOut) {
      throw new Error(`Document Mode guide timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

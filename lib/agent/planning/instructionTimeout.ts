export const INSTRUCTION_STAGE_TIMEOUT_MS = 3 * 60_000;

export function instructionTimeoutMarkdown(timeoutMs = INSTRUCTION_STAGE_TIMEOUT_MS): string {
  return [
    '# Document Mode guide not completed',
    '',
    `The diagram was generated and saved, but the Document Mode guide exceeded the ${Math.round(timeoutMs / 1000)}s generation budget.`,
    'Run Document Mode again with Quick Mode or a narrower focus if you need the full guide.',
  ].join('\n');
}

export async function withInstructionTimeout<T>(
  parentSignal: AbortSignal | undefined,
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs = INSTRUCTION_STAGE_TIMEOUT_MS,
): Promise<T> {
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

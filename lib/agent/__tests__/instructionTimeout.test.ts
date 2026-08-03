import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INSTRUCTION_STAGE_TIMEOUT_MS,
  instructionFailureMarkdown,
  withInstructionTimeout,
} from '../planning/instructionTimeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('withInstructionTimeout', () => {
  it('defaults to no stage timeout', () => {
    expect(INSTRUCTION_STAGE_TIMEOUT_MS).toBe(0);
  });

  it('never aborts a long-running task when timeoutMs <= 0', async () => {
    vi.useFakeTimers();
    let finished = false;
    const resultPromise = withInstructionTimeout(
      undefined,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10 * 60_000));
        finished = true;
        return 'ok';
      },
      0,
    );

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(resultPromise).resolves.toBe('ok');
    expect(finished).toBe(true);
  });

  it('still honors parent abort when timeout is disabled', async () => {
    const parent = new AbortController();
    const resultPromise = withInstructionTimeout(
      parent.signal,
      async (signal) => {
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason ?? new Error('aborted'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(signal.reason ?? new Error('aborted')),
            { once: true },
          );
        });
        return 'should-not-resolve';
      },
      0,
    );

    parent.abort(new Error('user cancel'));
    await expect(resultPromise).rejects.toThrow(/user cancel|aborted/);
  });

  it('aborts when a positive timeout is configured', async () => {
    vi.useFakeTimers();
    const resultPromise = withInstructionTimeout(
      undefined,
      async (signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason ?? new Error('aborted')),
            { once: true },
          );
        });
        return 'should-not-resolve';
      },
      50,
    );

    const expectation = expect(resultPromise).rejects.toThrow(/timed out after 0s/);
    await vi.advanceTimersByTimeAsync(50);
    await expectation;
  });
});

describe('instructionFailureMarkdown', () => {
  it('includes the real error message instead of the timeout stub', () => {
    const md = instructionFailureMarkdown('provider exploded');
    expect(md).toContain('Document Mode guide not completed');
    expect(md).toContain('Error: provider exploded');
    expect(md).not.toContain('generation budget');
  });
});

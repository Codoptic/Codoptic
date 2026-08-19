import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../providers/retry';

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and eventually returns', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) {
        const err: Error & { status?: number; retryAfterMs?: number } = new Error('Too Many Requests');
        err.status = 429;
        err.retryAfterMs = 10;
        throw err;
      }
      return 'finally ok';
    };
    const notices: Array<{ attempt: number; delayMs: number; reason: string }> = [];
    const result = await withRetry(fn, { onRetry: (n) => notices.push(n), baseDelayMs: 10, capDelayMs: 50 });
    expect(result).toBe('finally ok');
    expect(calls).toBe(3);
    expect(notices.length).toBeGreaterThanOrEqual(2);
    expect(notices[0]?.reason).toContain('429');
  });

  it('retries provider errors that only expose a transient message', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) {
        throw new Error('500 The server had an error while processing your request. Sorry about that!');
      }
      return 'ok after provider hiccup';
    };
    const notices: Array<{ attempt: number; delayMs: number; reason: string }> = [];

    const result = await withRetry(fn, { onRetry: (n) => notices.push(n), baseDelayMs: 1, capDelayMs: 1 });

    expect(result).toBe('ok after provider hiccup');
    expect(calls).toBe(2);
    expect(notices[0]?.reason).toBe('HTTP 500');
  });

  it('retries transient network exception codes', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) {
        const err: Error & { code?: string } = new Error('socket closed');
        err.code = 'ECONNRESET';
        throw err;
      }
      return 'ok after reset';
    };

    await expect(withRetry(fn, { baseDelayMs: 1, capDelayMs: 1 })).resolves.toBe('ok after reset');
    expect(calls).toBe(2);
  });

  it('throws non-retryable errors immediately', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('bad request'));
    await expect(
      withRetry(fn, {
        isRetryable: () => false,
      }),
    ).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts on signal', async () => {
    const ac = new AbortController();
    const fn = async () => {
      const err: Error & { status?: number } = new Error('rate limit');
      err.status = 429;
      throw err;
    };
    setTimeout(() => ac.abort(), 30);
    await expect(withRetry(fn, { signal: ac.signal, baseDelayMs: 50 })).rejects.toThrow();
  });

  it('caps shared-key 429 waits and does not block a sibling call', async () => {
    const ac = new AbortController();
    const notices: Array<{ delayMs: number }> = [];
    const failing = async () => {
      const err: Error & { status?: number; retryAfterMs?: number } = new Error('Too Many Requests');
      err.status = 429;
      err.retryAfterMs = 60_000;
      throw err;
    };

    const first = withRetry(failing, {
      cooldownKey: 'openai:test:default',
      signal: ac.signal,
      onRetry: (notice) => {
        notices.push(notice);
        ac.abort();
      },
    });

    await expect(withRetry(async () => 'ok', { cooldownKey: 'openai:test:default' })).resolves.toBe('ok');
    await expect(first).rejects.toThrow();
    expect(notices[0]?.delayMs).toBe(8_000);
  });
});

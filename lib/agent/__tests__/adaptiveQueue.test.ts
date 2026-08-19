import { afterEach, describe, expect, it, vi } from 'vitest';
import { adaptiveMap, type AdaptiveQueueEvent } from '../analysis/adaptiveQueue';

describe('adaptiveMap', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reduces concurrency on rate limits, cools down, then recovers after successes', async () => {
    vi.useFakeTimers();
    const events: AdaptiveQueueEvent[] = [];
    const started: number[] = [];
    let rateLimited = false;

    const promise = adaptiveMap(
      [1, 2, 3, 4, 5, 6],
      {
        initialConcurrency: 4,
        maxConcurrency: 4,
        onEvent: (event) => events.push(event),
      },
      async (item, _index, control) => {
        started.push(item);
        if (!rateLimited) {
          rateLimited = true;
          control.onRetry({ attempt: 1, delayMs: 0, reason: 'HTTP 429' });
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
        return item * 2;
      },
    );

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual([2, 4, 6, 8, 10, 12]);
    expect(events.some((event) => event.kind === 'rate-limit' && event.concurrency < 4)).toBe(true);
    expect(events.some((event) => event.kind === 'recover')).toBe(true);
    expect(started).toHaveLength(6);
  });

  it('keeps launching workers after a 429 instead of parking the queue', async () => {
    const startedAt: number[] = [];
    const started = Date.now();

    const result = await adaptiveMap(
      [1, 2, 3, 4],
      {
        initialConcurrency: 4,
        maxConcurrency: 8,
        minConcurrency: 2,
      },
      async (item, _index, control) => {
        startedAt.push(Date.now() - started);
        if (item === 1) control.onRetry({ attempt: 1, delayMs: 8_000, reason: 'HTTP 429' });
        return item;
      },
    );

    expect(result).toEqual([1, 2, 3, 4]);
    expect(Math.max(...startedAt)).toBeLessThan(50);
  });
});


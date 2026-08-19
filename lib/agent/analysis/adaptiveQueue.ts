import type { RetryListener } from '../providers';
import type { RetryNotice } from '../providers/types';

export interface AdaptiveQueueEvent {
  kind: 'rate-limit' | 'recover';
  concurrency: number;
  delayMs?: number;
  reason?: string;
}

export interface AdaptiveQueueControl {
  signal?: AbortSignal;
  onRetry: RetryListener;
}

export interface AdaptiveQueueOptions {
  initialConcurrency: number;
  minConcurrency?: number;
  maxConcurrency?: number;
  signal?: AbortSignal;
  onRetry?: RetryListener;
  onEvent?: (event: AdaptiveQueueEvent) => void;
}

const RECOVER_AFTER_SUCCESSES = 2;
const RATE_LIMIT_SPACING_CAP_MS = 2_000;

function isRateLimitNotice(notice: RetryNotice): boolean {
  return /\b(?:429|rate limit|too many requests)\b/i.test(notice.reason);
}

export async function adaptiveMap<T, R>(
  items: readonly T[],
  opts: AdaptiveQueueOptions,
  worker: (item: T, index: number, control: AdaptiveQueueControl) => Promise<R>,
): Promise<R[]> {
  const minConcurrency = opts.minConcurrency ?? 1;
  const maxConcurrency = Math.max(minConcurrency, opts.maxConcurrency ?? opts.initialConcurrency);
  let currentConcurrency = Math.min(Math.max(opts.initialConcurrency, minConcurrency), maxConcurrency);
  let nextIndex = 0;
  let active = 0;
  let completed = 0;
  let successesSinceLimit = 0;
  let settled = false;
  const results: R[] = new Array(items.length);

  // Motivation vs Logic: drop width on 429 but keep launching at the reduced cap.
  // A full-queue sleep stacked on the provider retry made large-repo analysis look idle.
  return new Promise<R[]>((resolve, reject) => {
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const maybeRecover = (): void => {
      if (currentConcurrency >= maxConcurrency) return;
      if (successesSinceLimit < RECOVER_AFTER_SUCCESSES) return;
      currentConcurrency++;
      successesSinceLimit = 0;
      opts.onEvent?.({ kind: 'recover', concurrency: currentConcurrency });
    };

    const pump = (): void => {
      if (settled) return;
      if (opts.signal?.aborted) {
        fail(new DOMException('Aborted', 'AbortError'));
        return;
      }
      if (completed >= items.length) {
        settled = true;
        resolve(results);
        return;
      }

      while (active < currentConcurrency && nextIndex < items.length) {
        const index = nextIndex++;
        const item = items[index]!;
        active++;
        const control: AdaptiveQueueControl = {
          signal: opts.signal,
          onRetry: (notice) => {
            opts.onRetry?.(notice);
            if (!isRateLimitNotice(notice)) return;
            currentConcurrency = Math.max(minConcurrency, currentConcurrency - 1);
            successesSinceLimit = 0;
            const spacingMs = Math.max(0, Math.min(RATE_LIMIT_SPACING_CAP_MS, notice.delayMs));
            opts.onEvent?.({
              kind: 'rate-limit',
              concurrency: currentConcurrency,
              delayMs: spacingMs,
              reason: notice.reason,
            });
          },
        };

        worker(item, index, control)
          .then((result) => {
            results[index] = result;
            active--;
            completed++;
            successesSinceLimit++;
            maybeRecover();
            pump();
          })
          .catch(fail);
      }
    };

    pump();
  });
}

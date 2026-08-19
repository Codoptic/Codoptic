/**
 * Infinite-retry wrapper with exponential backoff + jitter.
 *
 * Honors Retry-After when the underlying error carries one. Otherwise
 * starts at 2s, caps at 60s, and retries forever until the signal aborts.
 *
 * Every retry emits a notice via the supplied listener so the UI can show
 * "Retrying in 8s (attempt 3)" inside the loading animation.
 */

import type { RetryListener } from './types';

export interface RetryError extends Error {
  status?: number;
  retryAfterMs?: number;
  code?: string;
  headers?: Headers | Record<string, string | string[] | undefined>;
}

export interface RetryOptions {
  signal?: AbortSignal;
  onRetry?: RetryListener;
  /** Override default classification — return true if `err` is retryable. */
  isRetryable?: (err: unknown) => boolean;
  baseDelayMs?: number;
  capDelayMs?: number;
  /** Shared key used to cool down future calls after a provider rate-limit. */
  cooldownKey?: string;
  cooldownMinMs?: number;
  cooldownMaxMs?: number;
  maxAttempts?: number;
}

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_MESSAGE_RE =
  /\b(?:5\d\d|server had an error|internal server error|bad gateway|service unavailable|gateway timeout|temporarily unavailable|overloaded|timeout|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up|rate limit|too many requests)/i;

const cooldowns = ((globalThis as typeof globalThis & { __agentDiagramProviderCooldowns?: Map<string, number> }).__agentDiagramProviderCooldowns ??= new Map<string, number>());

function statusFromMessage(message: string | undefined): number | undefined {
  if (!message) return undefined;
  const match = message.match(/\b(?:HTTP\s*)?(429|5\d\d)\b/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function retryAfterFromHeaders(headers: RetryError['headers']): number | undefined {
  if (!headers) return undefined;
  const raw =
    headers instanceof Headers
      ? headers.get('retry-after')
      : headers['retry-after'] ?? headers['Retry-After'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const secs = Number(value);
  if (!Number.isNaN(secs)) return secs * 1000;
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

export function defaultIsRetryable(err: unknown): boolean {
  const e = err as RetryError;
  const status = typeof e?.status === 'number' ? e.status : statusFromMessage(e?.message);
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
  }
  if (typeof e?.code === 'string' && TRANSIENT_ERROR_CODES.has(e.code)) return true;
  // Network errors / fetch failures
  if (e instanceof TypeError) return true;
  if (typeof e?.message === 'string' && TRANSIENT_MESSAGE_RE.test(e.message)) return true;
  return false;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

function rateLimitCooldownDelay(err: RetryError, fallbackDelayMs: number, opts: RetryOptions): number | null {
  const status = typeof err.status === 'number' ? err.status : statusFromMessage(err.message);
  const message = err.message ?? '';
  const isRateLimited = status === 429 || /\b(rate limit|too many requests|quota)\b/i.test(message);
  if (!isRateLimited) return null;
  // Root Cause vs Logic: the provider-wide cooldown floor is for shared cooldown keys, not per-call retry delays.
  // Without this guard, tests and callers that set retryAfterMs/baseDelayMs still slept for the 15s cooldown minimum.
  if (!opts.cooldownKey) return fallbackDelayMs;
  const min = opts.cooldownMinMs ?? 15_000;
  const max = opts.cooldownMaxMs ?? 10 * 60_000;
  return Math.min(Math.max(fallbackDelayMs, min), max);
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const base = opts.baseDelayMs ?? 2000;
  const cap = opts.capDelayMs ?? 60_000;
  const maxAttempts = opts.maxAttempts ?? 8;
  let attempt = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (opts.cooldownKey) {
      const until = cooldowns.get(opts.cooldownKey) ?? 0;
      const remaining = until - Date.now();
      if (remaining > 0) {
        opts.onRetry?.({ attempt, delayMs: remaining, reason: 'provider cooldown' });
        await delay(remaining, opts.signal);
      }
    }
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      attempt++;
      if (attempt > maxAttempts) throw err;
      const retryError = err as RetryError;
      // Root Cause vs Logic: SDKs surface transient failures inconsistently (status, code, headers, or only a message like "500 The server had an error..."). Normalize the common shapes here so every provider benefits from the same retry behavior.
      const status = typeof retryError.status === 'number' ? retryError.status : statusFromMessage(retryError.message);
      const fromHeader = retryError.retryAfterMs ?? retryAfterFromHeaders(retryError.headers);
      const exponential = Math.min(cap, base * 2 ** (attempt - 1));
      const jittered = fromHeader ?? Math.round(exponential * (0.5 + Math.random() * 0.5));
      const cooldownDelay = rateLimitCooldownDelay(retryError, jittered, opts);
      if (opts.cooldownKey && cooldownDelay !== null) cooldowns.set(opts.cooldownKey, Date.now() + cooldownDelay);
      const reason = status
        ? `HTTP ${status}`
        : retryError.code
        ? retryError.code
        : retryError.message?.slice(0, 80) ?? 'transient error';
      opts.onRetry?.({ attempt, delayMs: cooldownDelay ?? jittered, reason });
      await delay(cooldownDelay ?? jittered, opts.signal);
    }
  }
}

/** Parse a fetch Response error into a RetryError. */
export async function makeRetryError(res: Response): Promise<RetryError> {
  const err: RetryError = new Error(`${res.status} ${res.statusText}`);
  err.status = res.status;
  err.headers = res.headers;
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs)) err.retryAfterMs = secs * 1000;
  }
  try {
    const body = await res.text();
    if (body) err.message = `${err.message}: ${body.slice(0, 240)}`;
  } catch {
    /* ignore */
  }
  return err;
}

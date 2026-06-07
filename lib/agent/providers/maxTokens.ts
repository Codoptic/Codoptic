import type { ProviderId } from './types';

type MaxTokenField = 'max_tokens' | 'max_completion_tokens';

const TOOL_LOOP_DEFAULTS: Record<ProviderId, number> = {
  anthropic: 8192,
  openai: 8192,
  gemini: 8192,
  grok: 8192,
  foundry: 8192,
  local: 4096,
  mistral: 8192,
  deepseek: 8192,
  nvidia: 8192,
  openrouter: 8192,
};

const ENV_OVERRIDE_KEYS: Record<ProviderId, string> = {
  anthropic: 'CLAUDE_MAX_TOKENS',
  openai: 'OPENAI_MAX_TOKENS',
  gemini: 'GEMINI_MAX_TOKENS',
  grok: 'GROK_MAX_TOKENS',
  foundry: 'FOUNDRY_MAX_TOKENS',
  local: 'LOCAL_MODEL_MAX_TOKENS',
  mistral: 'MISTRAL_MAX_TOKENS',
  deepseek: 'DEEPSEEK_MAX_TOKENS',
  nvidia: 'NVIDIA_MAX_TOKENS',
  openrouter: 'OPENROUTER_MAX_TOKENS',
};

const MAX_TOKEN_KEYS: MaxTokenField[] = ['max_tokens', 'max_completion_tokens'];

function positiveEnv(name: string): number | null {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Resolve the output-token cap for the tool-calling path. Order: explicit request →
 * global env override → per-provider env override → provider default. Only used by
 * chatWithTools; the legacy chat() path deliberately omits max_tokens.
 */
export function resolveMaxTokens(opts: { provider: ProviderId; requested?: number }): number {
  if (opts.requested && opts.requested > 0) return opts.requested;
  const global = positiveEnv('CODOPTIC_MAX_OUTPUT_TOKENS');
  if (global) return global;
  const perProvider = positiveEnv(ENV_OVERRIDE_KEYS[opts.provider]);
  if (perProvider) return perProvider;
  return TOOL_LOOP_DEFAULTS[opts.provider] ?? 4096;
}

function messageFor(err: unknown): string | null {
  if (!err) return null;
  if (typeof err === 'string') return err;
  if (err instanceof Error && typeof err.message === 'string') return err.message;
  return null;
}

function quotedKeyInMessage(message: string, key: MaxTokenField): boolean {
  return message.includes(`'${key}'`) || message.includes(`"${key}"`);
}

function errorParam(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const record = err as Record<string, unknown>;
  return typeof record.param === 'string' ? record.param : undefined;
}

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const record = err as Record<string, unknown>;
  return typeof record.code === 'string' ? record.code : undefined;
}

export function indicatesUnsupportedParameter(err: unknown, key: MaxTokenField): boolean {
  const msg = messageFor(err);
  if (msg) {
    const lc = msg.toLowerCase();
    if (lc.includes('unsupported parameter') && quotedKeyInMessage(msg, key)) {
      return true;
    }
  }
  if (errorCode(err) === 'unsupported_parameter') {
    const param = errorParam(err);
    if (param && param.toLowerCase() === key) {
      return true;
    }
  }
  return false;
}

export async function withMaxTokenKeyRetry<T>(
  maxTokens: number,
  call: (key: MaxTokenField) => Promise<T>,
): Promise<T> {
  for (let i = 0; i < MAX_TOKEN_KEYS.length; i += 1) {
    const key = MAX_TOKEN_KEYS[i]!;
    try {
      return await call(key);
    } catch (err) {
      const isLast = i === MAX_TOKEN_KEYS.length - 1;
      if (isLast || !indicatesUnsupportedParameter(err, key)) {
        throw err;
      }
    }
  }
  throw new Error('unreachable');
}

export type { MaxTokenField };

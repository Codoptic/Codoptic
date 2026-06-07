import { NextResponse } from 'next/server';
import { z } from 'zod';
import { makeProvider, PROVIDER_ENV } from '@/lib/agent/providers';
import { methodNotAllowedResponse } from '@/lib/util/http';

export const runtime = 'nodejs';

const Body = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'foundry', 'grok', 'mistral', 'deepseek', 'nvidia', 'openrouter']),
  model: z.string(),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
});

const validateMethodNotAllowed = () =>
  methodNotAllowedResponse('POST with provider, model, and creds is required for validation.', ['POST']);

// Motivation vs Logic: keep the validation contract explicit so callers don't land on Next's default 404 page.
export function GET() {
  return validateMethodNotAllowed();
}

export function HEAD() {
  return validateMethodNotAllowed();
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
  }
  const cfg = parsed.data;
  const apiKey = cfg.apiKey?.trim() || process.env[PROVIDER_ENV[cfg.provider]] || '';
  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      error: `No API key. Set ${PROVIDER_ENV[cfg.provider]} or enter one in the UI.`,
    });
  }
  try {
    const endpoint =
      cfg.endpoint?.trim() ||
      (cfg.provider === 'foundry'
        ? process.env.FOUNDRY_ENDPOINT
        : cfg.provider === 'grok'
        ? process.env.GROK_API_BASE
        : cfg.provider === 'deepseek'
        ? process.env.DEEPSEEK_ENDPOINT
        : cfg.provider === 'nvidia'
        ? process.env.NVIDIA_ENDPOINT
        : cfg.provider === 'openrouter'
        ? process.env.OPENROUTER_ENDPOINT
        : cfg.provider === 'mistral'
        ? process.env.MISTRAL_ENDPOINT
        : undefined);
    const provider = makeProvider(cfg.provider, {
      apiKey,
      endpoint,
    });
    const result = await provider.validate(cfg.model);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg });
  }
}

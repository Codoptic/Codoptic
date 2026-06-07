import { z } from 'zod';
import { runFixClarify } from '@/lib/agent/planning/fixPipeline';
import { makeSseStream } from '@/lib/util/stream';
import { methodNotAllowedResponse } from '@/lib/util/http';
import { PROVIDER_ENV } from '@/lib/agent/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'foundry', 'grok', 'mistral', 'deepseek', 'nvidia', 'openrouter']),
  model: z.string(),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
  dsl: z.string().min(1),
  changeDescription: z.string().min(4),
});

const notAllowed = () =>
  methodNotAllowedResponse(
    'POST with provider, model, dsl, and changeDescription is required to stream fix-clarifying questions.',
    ['POST'],
  );

export function GET() {
  return notAllowed();
}

export function HEAD() {
  return notAllowed();
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.message }), { status: 400 });
  }

  const cfg = parsed.data;
  const apiKey = cfg.apiKey?.trim() || process.env[PROVIDER_ENV[cfg.provider]] || '';
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: `No API key found for ${cfg.provider}. Set ${PROVIDER_ENV[cfg.provider]} in .env.local or enter a key in the UI.`,
      }),
      { status: 400 },
    );
  }

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

  const { stream, send, close } = makeSseStream();
  const ac = new AbortController();
  req.signal.addEventListener('abort', () => ac.abort());

  runFixClarify(
    {
      session: { id: cfg.provider, model: cfg.model, apiKey, endpoint },
      dsl: cfg.dsl,
      changeDescription: cfg.changeDescription,
      signal: ac.signal,
    },
    send,
  )
    .catch((err) => {
      send({ type: 'error', stage: 'pipeline', message: err instanceof Error ? err.message : String(err) });
      send({ type: 'done' });
    })
    .finally(() => close());

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

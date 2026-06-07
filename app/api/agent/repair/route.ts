import { z } from 'zod';
import { validateWithRetry, PROVIDER_ENV } from '@/lib/agent/providers';
import { tryRepair } from '@/lib/agent/planning/repair';
import { makeSseStream } from '@/lib/util/stream';
import { methodNotAllowedResponse } from '@/lib/util/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'foundry', 'grok', 'mistral', 'deepseek', 'nvidia', 'openrouter']),
  model: z.string(),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
  dsl: z.string().min(1),
});

const notAllowed = () =>
  methodNotAllowedResponse('POST with provider, model, and dsl is required.', ['POST']);

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

  const session = { id: cfg.provider, model: cfg.model, apiKey, endpoint };
  const { stream, send, close } = makeSseStream();
  const ac = new AbortController();
  req.signal.addEventListener('abort', () => ac.abort());

  (async () => {
    try {
      send({ type: 'stage', stage: 'validate', status: 'start', message: 'Checking provider credentials…' });
      const v = await validateWithRetry(session, { signal: ac.signal });
      if (!v.ok) {
        send({ type: 'error', stage: 'validate', message: v.error ?? 'Provider validation failed' });
        send({ type: 'done' });
        return;
      }
      send({ type: 'stage', stage: 'validate', status: 'done', message: 'Provider ready' });

      send({ type: 'stage', stage: 'repair', status: 'start', message: 'Analysing and repairing diagram…' });
      const result = await tryRepair(session, cfg.dsl, {
        maxAttempts: 3,
        signal: ac.signal,
        onRetry: (notice) =>
          send({ type: 'retry', stage: 'repair', attempt: notice.attempt, delayMs: notice.delayMs, reason: notice.reason }),
      });
      send({
        type: 'stage',
        stage: 'repair',
        status: 'done',
        message: result.errors === 0 ? 'All errors resolved' : `${result.errors} error(s) remain`,
      });

      send({ type: 'result', dsl: result.dsl });
      send({ type: 'done' });
    } catch (err) {
      send({ type: 'error', stage: 'pipeline', message: err instanceof Error ? err.message : String(err) });
      send({ type: 'done' });
    } finally {
      close();
    }
  })();

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

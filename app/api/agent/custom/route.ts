import { z } from 'zod';
import { runCustomPlan } from '@/lib/agent/planning/customPipeline';
import { makeSseStream } from '@/lib/util/stream';
import { methodNotAllowedResponse } from '@/lib/util/http';
import { PROVIDER_ENV } from '@/lib/agent/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'foundry', 'grok', 'local', 'mistral', 'deepseek', 'nvidia', 'openrouter']),
  model: z.string(),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  prompt: z.string().min(4),
  intentSummary: z.string().optional(),
  answers: z
    .array(
      z.object({
        question_id: z.string(),
        question: z.string(),
        selected_options: z.array(z.string()),
        custom_text: z.string().optional(),
      }),
    )
    .max(20)
    .default([]),
  instructionMode: z.boolean().optional().default(false),
});

const customMethodNotAllowed = () =>
  methodNotAllowedResponse(
    'POST with provider, model, prompt, intent summary, and answers is required to run the custom pipeline.',
    ['POST'],
  );

// Motivation vs Logic: browsers landing on this stream should see its POST-only contract instead of Next's default 404 page.
export function GET() {
  return customMethodNotAllowed();
}

export function HEAD() {
  return customMethodNotAllowed();
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

  runCustomPlan(
    {
      session: { id: cfg.provider, model: cfg.model, apiKey, endpoint, temperature: cfg.temperature, maxTokens: cfg.maxTokens },
      prompt: cfg.prompt,
      intentSummary: cfg.intentSummary,
      answers: cfg.answers,
      instructionMode: cfg.instructionMode,
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

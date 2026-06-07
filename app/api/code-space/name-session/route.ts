import { NextRequest } from 'next/server';
import { z } from 'zod';
import { makeProvider, PROVIDER_ENV } from '@/lib/agent/providers';

const BodySchema = z.object({
  query: z.string().min(1).max(100),
  providerId: z.enum(['openai', 'anthropic', 'gemini', 'grok', 'foundry', 'local', 'mistral', 'deepseek', 'nvidia', 'openrouter']),
  model: z.string().min(1),
  apiKey: z.string().optional().default(''),
  endpoint: z.string().optional(),
  mode: z.enum(['code-space', 'app-planner']).default('code-space'),
});

export async function POST(req: NextRequest) {
  const result = BodySchema.safeParse(await req.json());
  if (!result.success) {
    return Response.json({ error: result.error.message }, { status: 400 });
  }

  const { query, providerId, model, apiKey, endpoint, mode } = result.data;
  const resolvedKey = apiKey || process.env[PROVIDER_ENV[providerId]] || '';

  const maxWords = mode === 'app-planner' ? 2 : 4;
  const namingPrompt = `You are a session title generator.
Given a task description, return ONLY a title of up to ${maxWords} words.
No punctuation. No quotes. Title case.
Examples: "Frontend Chatbox Design", "Fix Auth Bug", "API Rate Limiter"

Task: ${query}`;

  try {
    const provider = makeProvider(providerId, {
      apiKey: resolvedKey,
      endpoint,
    });
    const raw = await provider.chat({
      messages: [{ role: 'user', content: namingPrompt }],
      model,
    });
    const name = raw.trim().replace(/^["']|["']$/g, ''); // strip any surrounding quotes
    return Response.json({ name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: msg }, { status: 500 });
  }
}

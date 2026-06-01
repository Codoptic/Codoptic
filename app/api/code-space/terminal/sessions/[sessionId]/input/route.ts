import { NextResponse } from 'next/server';
import { z } from 'zod';
import { writePtySession } from '@/lib/code-space/runtime/ptySessionManager';

const Body = z.object({
  data: z.string(),
});

export const runtime = 'nodejs';

interface RouteContext {
  params: { sessionId: string };
}

export async function POST(req: Request, context: RouteContext) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const ok = writePtySession(context.params.sessionId, parsed.data.data);
  if (!ok) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

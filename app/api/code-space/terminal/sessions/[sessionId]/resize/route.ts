import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resizePtySession } from '@/lib/code-space/runtime/ptySessionManager';

const Body = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
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

  const ok = resizePtySession(context.params.sessionId, parsed.data.cols, parsed.data.rows);
  if (!ok) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

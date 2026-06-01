import { NextResponse } from 'next/server';
import { disposePtySession } from '@/lib/code-space/runtime/ptySessionManager';

export const runtime = 'nodejs';

interface RouteContext {
  params: { sessionId: string };
}

export async function DELETE(_req: Request, context: RouteContext) {
  disposePtySession(context.params.sessionId);
  return NextResponse.json({ ok: true });
}

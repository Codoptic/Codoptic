import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createPtySession } from '@/lib/code-space/runtime/ptySessionManager';
import { guardPath } from '@/lib/security/pathGuard';

const Body = z.object({
  rootPath: z.string().min(1),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(200).optional(),
});

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const guarded = guardPath(parsed.data.rootPath);
  if (!guarded.ok) {
    return NextResponse.json(
      { error: guarded.reason ?? 'The requested path is not allowed' },
      { status: 400 },
    );
  }

  try {
    const session = createPtySession(
      guarded.resolved,
      parsed.data.cols ?? 80,
      parsed.data.rows ?? 24,
    );
    return NextResponse.json({
      sessionId: session.id,
      shell: session.pty.process,
      cwd: guarded.resolved,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start terminal';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

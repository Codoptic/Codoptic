import { NextResponse } from 'next/server';
import { latestRewind, restoreRewindFiles } from '@/lib/code-space/runtime/rewindStore';
import { guardPath } from '@/lib/security/pathGuard';
import { z } from 'zod';

export const runtime = 'nodejs';

const Body = z.object({ projectRoot: z.string() });

export async function POST(req: Request, { params }: { params: { runId: string } }) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const guarded = guardPath(parsed.data.projectRoot);
  if (!guarded.ok) return NextResponse.json({ error: guarded.reason }, { status: 400 });
  const snapshot = latestRewind(params.runId);
  if (!snapshot) return NextResponse.json({ error: 'No rewind snapshot for this run.' }, { status: 404 });
  const restored = await restoreRewindFiles(guarded.resolved, snapshot);
  return NextResponse.json({ snapshotId: snapshot.id, restored });
}

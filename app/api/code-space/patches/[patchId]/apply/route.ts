import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCodeSpaceStore, getEventStore } from '@/lib/code-space/runtime';
import { applyPatchFiles, PatchApplyError } from '@/lib/code-space/runtime/patchApply';
import { guardPath } from '@/lib/security/pathGuard';

export const runtime = 'nodejs';

const Body = z.object({ rootPath: z.string().min(1).optional() });

export async function POST(req: Request, { params }: { params: { patchId: string } }) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  const store = getCodeSpaceStore();
  const data = await store.read();
  const patch = data.patches.find((item) => item.id === params.patchId) as (typeof data.patches[number] & {
    files?: Array<{ path: string; beforeContent: string; afterContent: string; existedBefore?: boolean; deleted?: boolean }>;
  }) | undefined;
  if (!patch) return NextResponse.json({ error: 'Patch not found' }, { status: 404 });
  if (!patch.files?.length) {
    return NextResponse.json({ error: 'Stored patch does not include applyable file content.' }, { status: 409 });
  }
  if (!parsed.data.rootPath) {
    return NextResponse.json({ error: 'rootPath is required to apply a stored patch.' }, { status: 400 });
  }
  const guarded = guardPath(parsed.data.rootPath);
  if (!guarded.ok) return NextResponse.json({ error: guarded.reason ?? 'Invalid project root' }, { status: 400 });

  try {
    const result = await applyPatchFiles({
      root: guarded.resolved,
      projectId: patch.projectId,
      runId: patch.runId,
      patchId: patch.id,
      files: patch.files,
    });
    const updated = { ...patch, status: 'applied' as const, appliedAt: result.appliedAt };
    await store.upsert('patches', updated);
    await getEventStore().emit({ type: 'patch.applied', projectId: updated.projectId, runId: updated.runId, payload: { patchId: updated.id, filesChanged: result.filesChanged, checkpoint: result.checkpoint } });
    return NextResponse.json({ patch: updated, result });
  } catch (error) {
    if (error instanceof PatchApplyError) {
      return NextResponse.json({ error: error.message, code: error.code, ...(typeof error.details === 'object' && error.details ? error.details : { details: error.details }) }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

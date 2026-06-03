import { NextResponse } from 'next/server';
import { getCodeSpaceStore, getEventStore, ProjectManager, loadFileCheckpoint, restoreFileCheckpoint } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { runId: string } }) {
  const runId = decodeURIComponent(params.runId);
  const data = await getCodeSpaceStore().read();
  const record = data.checkpoints
    .filter((checkpoint) => checkpoint.runId === runId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (!record) return NextResponse.json({ restored: false, error: 'Checkpoint not found for run' }, { status: 404 });

  const project = await new ProjectManager().getProject(record.projectId);
  if (!project) return NextResponse.json({ restored: false, error: 'Project not found' }, { status: 404 });

  try {
    const checkpoint = await loadFileCheckpoint(record.snapshotRef);
    const files = await restoreFileCheckpoint(project.rootPath, checkpoint);
    await getEventStore().emit({ type: 'checkpoint.restored', projectId: project.id, runId, payload: { checkpointId: record.id, files } });
    return NextResponse.json({ restored: true, checkpointId: record.id, restoredAt: Date.now(), files });
  } catch (error) {
    return NextResponse.json({ restored: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

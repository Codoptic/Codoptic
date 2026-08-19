import { NextResponse } from 'next/server';
import { wakeRun } from '@/lib/code-space/runtime/runWorker';
import { getEventStore } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { runId: string } }) {
  const count = await wakeRun(params.runId);
  await getEventStore().emit({ type: 'run.waking', runId: params.runId, payload: { requeued: count } });
  return NextResponse.json({ requeued: count });
}

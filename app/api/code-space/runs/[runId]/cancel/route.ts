import { NextResponse } from 'next/server';
import { RunManager } from '@/lib/code-space/runtime';
import { abortRun } from '@/lib/code-space/runtime/runAbortRegistry';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { runId: string } }) {
  try {
    abortRun(params.runId, 'Run cancelled.');
    return NextResponse.json({ run: await new RunManager().cancelRun(params.runId), aborted: true });
  } catch (error) {
    abortRun(params.runId, 'Run cancelled.');
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), aborted: true }, { status: 404 });
  }
}


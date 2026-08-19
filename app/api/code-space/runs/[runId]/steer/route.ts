import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enqueueSteer } from '@/lib/code-space/runtime/steerQueue';
import { abortRun } from '@/lib/code-space/runtime/runAbortRegistry';
import { getEventStore } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

const Body = z.object({
  text: z.string().min(1),
  mode: z.enum(['queue', 'steer', 'interrupt']).optional().default('queue'),
});

export async function POST(req: Request, { params }: { params: { runId: string } }) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const message = enqueueSteer(params.runId, parsed.data.text, parsed.data.mode);
  if (parsed.data.mode === 'interrupt') abortRun(params.runId, parsed.data.text);
  await getEventStore().emit({ type: 'user.steering', runId: params.runId, payload: message });
  return NextResponse.json({ message });
}

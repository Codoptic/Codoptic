import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCodeSpaceStore, getEventStore } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

const Body = z.object({ reason: z.string().optional() });

export async function POST(req: Request, { params }: { params: { toolCallId: string } }) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const store = getCodeSpaceStore();
  const data = await store.read();
  const toolCall = data.toolCalls.find((item) => item.id === params.toolCallId);
  if (!toolCall) return NextResponse.json({ error: 'Tool call not found' }, { status: 404 });
  const updated = { ...toolCall, approvalStatus: 'rejected' as const, error: parsed.data.reason, updatedAt: Date.now() };
  await store.upsert('toolCalls', updated);
  const { resolveApproval } = await import('@/lib/code-space/runtime/pendingToolApproval');
  resolveApproval(params.toolCallId, 'rejected');
  await getEventStore().emit({ type: 'tool.rejected', runId: updated.runId, payload: { toolCallId: updated.id, reason: parsed.data.reason } });
  return NextResponse.json({ toolCall: updated });
}


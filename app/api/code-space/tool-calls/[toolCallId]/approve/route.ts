import { NextResponse } from 'next/server';
import { getCodeSpaceStore, getEventStore } from '@/lib/code-space/runtime';
import { approveForSession, getParkedToolCall, resolveApproval, sessionApprovalKey, takeParkedToolCall } from '@/lib/code-space/runtime/pendingToolApproval';
import { applyMemoryProposal } from '@/lib/code-space/runtime/memoryManager';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { toolCallId: string } }) {
  const store = getCodeSpaceStore();
  const data = await store.read();
  const toolCall = data.toolCalls.find((item) => item.id === params.toolCallId);
  const parked = getParkedToolCall(params.toolCallId);
  if (!toolCall && !parked) return NextResponse.json({ error: 'Tool call not found' }, { status: 404 });
  const runId = toolCall?.runId ?? parked?.runId ?? '';
  if (toolCall) {
    const updated = { ...toolCall, approvalStatus: 'approved' as const, updatedAt: Date.now() };
    await store.upsert('toolCalls', updated);
  }
  if (parked) {
    approveForSession(sessionApprovalKey(parked.name, parked.input));
    if (parked.name === 'propose_memory_update') {
      const taken = takeParkedToolCall(params.toolCallId);
      const root = typeof parked.input.root === 'string' ? parked.input.root : '';
      if (root && taken) {
        await applyMemoryProposal(root, {
          path: String(taken.input.path ?? ''),
          content: String(taken.input.content ?? ''),
          reason: String(taken.input.reason ?? 'approved memory proposal'),
        });
      }
    }
  }
  const resumed = resolveApproval(params.toolCallId, 'approved');
  await getEventStore().emit({ type: 'tool.approved', runId, payload: { toolCallId: params.toolCallId, resumed } });
  return NextResponse.json({ toolCallId: params.toolCallId, resumed });
}


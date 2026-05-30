import { NextRequest } from 'next/server';
import { AgentRuntime, ResumeValidationRequestSchema } from '@/lib/code-space/runtime/agentRuntime';
import { encodeSseEvent } from '@/lib/code-space/runtime/events';
import { guardPath } from '@/lib/security/pathGuard';

export const runtime = 'nodejs';

/**
 * Resume a code run after the pre-validation diff gate. The original agent run pauses with a
 * `diff_confirmation_required` event; this endpoint runs validation/repair (decision: confirm)
 * or reverts the applied changes (decision: cancel), streaming the same SSE event protocol.
 */
export async function POST(req: NextRequest) {
  const body = ResumeValidationRequestSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });

  const guarded = guardPath(body.data.projectRoot);
  if (!guarded.ok) return Response.json({ error: guarded.reason ?? 'Invalid project path' }, { status: 400 });

  const encoder = new TextEncoder();
  const agentRuntime = new AgentRuntime();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await agentRuntime.resumeValidation(
          { ...body.data, projectRoot: guarded.resolved },
          (event) => controller.enqueue(encoder.encode(encodeSseEvent(event))),
          req.signal,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'agent_error', message, recoverable: true })));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}

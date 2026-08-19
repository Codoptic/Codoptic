import { getEventStore } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { runId: string } }) {
  const lastEventId = req.headers.get('Last-Event-ID') ?? new URL(req.url).searchParams.get('lastEventId') ?? undefined;
  return new Response(getEventStore().stream(params.runId, req.signal, lastEventId ?? undefined), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}


import { getPtySession } from '@/lib/code-space/runtime/ptySessionManager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { sessionId: string };
}

// Motivation vs Logic: Interactive shells need a long-lived byte stream; SSE keeps us inside the
// App Router without a separate WebSocket server while xterm.js renders a real TTY session.
export async function GET(req: Request, context: RouteContext) {
  const sessionId = context.params.sessionId;
  const session = getPtySession(sessionId);
  if (!session) {
    return new Response('Session not found', { status: 404 });
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };
      const onExit = () => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: exit\ndata: {}\n\n`));
        closeStream();
      };

      const dataDisposable = session.pty.onData(onData);
      const exitDisposable = session.pty.onExit(onExit);

      const heartbeat = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 15_000);

      const closeStream = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        dataDisposable.dispose();
        exitDisposable.dispose();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      req.signal.addEventListener('abort', closeStream);
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

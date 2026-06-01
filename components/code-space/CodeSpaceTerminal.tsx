'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

interface CodeSpaceTerminalProps {
  projectRoot?: string;
  active: boolean;
}

type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'error';

// Motivation vs Logic: Code Space needs an interactive PTY (not one-shot exec) so the bottom panel
// behaves like macOS Terminal or Windows PowerShell while still respecting path guards server-side.
export function CodeSpaceTerminal({ projectRoot, active }: CodeSpaceTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const teardown = useCallback(async () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    if (sessionId) {
      await fetch(`/api/code-space/terminal/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitAddonRef.current = null;
  }, []);

  const postResize = useCallback(async (sessionId: string) => {
    const term = terminalRef.current;
    if (!term) return;
    await fetch(`/api/code-space/terminal/sessions/${sessionId}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols: term.cols, rows: term.rows }),
    }).catch(() => undefined);
  }, []);

  const connect = useCallback(async () => {
    if (!projectRoot || !containerRef.current) return;
    await teardown();

    const fitAddon = new FitAddon();
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      theme: {
        background: '#0c0c0c',
        foreground: '#d4d4d4',
        cursor: '#e6edf3',
        selectionBackground: '#264f78',
      },
      scrollback: 5000,
    });

    fitAddonRef.current = fitAddon;
    terminalRef.current = term;
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    setStatus('connecting');
    setStatusMessage(null);

    try {
      const response = await fetch('/api/code-space/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rootPath: projectRoot,
          cols: term.cols,
          rows: term.rows,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? 'Failed to start terminal session');
      }

      const sessionId = payload.sessionId as string;
      sessionIdRef.current = sessionId;

      const eventSource = new EventSource(`/api/code-space/terminal/sessions/${sessionId}/stream`);
      eventSourceRef.current = eventSource;

      eventSource.onmessage = (event) => {
        try {
          const chunk = JSON.parse(event.data) as string;
          term.write(chunk);
        } catch {
          term.write(event.data);
        }
      };
      eventSource.addEventListener('exit', () => {
        term.writeln('\r\n\x1b[90m[process exited]\x1b[0m');
        setStatus('idle');
      });
      eventSource.onerror = () => {
        if (eventSource.readyState === EventSource.CLOSED) {
          setStatus('error');
          setStatusMessage('Terminal stream disconnected.');
        }
      };

      term.onData((data) => {
        const activeSessionId = sessionIdRef.current;
        if (!activeSessionId) return;
        void fetch(`/api/code-space/terminal/sessions/${activeSessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        });
      });

      term.onResize(({ cols, rows }) => {
        const activeSessionId = sessionIdRef.current;
        if (!activeSessionId) return;
        void fetch(`/api/code-space/terminal/sessions/${activeSessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols, rows }),
        });
      });

      setStatus('connected');
      term.focus();
      await postResize(sessionId);
    } catch (error) {
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : String(error));
      await teardown();
    }
  }, [postResize, projectRoot, teardown]);

  useEffect(() => {
    if (!active || !projectRoot) {
      void teardown();
      setStatus('idle');
      return undefined;
    }

    void connect();

    const container = containerRef.current;
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && container
        ? new ResizeObserver(() => {
            fitAddonRef.current?.fit();
            const sessionId = sessionIdRef.current;
            if (sessionId) void postResize(sessionId);
          })
        : null;
    if (container) resizeObserver?.observe(container);

    return () => {
      resizeObserver?.disconnect();
      void teardown();
    };
  }, [active, connect, postResize, projectRoot, teardown]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded border border-[#232323] bg-[#0c0c0c]">
      <div className="flex items-center justify-between border-b border-[#232323] px-2 py-1 text-[10px] text-[#8b8b8b]">
        <span>
          {projectRoot ? 'Integrated shell' : 'Open a project to use the terminal'}
          {status === 'connected' && projectRoot ? ' · connected' : null}
          {status === 'connecting' ? ' · starting…' : null}
        </span>
        {projectRoot && (
          <button
            type="button"
            onClick={() => void connect()}
            className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[9px] uppercase tracking-widest text-[#c6c6c6] hover:text-white"
          >
            Restart
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1 p-1">
        <div
          ref={containerRef}
          className={`h-full w-full ${projectRoot ? '' : 'pointer-events-none opacity-40'}`}
          aria-label="Code Space terminal"
        />
        {!projectRoot && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[#8b8b8b]">
            Open a project folder to launch your system shell here.
          </div>
        )}
      </div>
      {statusMessage && <p className="border-t border-[#232323] px-2 py-1 text-[10px] text-[#ff7b72]">{statusMessage}</p>}
    </div>
  );
}

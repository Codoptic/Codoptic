import { randomUUID } from 'node:crypto';
import * as pty from '@lydell/node-pty';
import os from 'node:os';

export interface PtySession {
  id: string;
  rootPath: string;
  pty: pty.IPty;
  createdAt: number;
  lastActiveAt: number;
  outputBuffer: string[];
  exitCode?: number;
  exitedAt?: number;
}

const MAX_SESSIONS = 16;
const IDLE_TTL_MS = 30 * 60 * 1000;

const globalStore = globalThis as typeof globalThis & {
  __codopticPtySessions?: Map<string, PtySession>;
  __codopticPtySweepTimer?: ReturnType<typeof setInterval>;
};

function sessionMap(): Map<string, PtySession> {
  if (!globalStore.__codopticPtySessions) {
    globalStore.__codopticPtySessions = new Map();
  }
  return globalStore.__codopticPtySessions;
}

function ensureSweepTimer() {
  if (globalStore.__codopticPtySweepTimer) return;
  globalStore.__codopticPtySweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessionMap()) {
      if (now - session.lastActiveAt > IDLE_TTL_MS) {
        disposePtySession(id);
      }
    }
  }, 60_000);
  globalStore.__codopticPtySweepTimer.unref?.();
}

export function resolveInteractiveShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC?.trim() || 'powershell.exe';
  }
  const shell = process.env.SHELL?.trim();
  if (shell) return shell;
  return os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

export function createPtySession(rootPath: string, cols = 80, rows = 24): PtySession {
  ensureSweepTimer();
  const map = sessionMap();
  if (map.size >= MAX_SESSIONS) {
    const oldest = [...map.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
    if (oldest) disposePtySession(oldest.id);
  }

  const shell = resolveInteractiveShell();
  const shellLower = shell.toLowerCase();
  const shellArgs =
    process.platform === 'win32'
      ? shellLower.includes('powershell')
        ? ['-NoLogo']
        : []
      : ['-l'];
  const id = randomUUID();
  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: rootPath,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as Record<string, string>,
  });

  const session: PtySession = {
    id,
    rootPath,
    pty: ptyProcess,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    outputBuffer: [],
  };
  ptyProcess.onData((chunk) => {
    session.outputBuffer.push(chunk);
    if (session.outputBuffer.join('').length > 512_000) {
      session.outputBuffer = [session.outputBuffer.join('').slice(-512_000)];
    }
    session.lastActiveAt = Date.now();
  });
  ptyProcess.onExit((event) => {
    session.exitCode = event.exitCode;
    session.exitedAt = Date.now();
    session.lastActiveAt = Date.now();
  });
  map.set(id, session);
  return session;
}

export function getPtySession(sessionId: string): PtySession | undefined {
  const session = sessionMap().get(sessionId);
  if (session) session.lastActiveAt = Date.now();
  return session;
}

export function touchPtySession(sessionId: string): void {
  const session = sessionMap().get(sessionId);
  if (session) session.lastActiveAt = Date.now();
}

export function resizePtySession(sessionId: string, cols: number, rows: number): boolean {
  const session = getPtySession(sessionId);
  if (!session) return false;
  session.pty.resize(Math.max(2, cols), Math.max(1, rows));
  return true;
}

export function writePtySession(sessionId: string, data: string): boolean {
  const session = getPtySession(sessionId);
  if (!session) return false;
  session.pty.write(data);
  return true;
}

export function readPtySession(sessionId: string, maxChars = 12_000, clear = false): { output: string; exitCode?: number; exited: boolean } | null {
  const session = getPtySession(sessionId);
  if (!session) return null;
  const output = session.outputBuffer.join('').slice(-Math.max(1, maxChars));
  if (clear) session.outputBuffer = [];
  return { output, exitCode: session.exitCode, exited: session.exitedAt !== undefined };
}

export async function waitForPtySession(
  sessionId: string,
  options: { pattern?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<{ output: string; matched: boolean; exited: boolean; exitCode?: number } | null> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const pattern = options.pattern ? new RegExp(options.pattern, 'i') : null;
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = readPtySession(sessionId, 24_000);
    if (!snapshot) return null;
    const matched = pattern ? pattern.test(snapshot.output) : snapshot.exited;
    if (matched || snapshot.exited) return { ...snapshot, matched };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const snapshot = readPtySession(sessionId, 24_000);
  return snapshot ? { ...snapshot, matched: false } : null;
}

export function signalPtySession(sessionId: string, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): boolean {
  const session = getPtySession(sessionId);
  if (!session) return false;
  if (signal === 'SIGINT') session.pty.write('\x03');
  else session.pty.kill(signal);
  return true;
}

export function disposePtySession(sessionId: string): void {
  const session = sessionMap().get(sessionId);
  if (!session) return;
  try {
    session.pty.kill();
  } catch {
    // Process may already be gone.
  }
  sessionMap().delete(sessionId);
}

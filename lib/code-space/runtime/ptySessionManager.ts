import { randomUUID } from 'node:crypto';
import * as pty from '@lydell/node-pty';
import os from 'node:os';

export interface PtySession {
  id: string;
  rootPath: string;
  pty: pty.IPty;
  createdAt: number;
  lastActiveAt: number;
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
  };
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

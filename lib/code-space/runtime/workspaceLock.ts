const locks = new Map<string, { runId: string; paths: Set<string> }>();

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function acquireWorkspaceLock(root: string, runId: string, paths: string[] = ['*']): void {
  const key = normalizeRoot(root);
  const existing = locks.get(key);
  if (existing && existing.runId !== runId) {
    throw new Error(`Workspace is locked by run ${existing.runId}.`);
  }
  locks.set(key, { runId, paths: new Set(paths) });
}

export function releaseWorkspaceLock(root: string, runId: string): void {
  const key = normalizeRoot(root);
  const existing = locks.get(key);
  if (existing?.runId === runId) locks.delete(key);
}

export function workspaceLockOwner(root: string): string | undefined {
  return locks.get(normalizeRoot(root))?.runId;
}

export function pathsOverlap(left: string[], right: string[]): boolean {
  if (left.includes('*') || right.includes('*')) return true;
  return left.some((path) => right.some((other) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`)));
}

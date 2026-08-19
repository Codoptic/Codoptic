import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface RewindSnapshot {
  id: string;
  runId: string;
  createdAt: number;
  files: Record<string, string>;
  conversationDigest: string;
}

const snapshots = new Map<string, RewindSnapshot[]>();

export function recordRewindSnapshot(snapshot: RewindSnapshot): void {
  const list = snapshots.get(snapshot.runId) ?? [];
  list.push(snapshot);
  snapshots.set(snapshot.runId, list);
}

export function latestRewind(runId: string): RewindSnapshot | undefined {
  return snapshots.get(runId)?.at(-1);
}

export function listRewinds(runId: string): RewindSnapshot[] {
  return [...(snapshots.get(runId) ?? [])];
}

export async function restoreRewindFiles(root: string, snapshot: RewindSnapshot): Promise<string[]> {
  const restored: string[] = [];
  for (const [relative, content] of Object.entries(snapshot.files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
    restored.push(relative);
  }
  return restored;
}

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeContextPath } from './repoMap';

export interface FileFingerprint {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
}

export async function fingerprintFile(root: string, relativePath: string): Promise<FileFingerprint | null> {
  const normalized = normalizeContextPath(relativePath);
  const absolute = path.join(root, normalized);
  try {
    const [stat, content] = await Promise.all([fs.stat(absolute), fs.readFile(absolute)]);
    return {
      path: normalized,
      hash: createHash('sha256').update(content).digest('hex'),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

export async function collectDirtyFiles(root: string, known: Map<string, string>, candidates: string[]): Promise<FileFingerprint[]> {
  const dirty: FileFingerprint[] = [];
  for (const candidate of candidates) {
    const fingerprint = await fingerprintFile(root, candidate);
    if (!fingerprint) continue;
    const previous = known.get(fingerprint.path);
    if (previous && previous !== fingerprint.hash) dirty.push(fingerprint);
    known.set(fingerprint.path, fingerprint.hash);
  }
  return dirty;
}

export function formatDirtyAttachment(files: FileFingerprint[]): string {
  if (!files.length) return 'Dirty files: none since last turn.';
  return [
    'Dirty files (re-read before editing; hash-at-read must match hash-at-apply):',
    ...files.map((file) => `- ${file.path} sha256=${file.hash.slice(0, 12)} size=${file.size}`),
  ].join('\n');
}

export function assertFreshHash(expected: string | undefined, actual: string, filePath: string): void {
  if (expected && expected !== actual) {
    throw new Error(`STALE_FILE ${filePath}: disk hash ${actual.slice(0, 12)} does not match read hash ${expected.slice(0, 12)}. Re-read before applying.`);
  }
}

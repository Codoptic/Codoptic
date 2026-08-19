import { promises as fs } from 'node:fs';
import { NextResponse } from 'next/server';
import fg from 'fast-glob';
import { z } from 'zod';
import { pickerIgnoreGlobs } from '@/lib/code-space/mentions/ignorePolicy';
import { defaultRepoPath, guardPath } from '@/lib/security/pathGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Motivation vs Logic: A real mention picker can't rely on the user-expanded tree to know what's
// in `backend/`. We need a project-wide listing of files (and the folders we can derive from
// them), refreshed on demand. fast-glob is fast, but scanning a large repo on every keystroke
// would be wasteful, so we cache by `rootPath` with a short TTL and provide an explicit
// `?refresh=true` escape hatch. The picker policy lives in `pickerIgnoreGlobs` — separate from
// the agent scanner — so high-value folders like `tests/`, `docs/`, `scripts/` stay in the index.

const Query = z.object({
  rootPath: z.string().optional(),
  refresh: z.enum(['true', 'false']).optional(),
});

interface MentionIndexFile {
  path: string;
  size: number;
  mtime: number;
}

interface MentionIndexPayload {
  rootPath: string;
  generatedAt: number;
  files: MentionIndexFile[];
  truncated: boolean;
}

const SCAN_CAP = 20_000;
const CACHE_TTL_MS = 10_000;
const cache: Map<string, { generatedAt: number; payload: MentionIndexPayload }> =
  ((globalThis as Record<string, unknown>).__mentionIndexCache as
    | Map<string, { generatedAt: number; payload: MentionIndexPayload }>
    | undefined) ?? new Map();
(globalThis as Record<string, unknown>).__mentionIndexCache = cache;

async function scanProject(rootPath: string): Promise<MentionIndexPayload> {
  const ignore = pickerIgnoreGlobs();
  const matches = await fg(['**/*'], {
    cwd: rootPath,
    onlyFiles: true,
    dot: true,
    absolute: false,
    unique: true,
    followSymbolicLinks: false,
    ignore,
    suppressErrors: true,
    stats: true,
  });

  const files: MentionIndexFile[] = [];
  for (const entry of matches) {
    if (files.length >= SCAN_CAP) break;
    const stats = entry.stats;
    files.push({
      path: entry.path.replace(/\\/g, '/'),
      size: stats?.size ?? 0,
      mtime: stats?.mtimeMs ?? 0,
    });
  }

  return {
    rootPath,
    generatedAt: Date.now(),
    files,
    truncated: matches.length >= SCAN_CAP,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    rootPath: url.searchParams.get('rootPath') ?? undefined,
    refresh: url.searchParams.get('refresh') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query' }, { status: 400 });
  }

  const rawRoot = parsed.data.rootPath ?? defaultRepoPath();
  const guarded = guardPath(rawRoot);
  if (!guarded.ok) {
    return NextResponse.json({ error: guarded.reason ?? 'Invalid root path' }, { status: 400 });
  }

  try {
    const stat = await fs.stat(guarded.resolved);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: 'Project root is not a directory' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'Project root not found' }, { status: 404 });
  }

  const cacheKey = guarded.resolved;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  const force = parsed.data.refresh === 'true';
  if (!force && cached && now - cached.generatedAt < CACHE_TTL_MS) {
    return NextResponse.json(cached.payload, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  try {
    const payload = await scanProject(guarded.resolved);
    cache.set(cacheKey, { generatedAt: payload.generatedAt, payload });
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

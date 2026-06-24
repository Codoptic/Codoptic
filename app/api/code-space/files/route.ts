import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isBrowserHiddenByDefault } from '@/lib/agent/repo/ignoreDefaults';
import { resolveCodeSpaceChild } from '@/lib/code-space/runtime/filePaths';

export const runtime = 'nodejs';

const Query = z.object({
  rootPath: z.string().optional(),
  path: z.string().optional(),
  revealHidden: z.enum(['true', 'false']).optional(),
});

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'),
    rootPath: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    action: z.literal('write'),
    rootPath: z.string().min(1),
    path: z.string().min(1),
    content: z.string(),
    expectedHash: z.string().optional(),
  }),
  z.object({
    action: z.literal('mkdir'),
    rootPath: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    action: z.literal('delete'),
    rootPath: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    action: z.literal('rename'),
    rootPath: z.string().min(1),
    path: z.string().min(1),
    nextPath: z.string().min(1),
  }),
  z.object({
    action: z.literal('duplicate'),
    rootPath: z.string().min(1),
    path: z.string().min(1),
    nextPath: z.string().min(1),
  }),
]);

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    rootPath: url.searchParams.get('rootPath') ?? undefined,
    path: url.searchParams.get('path') ?? undefined,
    revealHidden: url.searchParams.get('revealHidden') ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query' }, { status: 400 });

  const resolved = resolveCodeSpaceChild(parsed.data.rootPath ?? '', parsed.data.path ?? '');
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  try {
    const dirents = await fs.readdir(resolved.child, { withFileTypes: true });
    const revealHidden = parsed.data.revealHidden === 'true';
    const entries = await Promise.all(
      dirents
        .filter((dirent) => {
          if (!dirent.isDirectory() && !dirent.isFile()) return false;
          return revealHidden || !isBrowserHiddenByDefault(dirent.name, dirent.isDirectory());
        })
        .map(async (dirent) => {
          const absolute = path.join(resolved.child, dirent.name);
          const stat = await fs.stat(absolute);
          const rel = path.relative(resolved.root, absolute).replace(/\\/g, '/');
          return {
            name: dirent.name,
            path: rel,
            type: dirent.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            hidden: isBrowserHiddenByDefault(dirent.name, dirent.isDirectory()),
          };
        }),
    );

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ rootPath: resolved.root, path: resolved.rel, entries });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });

  const resolved = resolveCodeSpaceChild(parsed.data.rootPath, parsed.data.path);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  if (parsed.data.action === 'read') {
    try {
      const buffer = await fs.readFile(resolved.child);
      if (buffer.includes(0)) return NextResponse.json({ error: 'Binary files cannot be opened in Code Space yet.' }, { status: 415 });
      const content = buffer.toString('utf8');
      return NextResponse.json({
        path: resolved.rel,
        content,
        hash: sha256(content),
        modifiedAt: (await fs.stat(resolved.child)).mtimeMs,
      });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  if (parsed.data.action === 'mkdir') {
    try {
      await fs.mkdir(resolved.child, { recursive: true });
      return NextResponse.json({ path: resolved.rel, createdAt: Date.now() });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  if (parsed.data.action === 'delete') {
    try {
      await fs.rm(resolved.child, { recursive: true, force: false });
      return NextResponse.json({ path: resolved.rel, deletedAt: Date.now() });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  if (parsed.data.action === 'rename' || parsed.data.action === 'duplicate') {
    const target = resolveCodeSpaceChild(parsed.data.rootPath, parsed.data.nextPath);
    if (!target.ok) return NextResponse.json({ error: target.error }, { status: 400 });
    try {
      await fs.mkdir(path.dirname(target.child), { recursive: true });
      if (parsed.data.action === 'rename') {
        await fs.rename(resolved.child, target.child);
        return NextResponse.json({ path: resolved.rel, nextPath: target.rel, renamedAt: Date.now() });
      }
      await fs.cp(resolved.child, target.child, { recursive: true, errorOnExist: true });
      return NextResponse.json({ path: resolved.rel, nextPath: target.rel, duplicatedAt: Date.now() });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  try {
    let currentHash: string | null = null;
    try {
      currentHash = sha256(await fs.readFile(resolved.child, 'utf8'));
    } catch {
      currentHash = null;
    }
    if (parsed.data.expectedHash && currentHash && parsed.data.expectedHash !== currentHash) {
      return NextResponse.json(
        {
          error: 'File changed externally. Review the latest content before overwriting.',
          code: 'CONFLICT',
          currentHash,
        },
        { status: 409 },
      );
    }
    await fs.mkdir(path.dirname(resolved.child), { recursive: true });
    await fs.writeFile(resolved.child, parsed.data.content, 'utf8');
    return NextResponse.json({ path: resolved.rel, hash: sha256(parsed.data.content), savedAt: Date.now() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

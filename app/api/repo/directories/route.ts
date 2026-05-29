import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { defaultRepoPath, resolveBrowsePath } from '@/lib/security/pathGuard';
import { normalizeIgnoredFolders } from '@/lib/agent/repo/repoScanner';
import { isHiddenByDefault } from '@/lib/agent/repo/ignoreDefaults';

export const runtime = 'nodejs';

const Body = z.object({
  rootPath: z.string().optional(),
  parent: z.string().optional(),
});

// Motivation vs Logic: the folder browser must show the same view the agent will scan, so we
// defer to the shared `isHiddenByDefault` matcher in `lib/agent/ignoreDefaults.ts`. The only
// extra rule here is the Codoptic self-folder, which is dynamic (depends on `process.cwd()`)
// and therefore lives outside the static pattern list.
const SELF_ROOT = path.resolve(process.cwd());

function childPath(root: string, rel: string): string | null {
  const [normalized] = normalizeIgnoredFolders([rel]);
  if (rel && !normalized) return null;
  const resolved = path.resolve(root, normalized ?? '.');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const browse = resolveBrowsePath(parsed.data.rootPath ?? defaultRepoPath());
  if (!browse.ok) {
    return NextResponse.json({ error: browse.reason, resolved: browse.resolved }, { status: 400 });
  }

  const relParent = parsed.data.parent ?? '';
  const absParent = childPath(browse.browseRoot, relParent);
  if (!absParent) {
    return NextResponse.json({ error: 'Invalid folder path' }, { status: 400 });
  }

  try {
    const dirents = await fs.readdir(absParent, { withFileTypes: true });

    const entries = dirents
      .filter((dirent) => {
        const isDir = dirent.isDirectory();
        if (!isDir && !dirent.isFile()) return false;
        // Root Cause vs Logic: prefix searches need to stay folder-only so a trailing `~`
        // behaves like "show me sibling directories starting with this stem" instead of
        // mixing in files that happen to share the same prefix.
        if (browse.prefix && !relParent) {
          if (!isDir) return false;
          if (!dirent.name.startsWith(browse.prefix)) return false;
        }
        if (isHiddenByDefault(dirent.name, isDir)) return false;
        // Skip the Codoptic app folder itself so users never accidentally
        // pipe our own source back into the agent when scanning a parent dir.
        const abs = path.resolve(absParent, dirent.name);
        if (abs === SELF_ROOT) return false;
        return true;
      })
      .map((dirent) => {
        const abs = path.resolve(absParent, dirent.name);
        const rel = path.relative(browse.browseRoot, abs).replace(/\\/g, '/');
        return {
          name: dirent.name,
          path: rel,
          type: dirent.isDirectory() ? ('dir' as const) : ('file' as const),
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({
      root: browse.browseRoot,
      resolved: browse.resolved,
      prefix: browse.prefix,
      parent: normalizeIgnoredFolders([relParent])[0] ?? '',
      entries,
      // Kept for older clients that still read `directories`; new UI uses `entries`.
      directories: entries.filter((entry) => entry.type === 'dir').map(({ name, path: p }) => ({ name, path: p })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

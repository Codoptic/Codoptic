import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { isBrowserHiddenByDefault } from '@/lib/agent/repo/ignoreDefaults';
import { ProjectManager } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { projectId: string } }) {
  const project = await new ProjectManager().getProject(params.projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const url = new URL(req.url);
  const relPath = url.searchParams.get('path') ?? '';
  const revealHidden = url.searchParams.get('revealHidden') === 'true';
  const target = path.resolve(project.rootPath, relPath);
  if (target !== project.rootPath && !target.startsWith(`${project.rootPath}${path.sep}`)) {
    return NextResponse.json({ error: 'Path escapes project root' }, { status: 400 });
  }

  try {
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const entries = await Promise.all(
      dirents
        .filter((dirent) => (dirent.isDirectory() || dirent.isFile()) && (revealHidden || !isBrowserHiddenByDefault(dirent.name, dirent.isDirectory())))
        .map(async (dirent) => {
          const absolute = path.join(target, dirent.name);
          const stat = await fs.stat(absolute);
          return {
            name: dirent.name,
            path: path.relative(project.rootPath, absolute).replace(/\\/g, '/'),
            type: dirent.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            hidden: isBrowserHiddenByDefault(dirent.name, dirent.isDirectory()),
          };
        }),
    );
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return NextResponse.json({ entries });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}


import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

export const CODE_SPACE_CONTEXT_GLOBS = [
  '**/*.{ts,tsx,js,jsx,json,md,mdx,rst,adoc,css,scss,py,go,rs,java,kt,php,rb,sh,yml,yaml,toml}',
  '!node_modules/**',
  '!.git/**',
  '!dist/**',
  '!build/**',
  '!.next/**',
  '!coverage/**',
  '!__pycache__/**',
];

export function normalizeContextPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '');
}

export function isPathInside(root: string, relativePath: string): boolean {
  const target = path.resolve(root, relativePath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export async function listRepositoryFiles(root: string): Promise<string[]> {
  return (
    await fg(CODE_SPACE_CONTEXT_GLOBS, {
      cwd: root,
      onlyFiles: true,
      dot: true,
      absolute: false,
      unique: true,
    })
  ).map(normalizeContextPath);
}

export async function safeReadTextFile(root: string, relativePath: string): Promise<string | null> {
  const normalized = normalizeContextPath(relativePath);
  if (!normalized || !isPathInside(root, normalized)) return null;
  try {
    return await fs.readFile(path.resolve(root, normalized), 'utf8');
  } catch {
    return null;
  }
}

export async function pathExists(root: string, relativePath: string): Promise<boolean> {
  const normalized = normalizeContextPath(relativePath);
  if (!isPathInside(root, normalized)) return false;
  try {
    await fs.access(path.resolve(root, normalized));
    return true;
  } catch {
    return false;
  }
}

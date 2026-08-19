import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function worktreePath(root: string, packageId: string): string {
  const safe = packageId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(root, '.agent', 'worktrees', safe);
}

export function addWorktree(root: string, packageId: string): { ok: boolean; path: string; output: string } {
  const dest = worktreePath(root, packageId);
  const result = spawnSync('git', ['worktree', 'add', dest, 'HEAD'], { cwd: root, encoding: 'utf8' });
  return { ok: result.status === 0, path: dest, output: `${result.stdout}${result.stderr}` };
}

export function removeWorktree(root: string, packageId: string): boolean {
  const dest = worktreePath(root, packageId);
  const result = spawnSync('git', ['worktree', 'remove', '--force', dest], { cwd: root, encoding: 'utf8' });
  return result.status === 0;
}

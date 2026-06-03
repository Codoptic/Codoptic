import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createUnifiedDiff, validateSyntaxLightweight } from '@/lib/code-space/agent/editBlocks';
import { createFileCheckpoint } from './checkpointManager';
import { normalizeContextPath } from './repoMap';

export interface PatchApplyFile {
  path: string;
  beforeContent: string;
  afterContent: string;
  existedBefore?: boolean;
  deleted?: boolean;
}

export interface PatchApplyConflict {
  path: string;
  line: number;
  column: number;
  currentPreview: string;
  expectedPreview: string;
}

export interface PatchApplyResult {
  status: 'applied' | 'already_applied';
  filesChanged: string[];
  alreadyApplied: string[];
  unifiedDiff: string;
  checkpoint: Awaited<ReturnType<typeof createFileCheckpoint>> | null;
  appliedAt: number;
}

export class PatchApplyError extends Error {
  constructor(
    message: string,
    readonly code: 'PATCH_CONFLICT' | 'AST_PREVALIDATION_FAILED' | 'INVALID_PATH',
    readonly details?: unknown,
    readonly status = 409,
  ) {
    super(message);
  }
}

export function resolvePatchTarget(root: string, relativePath: string): string {
  const normalized = normalizeContextPath(relativePath);
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new PatchApplyError(`Invalid patch path: ${relativePath}`, 'INVALID_PATH', undefined, 400);
  }
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new PatchApplyError(`Path escapes project root: ${relativePath}`, 'INVALID_PATH', undefined, 400);
  }
  return target;
}

function firstDifference(a: string, b: string): { index: number; line: number; column: number } | null {
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    if (a[index] === b[index]) continue;
    const prefix = a.slice(0, index);
    const lines = prefix.split('\n');
    const lastLine = lines[lines.length - 1] ?? '';
    return { index, line: lines.length, column: lastLine.length + 1 };
  }
  return null;
}

export async function applyPatchFiles({
  root,
  projectId,
  runId,
  patchId,
  files,
}: {
  root: string;
  projectId: string;
  runId?: string;
  patchId: string;
  files: PatchApplyFile[];
}): Promise<PatchApplyResult> {
  const alreadyApplied: string[] = [];
  const conflicts: PatchApplyConflict[] = [];

  for (const file of files) {
    const target = resolvePatchTarget(root, file.path);
    let current = '';
    let fileExists = true;
    try {
      current = await fs.readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fileExists = false;
    }

    if (file.existedBefore === false && fileExists) {
      const diff = firstDifference(current, file.beforeContent) ?? { index: 0, line: 1, column: 1 };
      conflicts.push({
        path: file.path,
        line: diff.line,
        column: diff.column,
        currentPreview: current.slice(Math.max(0, diff.index - 160), diff.index + 160),
        expectedPreview: '(file did not exist when patch was proposed)',
      });
      continue;
    }

    if (file.existedBefore === true && !fileExists) {
      conflicts.push({
        path: file.path,
        line: 1,
        column: 1,
        currentPreview: '(file is missing)',
        expectedPreview: file.beforeContent.slice(0, 320),
      });
      continue;
    }

    if (file.deleted) {
      if (!fileExists) {
        alreadyApplied.push(file.path);
        continue;
      }
      if (current !== file.beforeContent) {
        const diff = firstDifference(current, file.beforeContent) ?? { index: 0, line: 1, column: 1 };
        conflicts.push({
          path: file.path,
          line: diff.line,
          column: diff.column,
          currentPreview: current.slice(Math.max(0, diff.index - 160), diff.index + 160),
          expectedPreview: file.beforeContent.slice(Math.max(0, diff.index - 160), diff.index + 160),
        });
      }
      continue;
    }

    if (current === file.afterContent && (file.existedBefore !== false || fileExists)) {
      alreadyApplied.push(file.path);
      continue;
    }
    if (file.existedBefore !== false && current !== file.beforeContent) {
      const diff = firstDifference(current, file.beforeContent) ?? { index: 0, line: 1, column: 1 };
      conflicts.push({
        path: file.path,
        line: diff.line,
        column: diff.column,
        currentPreview: current.slice(Math.max(0, diff.index - 160), diff.index + 160),
        expectedPreview: file.beforeContent.slice(Math.max(0, diff.index - 160), diff.index + 160),
      });
    }
  }

  if (conflicts.length) {
    throw new PatchApplyError(
      'Patch conflict. The file changed since the proposal was created. Refresh the diff or regenerate the patch from the latest file content.',
      'PATCH_CONFLICT',
      { conflicts, alreadyApplied },
      409,
    );
  }

  if (alreadyApplied.length === files.length) {
    return { status: 'already_applied', filesChanged: [], alreadyApplied, unifiedDiff: '', checkpoint: null, appliedAt: Date.now() };
  }

  const filesToWrite = files.filter((file) => !alreadyApplied.includes(file.path));
  const checkpoint = await createFileCheckpoint({
    projectId,
    projectRoot: root,
    runId,
    reason: `before applying ${patchId}`,
    files: filesToWrite.map((file) => file.path),
  });

  for (const file of filesToWrite) {
    if (file.deleted) continue;
    const diagnostics = validateSyntaxLightweight(file.path, file.afterContent);
    if (diagnostics.length) {
      throw new PatchApplyError(`Patch failed syntax pre-validation in ${file.path}.`, 'AST_PREVALIDATION_FAILED', { diagnostics, checkpoint }, 422);
    }
  }

  for (const file of filesToWrite) {
    const target = resolvePatchTarget(root, file.path);
    if (file.deleted) {
      await fs.rm(target, { force: false, recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.afterContent, 'utf8');
  }

  return {
    status: 'applied',
    filesChanged: filesToWrite.map((file) => file.path),
    alreadyApplied,
    unifiedDiff: filesToWrite.map((file) => createUnifiedDiff(file.path, file.beforeContent, file.deleted ? '' : file.afterContent)).join('\n'),
    checkpoint,
    appliedAt: Date.now(),
  };
}

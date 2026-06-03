import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applyGroupedEditBlocks, validateSyntaxLightweight } from '@/lib/code-space/agent/editBlocks';
import { applyPatchFiles, PatchApplyError } from '@/lib/code-space/runtime/patchApply';
import { guardPath } from '@/lib/security/pathGuard';

export const runtime = 'nodejs';

const PatchFile = z.object({
  path: z.string().min(1),
  beforeContent: z.string(),
  afterContent: z.string(),
  existedBefore: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

const EditBlock = z.object({
  path: z.string().min(1),
  search: z.string(),
  replace: z.string(),
  reason: z.string().default('Surgical edit'),
});

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('preview-edit-blocks'),
    rootPath: z.string().min(1),
    projectId: z.string().min(1),
    runId: z.string().optional(),
    patchId: z.string().optional(),
    edits: z.array(EditBlock).min(1),
  }),
  z.object({
    action: z.literal('apply'),
    rootPath: z.string().min(1),
    projectId: z.string().min(1),
    runId: z.string().optional(),
    patchId: z.string().min(1),
    files: z.array(PatchFile).min(1),
  }),
]);

function resolveInside(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  return target;
}

async function readCurrentFiles(root: string, filePaths: string[]): Promise<{ contents: Record<string, string>; exists: Record<string, boolean> }> {
  const files: Record<string, string> = {};
  const exists: Record<string, boolean> = {};
  for (const filePath of filePaths) {
    const target = resolveInside(root, filePath);
    try {
      files[filePath] = await fs.readFile(target, 'utf8');
      exists[filePath] = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      files[filePath] = '';
      exists[filePath] = false;
    }
  }
  return { contents: files, exists };
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });
  }

  const guarded = guardPath(parsed.data.rootPath);
  if (!guarded.ok) {
    return NextResponse.json({ error: guarded.reason ?? 'Invalid project root' }, { status: 400 });
  }

  try {
    if (parsed.data.action === 'preview-edit-blocks') {
      const filePaths = Array.from(new Set(parsed.data.edits.map((edit) => edit.path.replace(/\\/g, '/').replace(/^\/+/, ''))));
      const currentFiles = await readCurrentFiles(guarded.resolved, filePaths);
      const result = applyGroupedEditBlocks(currentFiles.contents, parsed.data.edits, { existingFiles: currentFiles.exists });
      if (!result.ok) {
        return NextResponse.json({ error: 'Edit block validation failed', code: 'EDIT_BLOCK_INVALID', diagnostics: result.diagnostics }, { status: 409 });
      }

      const syntaxDiagnostics = result.previews.flatMap((preview) => validateSyntaxLightweight(preview.path, preview.afterContent));
      if (syntaxDiagnostics.length) {
        return NextResponse.json({ error: 'Syntax pre-validation failed', code: 'AST_PREVALIDATION_FAILED', diagnostics: syntaxDiagnostics }, { status: 422 });
      }

      return NextResponse.json({
        patchId: parsed.data.patchId ?? `patch:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        status: 'previewed',
        files: result.previews,
        unifiedDiff: result.previews.map((preview) => preview.unifiedDiff).join('\n'),
        createdAt: Date.now(),
      });
    }

    // Motivation vs Logic: all mutation now funnels through one checkpointed apply helper, so preview,
    // manual approval, auto approval, and stored-patch application enforce the same stale-content boundary.
    const result = await applyPatchFiles({
      root: guarded.resolved,
      projectId: parsed.data.projectId,
      runId: parsed.data.runId,
      patchId: parsed.data.patchId,
      files: parsed.data.files,
    });
    return NextResponse.json({
      patchId: parsed.data.patchId,
      ...result,
    });
  } catch (err) {
    if (err instanceof PatchApplyError) {
      return NextResponse.json({ error: err.message, code: err.code, ...(typeof err.details === 'object' && err.details ? err.details : { details: err.details }) }, { status: err.status });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

import { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { guardPath } from '@/lib/security/pathGuard';
import {
  buildKnowledgeGraph,
  knowledgeGraphMetadata,
  knowledgeGraphPaths,
} from '@/lib/code-space/runtime/knowledgeGraph';

export const runtime = 'nodejs';

const BuildSchema = z.object({
  projectRoot: z.string(),
  semantic: z.boolean().optional().default(false),
  maxFiles: z.number().optional(),
  foundry: z
    .object({ apiKey: z.string().optional(), endpoint: z.string().optional(), model: z.string().optional() })
    .optional(),
});

/** GET /api/code-space/knowledge-graph?root=<abs> — cached graph metadata (or 404 when absent). */
export async function GET(req: NextRequest) {
  const root = req.nextUrl.searchParams.get('root') ?? '';
  const guarded = guardPath(root);
  if (!guarded.ok) return Response.json({ error: guarded.reason ?? 'Invalid project path' }, { status: 400 });
  const metadata = await knowledgeGraphMetadata(guarded.resolved);
  if (!metadata) return Response.json({ exists: false }, { status: 404 });
  return Response.json({ exists: true, metadata });
}

/** POST /api/code-space/knowledge-graph — (re)build the knowledge graph for a project. */
export async function POST(req: NextRequest) {
  const parsed = BuildSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  const guarded = guardPath(parsed.data.projectRoot);
  if (!guarded.ok) return Response.json({ error: guarded.reason ?? 'Invalid project path' }, { status: 400 });

  try {
    const metadata = await buildKnowledgeGraph(guarded.resolved, {
      semantic: parsed.data.semantic,
      maxFiles: parsed.data.maxFiles,
      foundry: parsed.data.foundry,
      signal: req.signal,
    });
    const { htmlPath } = knowledgeGraphPaths(guarded.resolved);
    await fs.access(htmlPath);
    return Response.json({ ok: true, metadata });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

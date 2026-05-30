import { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import { guardPath } from '@/lib/security/pathGuard';
import { knowledgeGraphPaths } from '@/lib/code-space/runtime/knowledgeGraph';

export const runtime = 'nodejs';

/**
 * GET /api/code-space/knowledge-graph/view?root=<abs> — serves the cached Graphify vis.js
 * `graph.html` so the UI can render the interactive knowledge graph in a modal iframe.
 */
export async function GET(req: NextRequest) {
  const root = req.nextUrl.searchParams.get('root') ?? '';
  const guarded = guardPath(root);
  if (!guarded.ok) return new Response(`Invalid project path: ${guarded.reason ?? ''}`, { status: 400 });
  try {
    const html = await fs.readFile(knowledgeGraphPaths(guarded.resolved).htmlPath, 'utf8');
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN' },
    });
  } catch {
    return new Response('Knowledge graph has not been generated yet.', { status: 404 });
  }
}

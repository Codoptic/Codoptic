/**
 * Import-graph extractor.
 *
 * Heuristic but precise enough to be useful for diagram planning. Reads
 * a (subset of) source files and pulls out:
 *   - JS/TS:    import / require / dynamic import / re-export
 *   - Python:   import / from … import
 *   - Go:       import "…" / import ( … )
 *   - Rust:     use crate::… ;
 *
 * The output graph is keyed by relative file path; values are the set of
 * other relative-path candidates the file imports. Module path resolution
 * is best-effort — we leave package-name imports as raw module strings so
 * the planner can use them as cluster hints.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

export interface ImportEdge {
  from: string; // relative source path
  to: string;   // resolved relative path OR raw module name (for externals)
  external: boolean;
}

export interface ImportGraph {
  files: Map<string, string[]>; // path → imports (resolved-or-raw)
  edges: ImportEdge[];
  externals: Map<string, number>; // module → import count
}

const JS_IMPORT_RE = /(?:^|\n)\s*(?:import\s+(?:[\s\S]*?)\s+from\s+|export\s+\*?\s+from\s+|import\s*\(|require\s*\()\s*["'`]([^"'`]+)["'`]/g;
const PY_IMPORT_RE = /(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
const GO_IMPORT_RE = /(?:^|\n)\s*import\s+(?:"([^"]+)"|\(([\s\S]*?)\))/g;
const RUST_USE_RE = /(?:^|\n)\s*use\s+([\w:]+)\s*(?:[;,{])/g;

function isResolvableLocal(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/');
}

async function tryResolve(root: string, importerRel: string, spec: string, extCandidates: string[]): Promise<string | null> {
  const importerDir = path.dirname(importerRel);
  const baseAbs = path.resolve(root, importerDir, spec);
  for (const ext of ['', ...extCandidates]) {
    const candidate = `${baseAbs}${ext}`;
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) return path.relative(root, candidate).replace(/\\/g, '/');
    } catch {
      /* miss */
    }
  }
  // Try directory + index
  for (const ext of extCandidates) {
    const candidate = path.join(baseAbs, `index${ext}`);
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) return path.relative(root, candidate).replace(/\\/g, '/');
    } catch {
      /* miss */
    }
  }
  return null;
}

function jsExtensions(): string[] {
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
}

function pyExtensions(): string[] {
  return ['.py'];
}

function rsExtensions(): string[] {
  return ['.rs'];
}

function goExtensions(): string[] {
  return ['.go'];
}

function detectLang(filePath: string): 'js' | 'py' | 'go' | 'rs' | null {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return 'js';
  if (/\.py$/.test(filePath)) return 'py';
  if (/\.go$/.test(filePath)) return 'go';
  if (/\.rs$/.test(filePath)) return 'rs';
  return null;
}

export async function extractImportGraph(
  root: string,
  files: string[],
  opts: { maxBytesPerFile?: number; maxFiles?: number } = {},
): Promise<ImportGraph> {
  const maxBytes = opts.maxBytesPerFile ?? 80_000;
  const maxFiles = opts.maxFiles ?? 300;
  const graph: ImportGraph = { files: new Map(), edges: [], externals: new Map() };
  const candidates = files.filter((f) => detectLang(f) !== null).slice(0, maxFiles);

  for (const rel of candidates) {
    const lang = detectLang(rel);
    if (!lang) continue;
    let content: string;
    try {
      const buf = await fs.readFile(path.join(root, rel));
      content = buf.subarray(0, maxBytes).toString('utf8');
    } catch {
      continue;
    }

    const imports: string[] = [];
    if (lang === 'js') {
      let m: RegExpExecArray | null;
      JS_IMPORT_RE.lastIndex = 0;
      while ((m = JS_IMPORT_RE.exec(content)) !== null) {
        const spec = m[1];
        if (!spec) continue;
        if (isResolvableLocal(spec)) {
          const resolved = await tryResolve(root, rel, spec, jsExtensions());
          if (resolved) {
            imports.push(resolved);
            graph.edges.push({ from: rel, to: resolved, external: false });
          } else {
            imports.push(spec);
            graph.edges.push({ from: rel, to: spec, external: false });
          }
        } else {
          imports.push(spec);
          graph.externals.set(spec, (graph.externals.get(spec) ?? 0) + 1);
          graph.edges.push({ from: rel, to: spec, external: true });
        }
      }
    } else if (lang === 'py') {
      let m: RegExpExecArray | null;
      PY_IMPORT_RE.lastIndex = 0;
      while ((m = PY_IMPORT_RE.exec(content)) !== null) {
        const mod = m[1] || m[2];
        if (!mod) continue;
        const rel2 = mod.replace(/\./g, '/');
        const tryRel = await tryResolve(root, rel, `./${rel2}`, pyExtensions());
        if (tryRel) {
          imports.push(tryRel);
          graph.edges.push({ from: rel, to: tryRel, external: false });
        } else {
          imports.push(mod);
          graph.externals.set(mod, (graph.externals.get(mod) ?? 0) + 1);
          graph.edges.push({ from: rel, to: mod, external: true });
        }
      }
    } else if (lang === 'go') {
      let m: RegExpExecArray | null;
      GO_IMPORT_RE.lastIndex = 0;
      while ((m = GO_IMPORT_RE.exec(content)) !== null) {
        if (m[1]) {
          imports.push(m[1]);
          graph.externals.set(m[1], (graph.externals.get(m[1]) ?? 0) + 1);
          graph.edges.push({ from: rel, to: m[1], external: true });
        } else if (m[2]) {
          const blockMatches = m[2].match(/"([^"]+)"/g) ?? [];
          for (const b of blockMatches) {
            const spec = b.slice(1, -1);
            imports.push(spec);
            graph.externals.set(spec, (graph.externals.get(spec) ?? 0) + 1);
            graph.edges.push({ from: rel, to: spec, external: true });
          }
        }
      }
    } else if (lang === 'rs') {
      let m: RegExpExecArray | null;
      RUST_USE_RE.lastIndex = 0;
      while ((m = RUST_USE_RE.exec(content)) !== null) {
        const spec = m[1];
        if (!spec) continue;
        const head = spec.split('::')[0]!;
        imports.push(head);
        graph.externals.set(head, (graph.externals.get(head) ?? 0) + 1);
        graph.edges.push({ from: rel, to: head, external: true });
      }
    }

    graph.files.set(rel, imports);
    void rsExtensions; // referenced for future Rust local resolution
    void goExtensions;
  }
  return graph;
}

/** Top-N folder clusters by incoming dependency count. Useful for planner hints. */
export function topClusters(graph: ImportGraph, topN = 12): Array<{ folder: string; incoming: number; outgoing: number }> {
  const counts = new Map<string, { incoming: number; outgoing: number }>();
  function folder(p: string): string {
    const parts = p.split('/');
    return parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0] ?? p;
  }
  for (const e of graph.edges) {
    if (e.external) continue;
    const f1 = folder(e.from);
    const f2 = folder(e.to);
    if (f1 === f2) continue;
    const a = counts.get(f1) ?? { incoming: 0, outgoing: 0 };
    a.outgoing++;
    counts.set(f1, a);
    const b = counts.get(f2) ?? { incoming: 0, outgoing: 0 };
    b.incoming++;
    counts.set(f2, b);
  }
  return [...counts.entries()]
    .map(([folder, c]) => ({ folder, ...c }))
    .sort((a, b) => b.incoming + b.outgoing - (a.incoming + a.outgoing))
    .slice(0, topN);
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ImportGraph } from './importGraph';
import type { RepoMap } from './repoScanner';
import type { FileSummary } from '../analysis/summarizer';

export interface FolderCluster {
  folder: string;
  fileCount: number;
  totalBytes: number;
  entrypoints: string[];
  apiRoutes: string[];
  components: string[];
  schemas: string[];
  configs: string[];
  docs: string[];
  tests: number;
  importsIn: number;
  importsOut: number;
  externalDeps: string[];
  representativeFiles: string[];
}

export interface LayerBoundary {
  sourceFolder: string;
  targetFolder: string;
  edgeCount: number;
  examples: Array<{ from: string; to: string }>;
}

export interface CentralFile {
  path: string;
  incoming: number;
  outgoing: number;
  externalDeps: string[];
}

export interface RouteHint {
  path: string;
  route: string;
  methods: string[];
}

export interface EnvVarHint {
  name: string;
  files: string[];
}

export interface ExportHint {
  path: string;
  symbols: string[];
}

export interface RepoContextDigest {
  likelyStack: string[];
  depHints: string[];
  folderClusters: FolderCluster[];
  centralFiles: CentralFile[];
  routes: RouteHint[];
  exportsByFile: ExportHint[];
  envVars: EnvVarHint[];
  crossFolderEdges: LayerBoundary[];
  signals: {
    manifests: string[];
    entrypoints: string[];
    apiRoutes: string[];
    schemas: string[];
    configs: string[];
    infra: string[];
    docs: string[];
    tests: number;
  };
}

const SOURCE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs']);
const EXPORT_PATTERNS: Array<RegExp> = [
  /\bexport\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s*\{([^}]+)\}/g,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm,
  /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/gm,
  /^\s*(?:pub\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm,
  /^\s*(?:func|type)\s+([A-Za-z_]\w*)/gm,
];
const ENV_PATTERNS: RegExp[] = [
  /\bprocess\.env\.([A-Z0-9_]+)/g,
  /\bimport\.meta\.env\.([A-Z0-9_]+)/g,
  /\bDeno\.env\.get\(["'`]([A-Z0-9_]+)["'`]\)/g,
  /\bos\.environ(?:\.get)?\(["'`]([A-Z0-9_]+)["'`]\)/g,
  /\bgetenv\(["'`]([A-Z0-9_]+)["'`]\)/g,
];

function folderOf(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length === 1) return '.';
  if (parts[0] === 'app' && parts[1] === 'api') return 'app/api';
  if (parts[0] === 'pages' && parts[1] === 'api') return 'pages/api';
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

function pushLimited<T>(arr: T[], item: T, limit: number): void {
  if (arr.length < limit) arr.push(item);
}

function routeFromPath(filePath: string, content = ''): RouteHint | null {
  const methods = new Set<string>();
  const routeFile = filePath.toLowerCase();
  if (!/(^|\/)(route|index)\.(ts|tsx|js|jsx)$/.test(routeFile) && !/(^|\/)api\//.test(routeFile)) return null;

  let route = '';
  if (filePath.startsWith('app/api/')) {
    route = `/${filePath.replace(/^app\/api\//, '').replace(/\/route\.(ts|tsx|js|jsx)$/, '')}`;
  } else if (filePath.startsWith('pages/api/')) {
    route = `/${filePath.replace(/^pages\/api\//, 'api/').replace(/\.(ts|tsx|js|jsx)$/, '')}`;
  } else {
    const idx = filePath.indexOf('/api/');
    route = idx >= 0 ? `/${filePath.slice(idx + 1).replace(/\.(ts|tsx|js|jsx)$/, '')}` : `/${filePath}`;
  }
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    if (new RegExp(`\\b(?:export\\s+async\\s+function\\s+|export\\s+function\\s+|export\\s+const\\s+)?${method}\\b`).test(content)) {
      methods.add(method);
    }
  }
  return { path: filePath, route: route.replace(/\/index$/, ''), methods: [...methods] };
}

function extractSymbols(content: string): string[] {
  const symbols = new Set<string>();
  for (const pattern of EXPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const value = match[1];
      if (!value) continue;
      if (value.includes(',')) {
        for (const part of value.split(',')) {
          const symbol = part.trim().split(/\s+as\s+/i)[0]?.trim();
          if (symbol && /^[A-Za-z_$][\w$]*$/.test(symbol)) symbols.add(symbol);
        }
      } else {
        symbols.add(value);
      }
      if (symbols.size >= 20) break;
    }
  }
  return [...symbols].slice(0, 20);
}

function extractEnvVars(content: string): string[] {
  const vars = new Set<string>();
  for (const pattern of ENV_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) vars.add(match[1]);
      if (vars.size >= 30) break;
    }
  }
  return [...vars];
}

async function readSmall(root: string, rel: string, maxBytes: number): Promise<string> {
  const buf = await fs.readFile(path.join(root, rel));
  return buf.subarray(0, maxBytes).toString('utf8');
}

function topValues(values: Iterable<string>, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

export async function buildRepoContext(
  repoMap: RepoMap,
  importGraph: ImportGraph,
  opts: { maxSymbolFiles?: number; maxBytesPerFile?: number } = {},
): Promise<RepoContextDigest> {
  // Motivation vs Logic: model summaries describe selected files well, but architectural diagrams need repo-wide shape. This pass extracts cheap deterministic structure so planners can reason from routes, exports, env boundaries, and dependency clusters without receiving raw whole-repo contents.
  const maxSymbolFiles = opts.maxSymbolFiles ?? 700;
  const maxBytesPerFile = opts.maxBytesPerFile ?? 80_000;
  const fileSet = new Set(repoMap.files.map((f) => f.path));
  const folders = new Map<string, FolderCluster>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const externalsByFile = new Map<string, string[]>();
  const boundary = new Map<string, LayerBoundary>();

  function clusterFor(folder: string): FolderCluster {
    const current = folders.get(folder);
    if (current) return current;
    const next: FolderCluster = {
      folder,
      fileCount: 0,
      totalBytes: 0,
      entrypoints: [],
      apiRoutes: [],
      components: [],
      schemas: [],
      configs: [],
      docs: [],
      tests: 0,
      importsIn: 0,
      importsOut: 0,
      externalDeps: [],
      representativeFiles: [],
    };
    folders.set(folder, next);
    return next;
  }

  for (const file of repoMap.files) {
    const folder = folderOf(file.path);
    const cluster = clusterFor(folder);
    cluster.fileCount++;
    cluster.totalBytes += file.bytes;
    if (repoMap.entrypoints.includes(file)) pushLimited(cluster.entrypoints, file.path, 8);
    if (repoMap.apiRoutes.includes(file)) pushLimited(cluster.apiRoutes, file.path, 10);
    if (repoMap.components.includes(file)) pushLimited(cluster.components, file.path, 8);
    if (repoMap.schemas.includes(file)) pushLimited(cluster.schemas, file.path, 8);
    if (repoMap.configs.includes(file)) pushLimited(cluster.configs, file.path, 8);
    if (repoMap.docs.includes(file)) pushLimited(cluster.docs, file.path, 6);
    if (repoMap.tests.includes(file)) cluster.tests++;
    pushLimited(cluster.representativeFiles, file.path, 10);
  }

  for (const edge of importGraph.edges) {
    if (edge.external) {
      const deps = externalsByFile.get(edge.from) ?? [];
      deps.push(edge.to);
      externalsByFile.set(edge.from, deps);
      continue;
    }
    if (!fileSet.has(edge.from) || !fileSet.has(edge.to)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
    const sourceFolder = folderOf(edge.from);
    const targetFolder = folderOf(edge.to);
    if (sourceFolder === targetFolder) continue;
    clusterFor(sourceFolder).importsOut++;
    clusterFor(targetFolder).importsIn++;
    const key = `${sourceFolder}\u0000${targetFolder}`;
    const current = boundary.get(key) ?? { sourceFolder, targetFolder, edgeCount: 0, examples: [] };
    current.edgeCount++;
    pushLimited(current.examples, { from: edge.from, to: edge.to }, 5);
    boundary.set(key, current);
  }

  for (const [filePath, deps] of externalsByFile) {
    const cluster = clusterFor(folderOf(filePath));
    cluster.externalDeps = topValues([...cluster.externalDeps, ...deps], 10);
  }

  const routes: RouteHint[] = [];
  const exportsByFile: ExportHint[] = [];
  const envByName = new Map<string, Set<string>>();
  const sourceFiles = repoMap.files.filter((f) => SOURCE_EXTS.has(f.ext)).slice(0, maxSymbolFiles);
  for (const file of sourceFiles) {
    try {
      const content = await readSmall(repoMap.root, file.path, maxBytesPerFile);
      const route = routeFromPath(file.path, content);
      if (route) routes.push(route);
      const symbols = extractSymbols(content);
      if (symbols.length) exportsByFile.push({ path: file.path, symbols });
      for (const envVar of extractEnvVars(content)) {
        const files = envByName.get(envVar) ?? new Set<string>();
        files.add(file.path);
        envByName.set(envVar, files);
      }
    } catch {
      /* skip unreadable source files */
    }
  }

  const centralFiles: CentralFile[] = repoMap.files
    .map((file) => ({
      path: file.path,
      incoming: incoming.get(file.path) ?? 0,
      outgoing: outgoing.get(file.path) ?? 0,
      externalDeps: topValues(externalsByFile.get(file.path) ?? [], 8),
    }))
    .filter((file) => file.incoming || file.outgoing || file.externalDeps.length)
    .sort((a, b) => b.incoming + b.outgoing - (a.incoming + a.outgoing) || a.path.localeCompare(b.path))
    .slice(0, 30);

  return {
    likelyStack: repoMap.likelyStack,
    depHints: repoMap.depHints,
    folderClusters: [...folders.values()]
      .sort((a, b) => b.importsIn + b.importsOut + b.fileCount - (a.importsIn + a.importsOut + a.fileCount))
      .slice(0, 30),
    centralFiles,
    routes: routes.slice(0, 40),
    exportsByFile: exportsByFile.slice(0, 80),
    envVars: [...envByName.entries()]
      .map(([name, files]) => ({ name, files: [...files].slice(0, 8) }))
      .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name))
      .slice(0, 40),
    crossFolderEdges: [...boundary.values()]
      .sort((a, b) => b.edgeCount - a.edgeCount || a.sourceFolder.localeCompare(b.sourceFolder))
      .slice(0, 40),
    signals: {
      manifests: repoMap.manifests.map((f) => f.path),
      entrypoints: repoMap.entrypoints.map((f) => f.path).slice(0, 30),
      apiRoutes: repoMap.apiRoutes.map((f) => f.path).slice(0, 40),
      schemas: repoMap.schemas.map((f) => f.path).slice(0, 40),
      configs: repoMap.configs.map((f) => f.path).slice(0, 40),
      infra: repoMap.infra.map((f) => f.path).slice(0, 40),
      docs: repoMap.docs.map((f) => f.path).slice(0, 40),
      tests: repoMap.tests.length,
    },
  };
}

export interface StructuralSignal {
  path: string;
  weight: number;
  reason: string;
}

/**
 * Translate a repository digest into structural prioritization signals for the context engine.
 *
 * Motivation vs Logic: central files (high import in/out — the architectural hubs) and API routes
 * are disproportionately relevant for most tasks. Weighting them nudges file selection toward the
 * code that actually wires the system together, beyond raw prompt/keyword overlap. The same shape
 * is emitted by the knowledge-graph reader so both sources flow through one path.
 */
export function deriveStructuralSignals(digest: Pick<RepoContextDigest, 'centralFiles' | 'routes'>): StructuralSignal[] {
  const signals = new Map<string, StructuralSignal>();
  const upsert = (path: string, weight: number, reason: string) => {
    if (!path) return;
    const existing = signals.get(path);
    if (!existing || weight > existing.weight) signals.set(path, { path, weight, reason });
  };

  const maxDegree = digest.centralFiles.reduce((max, file) => Math.max(max, file.incoming + file.outgoing), 0) || 1;
  for (const file of digest.centralFiles) {
    const degree = file.incoming + file.outgoing;
    if (degree <= 0) continue;
    // Normalize to a 0-90 band so the most central file gets the strongest (capped) boost.
    const weight = Math.round((degree / maxDegree) * 90);
    if (weight > 0) upsert(file.path, weight, `central module (${file.incoming} in / ${file.outgoing} out)`);
  }
  for (const route of digest.routes) {
    upsert(route.path, 60, `API route ${route.route}${route.methods.length ? ` [${route.methods.join(',')}]` : ''}`);
  }
  return [...signals.values()].sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
}

export function selectLayerContextSummaries(
  layer: { name: string; member_files: string[] },
  summaries: Array<{ path: string; summary: FileSummary }>,
  importGraph: ImportGraph,
  opts: { min?: number; max?: number } = {},
): Array<{ path: string; summary: FileSummary }> {
  const min = opts.min ?? 8;
  const max = opts.max ?? 35;
  const byPath = new Map(summaries.map((summary) => [summary.path, summary]));
  const selected = new Set(layer.member_files);
  const layerToken = layer.name.toLowerCase().split(/\s+/)[0] ?? '';

  for (const summary of summaries) {
    if (summary.summary.layer.toLowerCase() === layerToken) selected.add(summary.path);
  }

  for (const edge of importGraph.edges) {
    if (edge.external) continue;
    if (selected.has(edge.from) && byPath.has(edge.to)) selected.add(edge.to);
    if (selected.has(edge.to) && byPath.has(edge.from)) selected.add(edge.from);
  }

  const chosen = [...selected].map((filePath) => byPath.get(filePath)).filter((item): item is { path: string; summary: FileSummary } => Boolean(item));
  if (chosen.length >= min) return chosen.slice(0, max);

  const seen = new Set(chosen.map((item) => item.path));
  for (const summary of summaries) {
    if (seen.has(summary.path)) continue;
    chosen.push(summary);
    if (chosen.length >= min) break;
  }
  return chosen.slice(0, max);
}

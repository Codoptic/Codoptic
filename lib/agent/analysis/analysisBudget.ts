import type { DiagramKind, Relevance } from './classifier';
import type { ImportGraph } from '../repo/importGraph';
import type { RepoContextDigest } from '../repo/repoContext';
import type { RepoMap } from '../repo/repoScanner';
import type { FileSummary } from './summarizer';

export type AnalysisTier = 1 | 2 | 3 | 4 | 5;
export type SummaryDepth = 'deep' | 'compressed' | 'signature' | 'structural';

export interface AnalysisBudget {
  tier: AnalysisTier;
  label: string;
  totalRelevantFiles: number;
  deepLimit: number;
  signatureLimit: number;
  plannerSummaryLimit: number;
  initialConcurrency: number;
  chunkTokens: number;
  modeNote: string;
}

export interface SummaryAssignment {
  relevance: Relevance;
  depth: SummaryDepth;
}

export interface AnalyzedSummary {
  path: string;
  depth: SummaryDepth;
  summary: FileSummary;
}

export interface GlobalDependencyState {
  externals: string[];
  centralFiles: string[];
  crossFolderEdges: string[];
  folderClusters: string[];
}

export interface ModuleRollup {
  module: string;
  fileCount: number;
  deepFiles: number;
  signatureFiles: number;
  representativeFiles: string[];
  layers: string[];
  categories: string[];
  surface: string[];
  externalDeps: string[];
  sideEffects: string[];
}

export interface AnalysisDigest {
  tier: AnalysisTier;
  label: string;
  totalRelevantFiles: number;
  analyzedFiles: number;
  deepFiles: number;
  signatureFiles: number;
  structuralFiles: number;
  bypassedFiles: number;
  global: GlobalDependencyState;
  moduleRollups: ModuleRollup[];
  notes: string[];
}

function tierForCount(count: number): AnalysisTier {
  if (count <= 500) return 1;
  if (count <= 1000) return 2;
  if (count <= 2000) return 3;
  if (count <= 5000) return 4;
  return 5;
}

export function createAnalysisBudget(relevantFileCount: number): AnalysisBudget {
  const tier = tierForCount(relevantFileCount);
  switch (tier) {
    case 1:
      return {
        tier,
        label: 'Tier 1 deep analysis',
        totalRelevantFiles: relevantFileCount,
        deepLimit: relevantFileCount,
        signatureLimit: 0,
        plannerSummaryLimit: 500,
        initialConcurrency: 4,
        chunkTokens: 2200,
        modeNote: 'Deep read all selected files.',
      };
    case 2:
      return {
        tier,
        label: 'Tier 2 compressed deep analysis',
        totalRelevantFiles: relevantFileCount,
        deepLimit: relevantFileCount,
        signatureLimit: 0,
        plannerSummaryLimit: 420,
        initialConcurrency: 4,
        chunkTokens: 2000,
        modeNote: 'Deep read selected files while compressing boilerplate and CRUD.',
      };
    case 3:
      return {
        tier,
        label: 'Tier 3 selective deep analysis',
        totalRelevantFiles: relevantFileCount,
        deepLimit: 320,
        signatureLimit: 900,
        plannerSummaryLimit: 160,
        initialConcurrency: 3,
        chunkTokens: 1800,
        modeNote: 'Deep read core logic, routes, state, schemas, and central files; profile helpers by signature.',
      };
    case 4:
      return {
        tier,
        label: 'Tier 4 DSL abstraction',
        totalRelevantFiles: relevantFileCount,
        deepLimit: 120,
        signatureLimit: 1200,
        plannerSummaryLimit: 90,
        initialConcurrency: 2,
        chunkTokens: 1600,
        modeNote: 'Rely on signatures, interfaces, import graph, and module rollups; deep read only critical files.',
      };
    case 5:
      return {
        tier,
        label: 'Tier 5 maximum abstraction',
        totalRelevantFiles: relevantFileCount,
        deepLimit: 0,
        signatureLimit: 700,
        plannerSummaryLimit: 40,
        initialConcurrency: 2,
        chunkTokens: 1400,
        modeNote: 'Map boundaries, entrypoints, models, and module rollups; bypass granular implementation details.',
      };
  }
}

function folderOf(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length === 1) return '.';
  if (parts[0] === 'app' && parts[1] === 'api') return 'app/api';
  if (parts[0] === 'pages' && parts[1] === 'api') return 'pages/api';
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

function isUtilityPath(path: string): boolean {
  return /(^|\/)(utils?|helpers?|shared|common|constants?|types?|generated|fixtures?)(\/|\.|-|_)/i.test(path);
}

function isCorePath(path: string, kind: DiagramKind): boolean {
  if (/(^|\/)(api|routes?|handlers?|controllers?|services?|domain|state|store|models?|schema|schemas|prisma|db|database|workers?|queues?)(\/|\.|-|_)/i.test(path)) {
    return true;
  }
  if (kind === 'deployment') return /(^|\/)(infra|deploy|terraform|helm|kubernetes|docker|\.github)(\/|\.|-|_)/i.test(path);
  if (kind === 'data-flow') return /(^|\/)(etl|pipeline|data|db|database|models?|schema|schemas)(\/|\.|-|_)/i.test(path);
  if (kind === 'sequence') return /(^|\/)(api|routes?|handlers?|controllers?)(\/|\.|-|_)/i.test(path);
  return false;
}

function criticalPathSet(repoMap: RepoMap, repoContext?: RepoContextDigest): Set<string> {
  const paths = new Set<string>();
  for (const file of [...repoMap.entrypoints, ...repoMap.apiRoutes, ...repoMap.schemas, ...repoMap.infra, ...repoMap.docs]) {
    paths.add(file.path);
  }
  for (const file of repoContext?.centralFiles ?? []) paths.add(file.path);
  for (const route of repoContext?.routes ?? []) paths.add(route.path);
  for (const edge of repoContext?.crossFolderEdges ?? []) {
    for (const example of edge.examples) {
      paths.add(example.from);
      paths.add(example.to);
    }
  }
  return paths;
}

export function assignSummaryDepths(
  relevant: readonly Relevance[],
  budget: AnalysisBudget,
  repoMap: RepoMap,
  kind: DiagramKind,
  repoContext?: RepoContextDigest,
): SummaryAssignment[] {
  if (budget.tier <= 2) {
    const depth: SummaryDepth = budget.tier === 1 ? 'deep' : 'compressed';
    return relevant.map((relevance) => ({ relevance, depth }));
  }

  const critical = criticalPathSet(repoMap, repoContext);
  const assignments: SummaryAssignment[] = [];
  let deep = 0;
  let signature = 0;

  for (const item of relevant) {
    const path = item.file.path;
    const shouldDeep =
      budget.deepLimit > 0 &&
      deep < budget.deepLimit &&
      (critical.has(path) || isCorePath(path, kind) || (!isUtilityPath(path) && item.score >= 0.85));

    if (shouldDeep) {
      assignments.push({ relevance: item, depth: budget.tier === 3 ? 'compressed' : 'deep' });
      deep++;
      continue;
    }

    if (signature < budget.signatureLimit && (budget.tier < 5 || critical.has(path) || isCorePath(path, kind) || item.score >= 0.8)) {
      assignments.push({ relevance: item, depth: 'signature' });
      signature++;
      continue;
    }

    assignments.push({ relevance: item, depth: 'structural' });
  }

  return assignments;
}

function topValues(values: Iterable<string>, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned) continue;
    counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function compactEdge(edge: { sourceFolder: string; targetFolder: string; edgeCount: number }): string {
  return `${edge.sourceFolder}->${edge.targetFolder} (${edge.edgeCount})`;
}

export function buildGlobalDependencyState(importGraph: ImportGraph, repoContext?: RepoContextDigest): GlobalDependencyState {
  return {
    externals: [...importGraph.externals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 30)
      .map(([name, count]) => `${name} (${count})`),
    centralFiles: (repoContext?.centralFiles ?? [])
      .slice(0, 24)
      .map((file) => `${file.path} (in ${file.incoming}, out ${file.outgoing})`),
    crossFolderEdges: (repoContext?.crossFolderEdges ?? []).slice(0, 30).map(compactEdge),
    folderClusters: (repoContext?.folderClusters ?? [])
      .slice(0, 30)
      .map((cluster) => `${cluster.folder} (${cluster.fileCount} files, in ${cluster.importsIn}, out ${cluster.importsOut})`),
  };
}

export function buildAnalysisDigest(params: {
  budget: AnalysisBudget;
  repoMap: RepoMap;
  importGraph: ImportGraph;
  repoContext?: RepoContextDigest;
  assignments: readonly SummaryAssignment[];
  summaries: readonly AnalyzedSummary[];
}): AnalysisDigest {
  const byPath = new Map(params.summaries.map((item) => [item.path, item]));
  const modules = new Map<string, AnalyzedSummary[]>();
  for (const summary of params.summaries) {
    const folder = folderOf(summary.path);
    const list = modules.get(folder) ?? [];
    list.push(summary);
    modules.set(folder, list);
  }

  const structuralFiles = params.assignments.filter((item) => item.depth === 'structural').length;
  const moduleRollups: ModuleRollup[] = [];
  for (const [module, items] of modules) {
    moduleRollups.push({
      module,
      fileCount: params.repoMap.files.filter((file) => folderOf(file.path) === module).length || items.length,
      deepFiles: items.filter((item) => item.depth === 'deep' || item.depth === 'compressed').length,
      signatureFiles: items.filter((item) => item.depth === 'signature').length,
      representativeFiles: items.slice(0, 8).map((item) => item.path),
      layers: topValues(items.map((item) => item.summary.layer), 4),
      categories: topValues(items.map((item) => item.summary.category), 5),
      surface: topValues(items.flatMap((item) => item.summary.surface), 10),
      externalDeps: topValues(items.flatMap((item) => item.summary.external_deps), 10),
      sideEffects: topValues(items.flatMap((item) => item.summary.side_effects), 8),
    });
  }

  const foldersWithoutSummaries = params.repoContext?.folderClusters
    .filter((cluster) => !modules.has(cluster.folder))
    .slice(0, 20)
    .map((cluster) => ({
      module: cluster.folder,
      fileCount: cluster.fileCount,
      deepFiles: 0,
      signatureFiles: 0,
      representativeFiles: cluster.representativeFiles.slice(0, 8),
      layers: ['other'],
      categories: ['other'],
      surface: [...cluster.apiRoutes, ...cluster.schemas, ...cluster.components].slice(0, 10),
      externalDeps: cluster.externalDeps.slice(0, 10),
      sideEffects: [],
    })) ?? [];

  moduleRollups.push(...foldersWithoutSummaries);
  moduleRollups.sort((a, b) => b.deepFiles + b.signatureFiles + b.fileCount - (a.deepFiles + a.signatureFiles + a.fileCount));

  const deepFiles = params.summaries.filter((item) => item.depth === 'deep' || item.depth === 'compressed').length;
  const signatureFiles = params.summaries.filter((item) => item.depth === 'signature').length;
  const analyzedPaths = new Set(params.summaries.map((item) => item.path));
  const bypassedFiles = params.assignments.filter((item) => !analyzedPaths.has(item.relevance.file.path)).length;

  return {
    tier: params.budget.tier,
    label: params.budget.label,
    totalRelevantFiles: params.budget.totalRelevantFiles,
    analyzedFiles: byPath.size,
    deepFiles,
    signatureFiles,
    structuralFiles,
    bypassedFiles,
    global: buildGlobalDependencyState(params.importGraph, params.repoContext),
    moduleRollups: moduleRollups.slice(0, 80),
    notes: [
      params.budget.modeNote,
      `${deepFiles} deep/compressed summaries, ${signatureFiles} signature profiles, ${structuralFiles} structural-only files.`,
    ],
  };
}

export function budgetCounters(budget: AnalysisBudget, assignments: readonly SummaryAssignment[]): Record<string, number> {
  return {
    tier: budget.tier,
    selected: budget.totalRelevantFiles,
    deep: assignments.filter((item) => item.depth === 'deep' || item.depth === 'compressed').length,
    signature: assignments.filter((item) => item.depth === 'signature').length,
    bypassed: assignments.filter((item) => item.depth === 'structural').length,
  };
}

export function isAnalyzedDepth(depth: SummaryDepth): depth is Exclude<SummaryDepth, 'structural'> {
  return depth === 'deep' || depth === 'compressed' || depth === 'signature';
}

export function formatDepth(depth: SummaryDepth): string {
  return depth === 'compressed' ? 'deep-compressed' : depth;
}

export function focusAnalysisDigest(digest: AnalysisDigest, memberFiles: readonly string[]): AnalysisDigest {
  const folders = new Set(memberFiles.map(folderOf));
  const focusedRollups = digest.moduleRollups.filter(
    (rollup) => folders.has(rollup.module) || rollup.representativeFiles.some((file) => memberFiles.includes(file)),
  );
  return {
    ...digest,
    moduleRollups: (focusedRollups.length ? focusedRollups : digest.moduleRollups.slice(0, 12)).slice(0, 24),
    notes: [...digest.notes, `Focused digest for ${memberFiles.length} layer member files.`],
  };
}

import { describe, expect, it } from 'vitest';
import { assignSummaryDepths, buildAnalysisDigest, createAnalysisBudget } from '../analysis/analysisBudget';
import type { Relevance } from '../analysis/classifier';
import type { ImportGraph } from '../repo/importGraph';
import type { RepoContextDigest } from '../repo/repoContext';
import type { RepoMap, ScannedFile } from '../repo/repoScanner';

function file(path: string): ScannedFile {
  return { path, bytes: 120, ext: path.split('.').pop() ?? 'ts' };
}

function repo(files: ScannedFile[]): RepoMap {
  return {
    root: '/tmp/repo',
    fileCount: files.length,
    totalBytes: files.reduce((sum, item) => sum + item.bytes, 0),
    byExt: {},
    files,
    manifests: [],
    entrypoints: files.filter((item) => /main|app/.test(item.path)),
    apiRoutes: files.filter((item) => item.path.includes('/api/')),
    components: [],
    schemas: files.filter((item) => item.path.includes('schema')),
    configs: [],
    infra: [],
    tests: [],
    docs: [],
    depHints: [],
    ignoredFolders: [],
    likelyStack: ['TypeScript'],
  };
}

function relevance(files: ScannedFile[]): Relevance[] {
  return files.map((item, index) => ({ file: item, score: index < 10 ? 1 : 0.5, reasons: [] }));
}

describe('analysis budget', () => {
  it('selects the expected depth tier at every boundary', () => {
    expect(createAnalysisBudget(500).tier).toBe(1);
    expect(createAnalysisBudget(501).tier).toBe(2);
    expect(createAnalysisBudget(1000).tier).toBe(2);
    expect(createAnalysisBudget(1001).tier).toBe(3);
    expect(createAnalysisBudget(2000).tier).toBe(3);
    expect(createAnalysisBudget(2001).tier).toBe(4);
    expect(createAnalysisBudget(5000).tier).toBe(4);
    expect(createAnalysisBudget(5001).tier).toBe(5);
    expect(createAnalysisBudget(10).initialConcurrency).toBe(8);
    expect(createAnalysisBudget(10).maxConcurrency).toBe(12);
    expect(createAnalysisBudget(1500).initialConcurrency).toBe(8);
    expect(createAnalysisBudget(1500).maxConcurrency).toBe(12);
    expect(createAnalysisBudget(3000).initialConcurrency).toBe(6);
    expect(createAnalysisBudget(3000).maxConcurrency).toBe(10);
    expect(createAnalysisBudget(6000).initialConcurrency).toBe(6);
    expect(createAnalysisBudget(6000).maxConcurrency).toBe(10);
  });

  it('uses signature and structural profiles for a 1001+ file repo instead of deep-reading everything', () => {
    const files = Array.from({ length: 1001 }, (_, index) =>
      file(index % 20 === 0 ? `app/api/route-${index}/route.ts` : `lib/utils/helper-${index}.ts`),
    );
    const map = repo(files);
    const ctx: RepoContextDigest = {
      likelyStack: ['TypeScript'],
      depHints: [],
      folderClusters: [],
      centralFiles: [{ path: 'app/api/route-0/route.ts', incoming: 5, outgoing: 4, externalDeps: [] }],
      routes: [],
      exportsByFile: [],
      envVars: [],
      crossFolderEdges: [],
      signals: { manifests: [], entrypoints: [], apiRoutes: [], schemas: [], configs: [], infra: [], docs: [], tests: 0 },
    };

    const assignments = assignSummaryDepths(relevance(files), createAnalysisBudget(files.length), map, 'architecture', ctx);
    const deep = assignments.filter((item) => item.depth === 'deep' || item.depth === 'compressed').length;
    const signature = assignments.filter((item) => item.depth === 'signature').length;
    const structural = assignments.filter((item) => item.depth === 'structural').length;

    expect(deep).toBeGreaterThan(0);
    expect(deep).toBeLessThan(files.length);
    expect(signature).toBeGreaterThan(0);
    expect(structural).toBeGreaterThan(0);
  });

  it('builds compact module rollups for large synthetic analysis results', () => {
    const files = Array.from({ length: 1200 }, (_, index) => file(`lib/module-${index % 20}/file-${index}.ts`));
    const importGraph: ImportGraph = { files: new Map(), edges: [], externals: new Map([['react', 20]]) };
    const assignments = assignSummaryDepths(relevance(files), createAnalysisBudget(files.length), repo(files), 'architecture');
    const summaries = assignments
      .filter((item) => item.depth !== 'structural')
      .slice(0, 300)
      .map((item) => ({
        path: item.relevance.file.path,
        depth: item.depth,
        summary: {
          role: 'Synthetic summary',
          category: 'service' as const,
          layer: 'service' as const,
          exports: [],
          imports: [],
          surface: ['run'],
          external_deps: ['react'],
          side_effects: [],
          notes: null,
        },
      }));

    const digest = buildAnalysisDigest({
      budget: createAnalysisBudget(files.length),
      repoMap: repo(files),
      importGraph,
      assignments,
      summaries,
    });

    expect(digest.moduleRollups.length).toBeLessThanOrEqual(80);
    expect(digest.totalRelevantFiles).toBe(1200);
    expect(digest.global.externals).toEqual(['react (20)']);
  });
});


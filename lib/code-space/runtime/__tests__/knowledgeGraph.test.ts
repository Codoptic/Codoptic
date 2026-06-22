import { mkdtemp, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_GRAPH_DIR,
  isKnowledgeGraphStale,
  knowledgeGraphMetadata,
  knowledgeGraphSignals,
  type KnowledgeGraph,
  type KnowledgeGraphNode,
} from '../knowledgeGraph';

let tmpRoot: string | null = null;

afterEach(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

function node(
  partial: Partial<KnowledgeGraphNode> & { id: string; degree: number },
): KnowledgeGraphNode {
  return {
    path: partial.id,
    language: 'typescript',
    loc: 10,
    incoming: 0,
    outgoing: 0,
    community: 0,
    isGod: false,
    ...partial,
  } as KnowledgeGraphNode;
}

function graph(nodes: KnowledgeGraphNode[]): KnowledgeGraph {
  return {
    generatedAt: Date.now(),
    root: '/tmp/repo',
    nodes,
    edges: [],
    godNodes: nodes.filter((n) => n.isGod).map((n) => n.id),
    metrics: { fileCount: nodes.length, edgeCount: 0, communityCount: 1, godNodeCount: 0 },
  };
}

describe('knowledgeGraphSignals', () => {
  it('weights nodes by normalized degree, strongest first', () => {
    const signals = knowledgeGraphSignals(
      graph([node({ id: 'lib/hub.ts', degree: 20 }), node({ id: 'lib/leaf.ts', degree: 4 })]),
    );
    expect(signals[0]?.path).toBe('lib/hub.ts');
    expect(signals[0]?.weight).toBe(80); // max degree normalizes to the 80 cap
    const leaf = signals.find((s) => s.path === 'lib/leaf.ts');
    expect(leaf && leaf.weight).toBeLessThan(80);
  });

  it('gives god nodes a strong weight floor and labels them', () => {
    const signals = knowledgeGraphSignals(
      graph([
        node({ id: 'lib/big.ts', degree: 50 }),
        node({ id: 'lib/god.ts', degree: 3, isGod: true }),
      ]),
    );
    const god = signals.find((s) => s.path === 'lib/god.ts');
    expect(god?.weight).toBeGreaterThanOrEqual(70);
    expect(god?.reason).toContain('god node');
  });

  it('drops zero-degree nodes and caps the signal list', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      node({ id: `f${i}.ts`, degree: i % 2 === 0 ? 0 : i }),
    );
    const signals = knowledgeGraphSignals(graph(many));
    expect(signals.some((s) => s.weight <= 0)).toBe(false);
    expect(signals.length).toBeLessThanOrEqual(40);
  });
});

describe('knowledge graph freshness', () => {
  it('marks cached metadata stale when project files are newer than the graph', async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'knowledge-graph-stale-'));
    const cacheDir = path.join(tmpRoot, KNOWLEDGE_GRAPH_DIR);
    await mkdir(cacheDir, { recursive: true });
    const generatedAt = Date.now() - 10_000;
    await writeFile(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({
        generatedAt,
        root: tmpRoot,
        nodes: [],
        edges: [],
        godNodes: [],
        metrics: { fileCount: 0, edgeCount: 0, communityCount: 0, godNodeCount: 0 },
      }),
      'utf8',
    );
    const sourcePath = path.join(tmpRoot, 'src.ts');
    await writeFile(sourcePath, 'export const answer = 42;\n', 'utf8');
    const sourceTime = new Date(generatedAt + 5_000);
    await utimes(sourcePath, sourceTime, sourceTime);

    await expect(isKnowledgeGraphStale(tmpRoot, generatedAt)).resolves.toBe(true);
    await expect(knowledgeGraphMetadata(tmpRoot)).resolves.toMatchObject({ stale: true });
  });

  it('keeps cached metadata fresh when ignored cache files are newer', async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'knowledge-graph-fresh-'));
    const cacheDir = path.join(tmpRoot, KNOWLEDGE_GRAPH_DIR);
    await mkdir(cacheDir, { recursive: true });
    const generatedAt = Date.now();
    await writeFile(
      path.join(cacheDir, 'graph.json'),
      JSON.stringify({
        generatedAt,
        root: tmpRoot,
        nodes: [],
        edges: [],
        godNodes: [],
        metrics: { fileCount: 0, edgeCount: 0, communityCount: 0, godNodeCount: 0 },
      }),
      'utf8',
    );
    const cacheArtifactPath = path.join(cacheDir, 'later.ts');
    await writeFile(cacheArtifactPath, 'export const cacheOnly = true;\n', 'utf8');
    const cacheTime = new Date(generatedAt + 5_000);
    await utimes(cacheArtifactPath, cacheTime, cacheTime);

    await expect(isKnowledgeGraphStale(tmpRoot, generatedAt)).resolves.toBe(false);
    await expect(knowledgeGraphMetadata(tmpRoot)).resolves.toMatchObject({ stale: false });
  });
});

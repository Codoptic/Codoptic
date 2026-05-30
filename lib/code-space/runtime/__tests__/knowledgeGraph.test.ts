import { describe, expect, it } from 'vitest';
import { knowledgeGraphSignals, type KnowledgeGraph, type KnowledgeGraphNode } from '../knowledgeGraph';

function node(partial: Partial<KnowledgeGraphNode> & { id: string; degree: number }): KnowledgeGraphNode {
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
      graph([
        node({ id: 'lib/hub.ts', degree: 20 }),
        node({ id: 'lib/leaf.ts', degree: 4 }),
      ]),
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
    const many = Array.from({ length: 60 }, (_, i) => node({ id: `f${i}.ts`, degree: i % 2 === 0 ? 0 : i }));
    const signals = knowledgeGraphSignals(graph(many));
    expect(signals.some((s) => s.weight <= 0)).toBe(false);
    expect(signals.length).toBeLessThanOrEqual(40);
  });
});

/**
 * Knowledge-graph integration (Graphify-adapted).
 *
 * Motivation vs Logic: a persistent code knowledge graph is a far better long-term context index
 * than re-globbing the repo each run. We build it once (first Plan run) via the vendored
 * `tools/graphify/build_graph.py` pipeline, cache it under the project's `.codoptic-cache/`, and
 * thereafter (a) reuse it to bias file selection (god nodes / high-degree hubs) and (b) render it
 * in the UI. The Python pipeline extracts code structure offline; an optional Foundry semantic pass
 * annotates central files when credentials are supplied.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const KNOWLEDGE_GRAPH_DIR = '.codoptic-cache/knowledge-graph';

export interface KnowledgeGraphNode {
  id: string;
  path: string;
  language: string;
  loc: number;
  degree: number;
  incoming: number;
  outgoing: number;
  community: number;
  isGod: boolean;
  symbols?: string[];
  summary?: string;
}

export interface KnowledgeGraph {
  generatedAt: number;
  root: string;
  nodes: KnowledgeGraphNode[];
  edges: Array<{ from: string; to: string; type: string }>;
  godNodes: string[];
  metrics: { fileCount: number; edgeCount: number; communityCount: number; godNodeCount: number };
}

export interface KnowledgeGraphMetadata {
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  generatedAt: number;
}

export interface BuildKnowledgeGraphOptions {
  semantic?: boolean;
  maxFiles?: number;
  foundry?: { apiKey?: string; endpoint?: string; model?: string };
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function knowledgeGraphPaths(root: string) {
  const dir = path.join(root, KNOWLEDGE_GRAPH_DIR);
  return {
    dir,
    jsonPath: path.join(dir, 'graph.json'),
    htmlPath: path.join(dir, 'graph.html'),
    reportPath: path.join(dir, 'GRAPH_REPORT.md'),
  };
}

function builderScriptPath(): string {
  return path.join(process.cwd(), 'tools', 'graphify', 'build_graph.py');
}

/** Whether a cached graph.json already exists for this project. */
export async function knowledgeGraphExists(root: string): Promise<boolean> {
  try {
    await fs.access(knowledgeGraphPaths(root).jsonPath);
    return true;
  } catch {
    return false;
  }
}

export async function loadKnowledgeGraph(root: string): Promise<KnowledgeGraph | null> {
  try {
    const raw = await fs.readFile(knowledgeGraphPaths(root).jsonPath, 'utf8');
    return JSON.parse(raw) as KnowledgeGraph;
  } catch {
    return null;
  }
}

export async function knowledgeGraphMetadata(root: string): Promise<KnowledgeGraphMetadata | null> {
  const graph = await loadKnowledgeGraph(root);
  if (!graph) return null;
  return {
    nodeCount: graph.metrics.fileCount,
    edgeCount: graph.metrics.edgeCount,
    communityCount: graph.metrics.communityCount,
    generatedAt: graph.generatedAt,
  };
}

/**
 * Run the vendored Graphify pipeline as a subprocess. Code extraction is offline; the optional
 * semantic pass is enabled with `semantic` + Foundry credentials and is best-effort inside Python.
 */
export async function buildKnowledgeGraph(root: string, options: BuildKnowledgeGraphOptions = {}): Promise<KnowledgeGraphMetadata> {
  const { dir } = knowledgeGraphPaths(root);
  const args = [builderScriptPath(), '--root', root, '--out', dir, '--max-files', String(options.maxFiles ?? 4000)];
  if (options.semantic) args.push('--semantic');
  const env = { ...process.env };
  if (options.foundry?.apiKey) env.FOUNDRY_API_KEY = options.foundry.apiKey;
  if (options.foundry?.endpoint) env.FOUNDRY_ENDPOINT = options.foundry.endpoint;
  if (options.foundry?.model) env.FOUNDRY_MODEL = options.foundry.model;

  const { stdout } = await execFileAsync('python3', args, {
    env,
    signal: options.signal,
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 1024 * 1024 * 32,
  });
  const lastLine = stdout.trim().split(/\r?\n/).pop() ?? '{}';
  const result = JSON.parse(lastLine) as { ok?: boolean; error?: string; nodeCount?: number; edgeCount?: number; communityCount?: number };
  if (!result.ok) throw new Error(`Knowledge graph build failed: ${result.error ?? 'unknown error'}`);
  return {
    nodeCount: result.nodeCount ?? 0,
    edgeCount: result.edgeCount ?? 0,
    communityCount: result.communityCount ?? 0,
    generatedAt: Date.now(),
  };
}

/**
 * Convert a cached knowledge graph into context structural signals (same shape the context engine
 * consumes). God nodes and high-degree hubs get the strongest, capped boost.
 */
export function knowledgeGraphSignals(graph: KnowledgeGraph): Array<{ path: string; weight: number; reason: string }> {
  const maxDegree = graph.nodes.reduce((max, node) => Math.max(max, node.degree), 0) || 1;
  const signals: Array<{ path: string; weight: number; reason: string }> = [];
  for (const node of graph.nodes) {
    if (node.degree <= 0) continue;
    const base = Math.round((node.degree / maxDegree) * 80);
    const weight = node.isGod ? Math.max(base, 70) : base;
    if (weight <= 0) continue;
    signals.push({
      path: node.path,
      weight,
      reason: node.isGod ? `knowledge-graph god node (degree ${node.degree})` : `knowledge-graph hub (degree ${node.degree})`,
    });
  }
  return signals.sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path)).slice(0, 40);
}

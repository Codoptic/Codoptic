import type { RepoMap, ScannedFile } from '../repo/repoScanner';

/**
 * Heuristic relevance scoring for each file given a diagram type and an
 * optional focus prompt. This pre-filters chunks before LLM summarization
 * so we don't burn tokens on irrelevant code.
 */
export type DiagramKind = 'architecture' | 'sequence' | 'class' | 'data-flow' | 'deployment';

export interface Relevance {
  file: ScannedFile;
  score: number;
  reasons: string[];
}

const WEIGHTS = {
  manifest: 1.0,
  entrypoint: 0.9,
  apiRoute: 0.85,
  component: 0.7,
  schema: 0.8,
  config: 0.55,
  infra: 0.65,
  doc: 0.8,
  test: 0.25,
  generic: 0.3,
};

function baseScore(file: ScannedFile, map: RepoMap): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = WEIGHTS.generic;
  if (map.manifests.includes(file)) {
    score = Math.max(score, WEIGHTS.manifest);
    reasons.push('manifest');
  }
  if (map.entrypoints.includes(file)) {
    score = Math.max(score, WEIGHTS.entrypoint);
    reasons.push('entrypoint');
  }
  if (map.apiRoutes.includes(file)) {
    score = Math.max(score, WEIGHTS.apiRoute);
    reasons.push('api');
  }
  if (map.components.includes(file)) {
    score = Math.max(score, WEIGHTS.component);
    reasons.push('component');
  }
  if (map.schemas.includes(file)) {
    score = Math.max(score, WEIGHTS.schema);
    reasons.push('schema');
  }
  if (map.configs.includes(file)) {
    score = Math.max(score, WEIGHTS.config);
    reasons.push('config');
  }
  if (map.infra.includes(file)) {
    score = Math.max(score, WEIGHTS.infra);
    reasons.push('infra');
  }
  if (map.docs.includes(file)) {
    score = Math.max(score, WEIGHTS.doc);
    reasons.push('doc');
  }
  if (map.tests.includes(file)) {
    score = Math.min(score, WEIGHTS.test);
    reasons.push('test (down-weighted)');
  }
  return { score, reasons };
}

function diagramBias(kind: DiagramKind, file: ScannedFile, map: RepoMap): number {
  switch (kind) {
    case 'architecture':
      if (map.docs.includes(file)) return 0.2;
      if (map.entrypoints.includes(file) || map.apiRoutes.includes(file)) return 0.15;
      if (map.infra.includes(file)) return 0.1;
      return 0;
    case 'sequence':
      if (map.apiRoutes.includes(file)) return 0.25;
      if (file.path.includes('handler') || file.path.includes('controller')) return 0.15;
      return 0;
    case 'class':
      if (file.ext === 'ts' || file.ext === 'tsx' || file.ext === 'java' || file.ext === 'py') return 0.1;
      if (map.schemas.includes(file)) return 0.2;
      return 0;
    case 'data-flow':
      if (map.schemas.includes(file)) return 0.3;
      if (file.path.includes('pipeline') || file.path.includes('etl')) return 0.2;
      return 0;
    case 'deployment':
      if (map.infra.includes(file)) return 0.4;
      if (file.path.includes('ci') || file.path.includes('.github/workflows')) return 0.2;
      return 0;
  }
}

function focusBias(focus: string, file: ScannedFile): number {
  if (!focus.trim()) return 0;
  const tokens = focus
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const lower = file.path.toLowerCase();
  const matches = tokens.filter((t) => lower.includes(t)).length;
  return Math.min(0.5, matches * 0.15);
}

function folderKey(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 1) return '.';
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

export function classifyRelevance(
  map: RepoMap,
  kind: DiagramKind,
  focus: string,
  topK = 40,
): Relevance[] {
  const out: Relevance[] = [];
  for (const file of map.files) {
    const { score, reasons } = baseScore(file, map);
    const total = Math.min(1.5, score + diagramBias(kind, file, map) + focusBias(focus, file));
    if (total < 0.1) continue;
    out.push({ file, score: total, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  if (out.length <= topK) return out;

  const selected: Relevance[] = [];
  const selectedPaths = new Set<string>();
  const selectedFolders = new Set<string>();
  const primaryLimit = Math.max(1, Math.floor(topK * 0.5));

  function add(item: Relevance): void {
    if (selectedPaths.has(item.file.path) || selected.length >= topK) return;
    selected.push(item);
    selectedPaths.add(item.file.path);
    selectedFolders.add(folderKey(item.file.path));
  }

  for (const item of out.slice(0, primaryLimit)) add(item);

  // Motivation vs Logic: huge repos often have one noisy surface area that scores highest, but useful diagrams need architectural breadth. Reserve part of the budget for the best file from folders not yet represented, then fill remaining slots by score.
  for (const item of out) {
    if (!selectedFolders.has(folderKey(item.file.path))) add(item);
    if (selected.length >= topK) return selected;
  }
  for (const item of out) add(item);
  return selected;
}

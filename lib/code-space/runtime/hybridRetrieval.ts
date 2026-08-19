export interface RankedHit {
  id: string;
  rank: number;
}

export function reciprocalRankFusion(lists: RankedHit[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (const hit of list) {
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + hit.rank));
    }
  }
  return scores;
}

export function fuseRankedIds(lists: string[][], limit = 24): string[] {
  const ranked = lists.map((list) => list.map((id, index) => ({ id, rank: index + 1 })));
  return [...reciprocalRankFusion(ranked).entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([id]) => id);
}

export function routeRetrievalQuery(query: string): 'exact' | 'memory' | 'structural' {
  if (/[/\\]|\.(ts|tsx|js|py|go|rs|md)\b|:\d+|Error:|Traceback|at\s+\S+\s+\(/.test(query)) return 'exact';
  if (/\b(prefer|always|never|decision|convention|memory|how do we)\b/i.test(query)) return 'memory';
  if (/\b(depend|import|call site|blast radius|who uses)\b/i.test(query)) return 'structural';
  return 'exact';
}

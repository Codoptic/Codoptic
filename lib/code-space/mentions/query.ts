// Motivation vs Logic: The query service is the brain of the mention picker. It accepts the raw
// token after `@`, the prebuilt index, and a few context hints (open tabs, recent files, current
// editor file), and returns up to N ranked suggestions. The spec calls out five distinct modes
// with different candidate pools and ranking biases, so the entry point is a parser that emits a
// discriminated `ParsedMentionToken` and a per-mode scorer that applies the documented base
// match / scope / context / penalty tables. Fuzzy matching supports camelCase, dash/underscore
// equivalence, and acronym subsequence so `cpanel` resolves to `controlPanel.tsx`.

import { normalizeMentionPath, type FileMentionIndex } from './index';
import { isImportantConfigBasename } from './ignorePolicy';
import type {
  MentionEntry,
  MentionMatchRange,
  MentionMode,
  MentionQueryContext,
  MentionSuggestion,
  ParsedMentionToken,
} from './types';

// --- token parsing -------------------------------------------------------------------------

/**
 * Parse the raw text after `@` (and before the caret) into a structured query plan.
 * Examples:
 *   "" -> rootBrowse
 *   "backend" with backend dir -> directoryBrowse(scopeDir=backend)
 *   "backend/" with backend dir -> directoryBrowse(scopeDir=backend)
 *   "backend/components" with that dir -> directoryBrowse(scopeDir=backend/components)
 *   "backend/comp" -> scopedSearch(scopeDir=backend, query=comp)
 *   "control" -> globalFuzzySearch(query=control)
 *   "app/cont/panel" with no exact dir prefix -> pathFuzzySearch(query=app/cont/panel)
 *   "../secret" -> rejected (traversal flag, mode=globalFuzzySearch with empty query)
 */
export function parseMentionToken(rawToken: string, index: FileMentionIndex): ParsedMentionToken {
  if (typeof rawToken !== 'string') {
    return { token: '', mode: 'rootBrowse', rejectedTraversal: false };
  }

  // Detect traversal *before* normalizeMentionPath strips the segments.
  const stripped = rawToken.replace(/\\/g, '/').replace(/\/+/g, '/');
  const hasTraversal = stripped.split('/').some((segment) => segment === '..');
  if (hasTraversal) {
    return { token: '', mode: 'rootBrowse', rejectedTraversal: true };
  }

  const trailingSlash = stripped.endsWith('/') && stripped.length > 0;
  const normalized = normalizeMentionPath(rawToken);
  if (normalized === null) {
    return { token: '', mode: 'rootBrowse', rejectedTraversal: true };
  }

  if (normalized === '') {
    return { token: '', mode: 'rootBrowse', rejectedTraversal: false };
  }

  if (trailingSlash && index.hasDirectory(normalized)) {
    return { token: normalized, mode: 'directoryBrowse', scopeDir: normalized, rejectedTraversal: false };
  }

  if (index.hasDirectory(normalized)) {
    return { token: normalized, mode: 'directoryBrowse', scopeDir: normalized, rejectedTraversal: false };
  }

  if (normalized.includes('/')) {
    const lastSlash = normalized.lastIndexOf('/');
    const prefix = normalized.slice(0, lastSlash);
    const leaf = normalized.slice(lastSlash + 1);

    if (index.hasDirectory(prefix)) {
      if (leaf === '') {
        return { token: normalized, mode: 'directoryBrowse', scopeDir: prefix, rejectedTraversal: false };
      }
      return { token: normalized, mode: 'scopedSearch', scopeDir: prefix, query: leaf, rejectedTraversal: false };
    }

    return { token: normalized, mode: 'pathFuzzySearch', query: normalized, rejectedTraversal: false };
  }

  return { token: normalized, mode: 'globalFuzzySearch', query: normalized, rejectedTraversal: false };
}

// --- fuzzy matching -----------------------------------------------------------------------

/**
 * Split a basename into "words" for camelCase / dash / underscore / digit-run scoring.
 * Examples:
 *   "controlPanel.tsx" -> ["control", "panel", "tsx"]
 *   "api-client.ts"   -> ["api", "client", "ts"]
 *   "UserController"   -> ["user", "controller"]
 */
function splitWords(input: string): string[] {
  if (!input) return [];
  // Insert separators between camelCase transitions and around digit runs, then split.
  const withBoundaries = input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return withBoundaries
    .split(/[\s\-_./]+/)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
}

function stripSeparators(input: string): string {
  return input.toLowerCase().replace(/[\-_.\s/]+/g, '');
}

interface MatchResult {
  score: number;
  ranges: MentionMatchRange[];
  /** Reason this entry matched (for debug / UI). */
  reason: string;
}

function rangeOnBasename(start: number, end: number): MentionMatchRange[] {
  if (end <= start) return [];
  return [{ field: 'basename', start, end }];
}

function rangeOnPath(start: number, end: number): MentionMatchRange[] {
  if (end <= start) return [];
  return [{ field: 'relativePath', start, end }];
}

/** Find the indices of a subsequence match inside a string. Returns null when not subsequence. */
function findSubsequenceIndices(haystack: string, needle: string): number[] | null {
  if (!needle) return [];
  const indices: number[] = [];
  let cursor = 0;
  for (const ch of needle) {
    const next = haystack.indexOf(ch, cursor);
    if (next === -1) return null;
    indices.push(next);
    cursor = next + 1;
  }
  return indices;
}

function compressIndicesToRanges(
  indices: number[],
  field: 'basename' | 'relativePath',
): MentionMatchRange[] {
  if (indices.length === 0) return [];
  const ranges: MentionMatchRange[] = [];
  let firstIdx = indices[0]!;
  let prev = firstIdx;
  for (let i = 1; i < indices.length; i++) {
    const idx = indices[i]!;
    if (idx === prev + 1) {
      prev = idx;
      continue;
    }
    ranges.push({ field, start: firstIdx, end: prev + 1 });
    firstIdx = idx;
    prev = idx;
  }
  ranges.push({ field, start: firstIdx, end: prev + 1 });
  return ranges;
}

/**
 * Score `entry` against `query` for the base/match table from the spec. Returns null when there
 * is no plausible match. The returned `ranges` are computed against `entry.basename` or
 * `entry.relativePath` and used by the UI to highlight matching characters.
 */
function scoreBaseMatch(entry: MentionEntry, query: string): MatchResult | null {
  if (!query) return { score: 0, ranges: [], reason: 'empty-query' };

  const lowerQuery = query.toLowerCase();
  const basename = entry.basename;
  const lowerName = entry.normalizedName;
  const lowerPath = entry.normalizedPath;
  const lowerNoExt = lowerName.includes('.') ? lowerName.slice(0, lowerName.lastIndexOf('.')) : lowerName;

  // Exact relative-path match.
  if (lowerPath === lowerQuery) {
    return {
      score: 2000,
      ranges: rangeOnPath(0, entry.relativePath.length),
      reason: 'exact-path',
    };
  }

  // Exact basename match (with or without extension).
  if (lowerName === lowerQuery) {
    return {
      score: 1600 + (basename === query ? 50 : 0),
      ranges: rangeOnBasename(0, basename.length),
      reason: 'exact-basename',
    };
  }
  if (lowerNoExt === lowerQuery) {
    return {
      score: 1600,
      ranges: rangeOnBasename(0, lowerNoExt.length),
      reason: 'exact-basename-no-ext',
    };
  }

  // Exact directory path match (token = some directory).
  if (entry.type === 'folder' && lowerPath === lowerQuery) {
    return { score: 1500, ranges: rangeOnPath(0, entry.relativePath.length), reason: 'exact-dir' };
  }

  // Basename starts-with prefix (different boost for folders vs files).
  if (lowerName.startsWith(lowerQuery)) {
    return {
      score: entry.type === 'folder' ? 1150 : 1200,
      ranges: rangeOnBasename(0, lowerQuery.length),
      reason: 'basename-prefix',
    };
  }

  // Some path segment starts-with the query.
  const segIndex = entry.segments.findIndex((segment) =>
    segment.toLowerCase().startsWith(lowerQuery),
  );
  if (segIndex !== -1) {
    const segment = entry.segments[segIndex]!;
    const offset = entry.segments.slice(0, segIndex).reduce((sum, s) => sum + s.length + 1, 0);
    const startOnPath = offset;
    const endOnPath = offset + lowerQuery.length;
    const startOnBase = segIndex === entry.segments.length - 1 ? 0 : -1;
    const ranges: MentionMatchRange[] =
      startOnBase >= 0 ? rangeOnBasename(0, lowerQuery.length) : rangeOnPath(startOnPath, endOnPath);
    return {
      score: 900,
      ranges,
      reason: `segment-prefix:${segment}`,
    };
  }

  // Basename contains query.
  const containsIdx = lowerName.indexOf(lowerQuery);
  if (containsIdx !== -1) {
    return {
      score: 750,
      ranges: rangeOnBasename(containsIdx, containsIdx + lowerQuery.length),
      reason: 'basename-contains',
    };
  }

  // Path segment contains query.
  for (let i = 0; i < entry.segments.length; i++) {
    const segLower = entry.segments[i]!.toLowerCase();
    const idx = segLower.indexOf(lowerQuery);
    if (idx === -1) continue;
    const offset = entry.segments.slice(0, i).reduce((sum, s) => sum + s.length + 1, 0);
    return {
      score: 550,
      ranges: rangeOnPath(offset + idx, offset + idx + lowerQuery.length),
      reason: 'segment-contains',
    };
  }

  // Full path contains query.
  const pathIdx = lowerPath.indexOf(lowerQuery);
  if (pathIdx !== -1) {
    return {
      score: 400,
      ranges: rangeOnPath(pathIdx, pathIdx + lowerQuery.length),
      reason: 'path-contains',
    };
  }

  // CamelCase / acronym match: query is the leading letters of the basename's word list.
  const words = splitWords(basename);
  if (words.length > 1 && lowerQuery.length >= 2 && lowerQuery.length <= words.length) {
    let camelHit = true;
    for (let i = 0; i < lowerQuery.length; i++) {
      const word = words[i];
      if (!word || word[0] !== lowerQuery[i]) {
        camelHit = false;
        break;
      }
    }
    if (camelHit) {
      return { score: 500, ranges: rangeOnBasename(0, basename.length), reason: 'camel-acronym' };
    }
  }

  // Separator-stripped equivalence (`api-client` ≡ `apiClient` ≡ `api_client`).
  const compactName = stripSeparators(basename);
  const compactQuery = stripSeparators(query);
  if (compactQuery && compactName.includes(compactQuery)) {
    return { score: 480, ranges: rangeOnBasename(0, basename.length), reason: 'compact-contains' };
  }

  // Fuzzy subsequence on the basename. Compactness boosts the score.
  if (lowerQuery.length >= 3) {
    const indices = findSubsequenceIndices(lowerName, lowerQuery);
    if (indices && indices.length === lowerQuery.length) {
      const first = indices[0]!;
      const last = indices[indices.length - 1]!;
      const span = last - first + 1;
      const density = lowerQuery.length / span;
      const score = 250 + Math.round(density * 200);
      return {
        score,
        ranges: compressIndicesToRanges(indices, 'basename'),
        reason: 'fuzzy-subseq',
      };
    }
  }

  return null;
}

// --- scoring & boosts ---------------------------------------------------------------------

interface ScoringContext {
  mode: MentionMode;
  scopeDir?: string;
  query: string;
  index: FileMentionIndex;
  openFiles: Set<string>;
  recentFiles: Set<string>;
  recentEdits: Set<string>;
  currentEditorFilePath?: string;
  currentEditorParent?: string;
}

function applyBrowseBoost(entry: MentionEntry, ctx: ScoringContext): number {
  let bonus = 0;
  if (ctx.mode === 'rootBrowse') {
    if (entry.depth === 1) bonus += 500;
    else if (entry.depth === 2) bonus += 200;
    else bonus += 50;
    if (ctx.openFiles.has(entry.relativePath)) bonus += 700;
    if (ctx.currentEditorFilePath === entry.relativePath) bonus += 850;
  }
  if (ctx.mode === 'directoryBrowse' && ctx.scopeDir !== undefined) {
    const scopeDepth = ctx.scopeDir === '' ? 0 : ctx.scopeDir.split('/').length;
    if (entry.depth === scopeDepth + 1) bonus += 500;
    else if (entry.depth === scopeDepth + 2) bonus += 200;
  }
  if (ctx.mode === 'scopedSearch' && ctx.scopeDir !== undefined) {
    const scopeDepth = ctx.scopeDir === '' ? 0 : ctx.scopeDir.split('/').length;
    if (entry.depth === scopeDepth + 1) bonus += 350;
    else bonus += 150;
  }
  return bonus;
}

function applyContextBoost(entry: MentionEntry, ctx: ScoringContext): number {
  let bonus = 0;
  if (ctx.openFiles.has(entry.relativePath)) bonus += 180;
  if (ctx.recentFiles.has(entry.relativePath)) bonus += 120;
  if (ctx.recentEdits.has(entry.relativePath)) bonus += 100;
  if (ctx.currentEditorParent !== undefined && entry.parentPath === ctx.currentEditorParent) {
    bonus += entry.relativePath === ctx.currentEditorFilePath ? 0 : 90;
    if (entry.type === 'file' && entry.relativePath !== ctx.currentEditorFilePath) bonus += 80;
  }
  if (entry.isImportantConfig) bonus += 90;
  if (entry.type === 'file' && /^(README|AGENTS|CHANGELOG|CONTRIBUTING)\b/i.test(entry.basename)) {
    bonus += 80;
  }
  return bonus;
}

function applyPenalties(entry: MentionEntry, ctx: ScoringContext): number {
  let penalty = 0;
  if (entry.isHidden && !ctx.query.startsWith('.') && !(ctx.scopeDir ?? '').startsWith('.')) {
    penalty -= 80;
  }
  // Depth penalty grows with how deep an entry sits, but we don't apply it during a directory
  // browse (in browse modes the user explicitly asked for that depth).
  if (ctx.mode !== 'directoryBrowse' && ctx.mode !== 'rootBrowse') {
    penalty -= entry.depth * 12;
  }
  if (entry.isBinary && entry.normalizedName !== ctx.query.toLowerCase()) penalty -= 300;
  if (entry.isLockFile && ctx.mode !== 'rootBrowse') penalty -= 50;
  if ((entry.size ?? 0) > 1_500_000 && entry.normalizedName !== ctx.query.toLowerCase()) {
    penalty -= 120;
  }
  return penalty;
}

function entryDisplayName(entry: MentionEntry): string {
  return entry.type === 'folder' ? `${entry.basename}/` : entry.basename;
}

function badgesFor(entry: MentionEntry, ctx: ScoringContext): MentionSuggestion['badges'] {
  const badges: Array<'open' | 'recent' | 'root' | 'folder' | 'current-dir'> = [];
  if (ctx.openFiles.has(entry.relativePath)) badges.push('open');
  if (ctx.recentFiles.has(entry.relativePath)) badges.push('recent');
  if (entry.depth === 1 && ctx.mode === 'rootBrowse') badges.push('root');
  if (entry.type === 'folder') badges.push('folder');
  if (ctx.currentEditorParent !== undefined && entry.parentPath === ctx.currentEditorParent) {
    badges.push('current-dir');
  }
  return badges;
}

function toSuggestion(
  entry: MentionEntry,
  score: number,
  ranges: MentionMatchRange[],
  reason: string,
  ctx: ScoringContext,
): MentionSuggestion {
  return {
    id: entry.id,
    type: entry.type,
    basename: entry.basename,
    displayName: entryDisplayName(entry),
    relativePath: entry.relativePath,
    parentPath: entry.parentPath,
    tooltip: entry.relativePath,
    score,
    matchRanges: ranges,
    reason,
    badges: badgesFor(entry, ctx),
  };
}

// --- candidate pools ----------------------------------------------------------------------

function appendEntriesByPath(
  pool: MentionEntry[],
  index: FileMentionIndex,
  paths: ReadonlyArray<string | undefined>,
): MentionEntry[] {
  const seen = new Set(pool.map((entry) => entry.id));
  for (const rawPath of paths) {
    const normalized = normalizeMentionPath(rawPath ?? '');
    if (normalized === null || normalized === '') continue;
    const entry = index.byPath.get(normalized);
    if (!entry || seen.has(entry.id)) continue;
    pool.push(entry);
    seen.add(entry.id);
  }
  return pool;
}

function poolForRootBrowse(
  index: FileMentionIndex,
  openFiles: ReadonlyArray<string>,
  currentEditorFilePath?: string,
): MentionEntry[] {
  const roots = index.rootEntries();
  const pool = [...roots];
  if (roots.length < 20) {
    // Backfill with depth-2 entries so projects with thin root layouts still show useful options.
    const depth2 = index.entries.filter((entry) => entry.depth === 2);
    for (const entry of depth2) {
      if (!pool.some((candidate) => candidate.id === entry.id)) pool.push(entry);
    }
  }
  // Always surface the currently open editor tabs in the empty-`@` default pool, even when they
  // live deeper than the root/depth-2 backfill.
  return appendEntriesByPath(pool, index, [...openFiles, currentEditorFilePath]);
}

function poolForDirectoryBrowse(index: FileMentionIndex, scopeDir: string): MentionEntry[] {
  const direct = index.childrenOf(scopeDir);
  if (direct.length >= 10) return direct;
  const scopeDepth = scopeDir === '' ? 0 : scopeDir.split('/').length;
  const extra = index.descendantsOf(scopeDir).filter((entry) => entry.depth <= scopeDepth + 2);
  const seen = new Set(direct.map((entry) => entry.id));
  for (const entry of extra) {
    if (!seen.has(entry.id)) {
      direct.push(entry);
      seen.add(entry.id);
    }
  }
  return direct;
}

function poolForScopedSearch(index: FileMentionIndex, scopeDir: string): MentionEntry[] {
  return index.descendantsOf(scopeDir);
}

function poolForGlobal(index: FileMentionIndex): MentionEntry[] {
  return index.entries;
}

// --- main query ---------------------------------------------------------------------------

/**
 * Compute up to `maxResults` ranked suggestions for the supplied raw token.
 * The function is pure (no IO, no side-effects) and runs over precomputed index data, so it's
 * safe to call on every keystroke even for large projects.
 */
export function queryMentionSuggestions(
  index: FileMentionIndex,
  context: MentionQueryContext,
): MentionSuggestion[] {
  const parsed = parseMentionToken(context.rawToken, index);
  if (parsed.rejectedTraversal) return [];

  const maxResults = context.maxResults ?? 10;
  const openFiles = new Set(context.openFiles ?? []);
  const recentFiles = new Set(context.recentFiles ?? []);
  const recentEdits = new Set<string>();
  const currentEditorFilePath = context.currentEditorFilePath;
  const currentEditorParent = currentEditorFilePath
    ? currentEditorFilePath.includes('/')
      ? currentEditorFilePath.slice(0, currentEditorFilePath.lastIndexOf('/'))
      : ''
    : undefined;

  const scoringCtx: ScoringContext = {
    mode: parsed.mode,
    scopeDir: parsed.scopeDir,
    query: parsed.query ?? '',
    index,
    openFiles,
    recentFiles,
    recentEdits,
    currentEditorFilePath,
    currentEditorParent,
  };

  let pool: MentionEntry[];
  switch (parsed.mode) {
    case 'rootBrowse':
      pool = poolForRootBrowse(index, context.openFiles ?? [], context.currentEditorFilePath);
      break;
    case 'directoryBrowse':
      pool = poolForDirectoryBrowse(index, parsed.scopeDir ?? '');
      break;
    case 'scopedSearch':
      pool = poolForScopedSearch(index, parsed.scopeDir ?? '');
      break;
    case 'globalFuzzySearch':
    case 'pathFuzzySearch':
      pool = poolForGlobal(index);
      break;
  }

  const scored: Array<{
    entry: MentionEntry;
    score: number;
    ranges: MentionMatchRange[];
    reason: string;
  }> = [];

  for (const entry of pool) {
    if (entry.isIgnored) continue;

    let baseScore = 0;
    let ranges: MentionMatchRange[] = [];
    let reason: string = parsed.mode;

    if (parsed.mode === 'rootBrowse' || parsed.mode === 'directoryBrowse') {
      // Browse modes don't fuzzy-match; everything in the pool is shown if it survives penalties.
      baseScore = 100;
      reason = parsed.mode;
    } else if (parsed.mode === 'pathFuzzySearch') {
      // Path fuzzy: score the LEAF segment against the basename + reward when prior segments of
      // the query align with the entry's path segments in order. Without this split, a multi-
      // segment query like `app/cont/panel` is never going to match a basename like
      // `controlPanel.tsx` directly.
      const queryStr = parsed.query ?? '';
      const querySegments = queryStr.split('/').filter(Boolean);
      const leaf = querySegments[querySegments.length - 1] ?? '';
      const matched = scoreBaseMatch(entry, leaf);
      if (matched === null) continue;
      baseScore = matched.score;
      ranges = matched.ranges;
      reason = matched.reason;

      let cursor = 0;
      let aligned = 0;
      for (let i = 0; i < querySegments.length - 1; i++) {
        const querySeg = querySegments[i]!.toLowerCase();
        const foundAt = entry.segments.findIndex(
          (segment, idx) => idx >= cursor && segment.toLowerCase().includes(querySeg),
        );
        if (foundAt === -1) {
          aligned = -1;
          break;
        }
        aligned++;
        cursor = foundAt + 1;
      }
      // Require every directory segment to align; otherwise the entry doesn't represent the
      // user's intent (e.g. `docs/app-control-panel.md` shouldn't outrank deeper aligned hits).
      if (aligned === -1) continue;
      baseScore += aligned * 120;
    } else {
      const queryStr = parsed.query ?? '';
      const matched = scoreBaseMatch(entry, queryStr);
      if (matched === null) continue;
      baseScore = matched.score;
      ranges = matched.ranges;
      reason = matched.reason;

      if (parsed.mode === 'scopedSearch' && parsed.scopeDir !== undefined) {
        const prefix = parsed.scopeDir === '' ? '' : `${parsed.scopeDir}/`;
        if (parsed.scopeDir !== '' && !entry.relativePath.startsWith(prefix)) continue;
      }
    }

    let score = baseScore;
    score += applyBrowseBoost(entry, scoringCtx);
    score += applyContextBoost(entry, scoringCtx);
    score += applyPenalties(entry, scoringCtx);

    if (parsed.mode === 'directoryBrowse' && entry.type === 'folder') {
      // Folders rank above files in directory browse (spec tie-breaker rule).
      score += 60;
    }

    if (parsed.mode === 'rootBrowse' && entry.isImportantConfig) {
      // Spec example for `@` puts README.md and package.json above generic folders.
      score += 120;
    }

    if (entry.isHidden && (parsed.query ?? '').startsWith('.')) {
      // Counter the hidden penalty when the user explicitly typed a dot prefix.
      score += 80;
    }

    scored.push({ entry, score, ranges, reason });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.entry.depth !== b.entry.depth) return a.entry.depth - b.entry.depth;
    // Folders before files in browse modes; files before folders in fuzzy modes (only when score
    // is tied, by virtue of falling through the prior comparisons).
    if (a.entry.type !== b.entry.type) {
      const folderFirst = parsed.mode === 'rootBrowse' || parsed.mode === 'directoryBrowse';
      if (folderFirst) return a.entry.type === 'folder' ? -1 : 1;
      return a.entry.type === 'file' ? -1 : 1;
    }
    return a.entry.basename.localeCompare(b.entry.basename, undefined, { sensitivity: 'base' });
  });

  return scored
    .slice(0, maxResults)
    .map((item) => toSuggestion(item.entry, item.score, item.ranges, item.reason, scoringCtx));
}

export interface DiffHunk {
  id: string;
  index: number;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export type DiffHunkStatus = Record<string, 'accepted' | 'rejected'>;

function parseHunkHeader(header: string): Pick<DiffHunk, 'oldStart' | 'oldCount' | 'newStart' | 'newCount'> | null {
  const match = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/);
  if (!match) return null;
  return {
    oldStart: Number.parseInt(match[1] ?? '1', 10),
    oldCount: Number.parseInt(match[2] ?? '1', 10),
    newStart: Number.parseInt(match[3] ?? '1', 10),
    newCount: Number.parseInt(match[4] ?? '1', 10),
  };
}

function syntheticHunk(oldContent: string, newContent: string): DiffHunk {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  return {
    id: 'hunk:0',
    index: 0,
    header: '@@ full file change @@',
    oldStart: 1,
    oldCount: oldLines.length,
    newStart: 1,
    newCount: newLines.length,
    lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
  };
}

export function splitUnifiedDiffIntoHunks(unifiedDiff: string | undefined, oldContent: string, newContent: string): DiffHunk[] {
  if (!unifiedDiff) return [syntheticHunk(oldContent, newContent)];

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      const parsed = parseHunkHeader(line);
      current = {
        id: `hunk:${hunks.length}`,
        index: hunks.length,
        header: line,
        oldStart: parsed?.oldStart ?? 1,
        oldCount: parsed?.oldCount ?? 0,
        newStart: parsed?.newStart ?? 1,
        newCount: parsed?.newCount ?? 0,
        lines: [],
      };
      continue;
    }

    if (!current || line.startsWith('---') || line.startsWith('+++')) continue;
    current.lines.push(line);
  }

  if (current) hunks.push(current);
  return hunks.length ? hunks : [syntheticHunk(oldContent, newContent)];
}

export function acceptedHunkIdSet(status: DiffHunkStatus, extraAcceptedHunkId?: string): Set<string> {
  const ids = new Set<string>();
  for (const [hunkId, value] of Object.entries(status)) {
    if (value === 'accepted') ids.add(hunkId);
  }
  if (extraAcceptedHunkId) ids.add(extraAcceptedHunkId);
  return ids;
}

export function applyAcceptedDiffHunks(originalContent: string, hunks: DiffHunk[], acceptedIds: ReadonlySet<string>): string {
  const originalLines = originalContent.split('\n');
  const orderedHunks = [...hunks].sort((a, b) => a.oldStart - b.oldStart || a.index - b.index);
  const nextLines: string[] = [];
  let cursor = 0;

  for (const hunk of orderedHunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    const end = Math.max(start, start + hunk.oldCount);
    nextLines.push(...originalLines.slice(cursor, start));

    if (acceptedIds.has(hunk.id)) {
      nextLines.push(
        ...hunk.lines
          .filter((line) => line.startsWith(' ') || line.startsWith('+'))
          .map((line) => line.slice(1)),
      );
    } else {
      nextLines.push(...originalLines.slice(start, end));
    }

    cursor = end;
  }

  nextLines.push(...originalLines.slice(cursor));
  return nextLines.join('\n');
}

export function everyHunkResolved(hunks: DiffHunk[], status: DiffHunkStatus): boolean {
  return hunks.every((hunk) => status[hunk.id] === 'accepted' || status[hunk.id] === 'rejected');
}

export interface CodeSpacePendingDiff {
  diffId: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  deleted?: boolean;
  explanation?: string;
  unifiedDiff?: string;
  hunks: DiffHunk[];
  hunkStatus: DiffHunkStatus;
  applyingHunkId?: string;
  applyingAll?: boolean;
  error?: string;
}

export interface DiffLineCounts {
  added: number;
  removed: number;
}

export function countHunkLines(hunk: DiffHunk): DiffLineCounts {
  let added = 0;
  let removed = 0;
  for (const line of hunk.lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

export function countDiffLines(unifiedDiff?: string, hunks?: DiffHunk[]): DiffLineCounts {
  if (hunks?.length) {
    return hunks.reduce(
      (totals, hunk) => {
        const counts = countHunkLines(hunk);
        return { added: totals.added + counts.added, removed: totals.removed + counts.removed };
      },
      { added: 0, removed: 0 },
    );
  }

  if (!unifiedDiff) return { added: 0, removed: 0 };

  let added = 0;
  let removed = 0;
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

export function unresolvedHunks(hunks: DiffHunk[], status: DiffHunkStatus): DiffHunk[] {
  return hunks.filter((hunk) => !status[hunk.id]);
}

export function hasAcceptedHunks(status: DiffHunkStatus): boolean {
  return Object.values(status).some((value) => value === 'accepted');
}

export function resolvedContentForHunk(diff: CodeSpacePendingDiff, extraAcceptedHunkId?: string): string {
  const acceptedIds = acceptedHunkIdSet(diff.hunkStatus, extraAcceptedHunkId);
  if (diff.deleted) return acceptedIds.size > 0 ? '' : diff.oldContent;
  return applyAcceptedDiffHunks(diff.oldContent, diff.hunks, acceptedIds);
}

export type InlineReviewLineKind = 'plain' | 'added' | 'removed' | 'context';

export interface InlineReviewLineMeta {
  hunkId?: string;
  kind: InlineReviewLineKind;
}

export interface InlinePatchReviewModel {
  content: string;
  lineMeta: InlineReviewLineMeta[];
}

function hunkDiffLineText(line: string): string {
  if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) return line.slice(1);
  return line;
}

function hunkDiffLineKind(line: string): InlineReviewLineKind {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'added';
  if (line.startsWith('-') && !line.startsWith('---')) return 'removed';
  return 'context';
}

// Motivation vs Logic: Cursor-style review keeps pending hunks inside the Monaco buffer (added/removed/context
// rows with line numbers) instead of a detached PATCH view-zone block.
export function buildInlinePatchReviewModel(
  originalContent: string,
  hunks: DiffHunk[],
  acceptedIds: ReadonlySet<string>,
  hunkStatus: DiffHunkStatus = {},
): InlinePatchReviewModel {
  const originalLines = originalContent.split('\n');
  const orderedHunks = [...hunks].sort((a, b) => a.oldStart - b.oldStart || a.index - b.index);
  const lines: string[] = [];
  const lineMeta: InlineReviewLineMeta[] = [];
  let cursor = 0;

  const push = (text: string, meta: InlineReviewLineMeta) => {
    lines.push(text);
    lineMeta.push(meta);
  };

  for (const hunk of orderedHunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    const end = Math.max(start, start + hunk.oldCount);

    for (let index = cursor; index < start; index += 1) {
      push(originalLines[index] ?? '', { kind: 'plain' });
    }

    if (acceptedIds.has(hunk.id)) {
      for (const line of hunk.lines) {
        if (line.startsWith(' ') || line.startsWith('+')) {
          push(hunkDiffLineText(line), { kind: 'plain', hunkId: hunk.id });
        }
      }
    } else if (hunkStatus[hunk.id] === 'rejected') {
      for (let index = start; index < end; index += 1) {
        push(originalLines[index] ?? '', { kind: 'plain' });
      }
    } else {
      for (const line of hunk.lines) {
        if (line.startsWith('---') || line.startsWith('+++')) continue;
        push(hunkDiffLineText(line), { hunkId: hunk.id, kind: hunkDiffLineKind(line) });
      }
    }

    cursor = end;
  }

  for (let index = cursor; index < originalLines.length; index += 1) {
    push(originalLines[index] ?? '', { kind: 'plain' });
  }

  return { content: lines.join('\n'), lineMeta };
}

export function hunkLineRangeInInlineReview(
  lineMeta: readonly InlineReviewLineMeta[],
  targetHunkId: string,
): { startLine: number; endLine: number } | null {
  let startLine = 0;
  let endLine = 0;
  for (let index = 0; index < lineMeta.length; index += 1) {
    if (lineMeta[index]?.hunkId !== targetHunkId) continue;
    const lineNumber = index + 1;
    if (!startLine) startLine = lineNumber;
    endLine = lineNumber;
  }
  return startLine ? { startLine, endLine } : null;
}

// Root Cause vs Logic: accept must honor in-buffer edits; when the user changes line count we fall back to the
// structured hunk merge so patch application never sends corrupted content.
export function fileContentFromInlineReviewEditor(
  editorLines: readonly string[],
  lineMeta: readonly InlineReviewLineMeta[],
  originalContent: string,
  hunks: DiffHunk[],
  hunkStatus: DiffHunkStatus,
  extraAcceptedHunkId?: string,
): string {
  if (editorLines.length !== lineMeta.length) {
    return resolvedContentForHunk({ oldContent: originalContent, hunks, hunkStatus, diffId: '', filePath: '', newContent: '' }, extraAcceptedHunkId);
  }

  const acceptedIds = acceptedHunkIdSet(hunkStatus, extraAcceptedHunkId);
  const originalLines = originalContent.split('\n');
  const output: string[] = [];
  let index = 0;

  while (index < lineMeta.length) {
    const meta = lineMeta[index];
    if (!meta?.hunkId) {
      output.push(editorLines[index] ?? '');
      index += 1;
      continue;
    }

    const hunkId = meta.hunkId;
    const hunk = hunks.find((item) => item.id === hunkId);
    const start = hunk ? Math.max(0, hunk.oldStart - 1) : 0;
    const end = hunk ? Math.max(start, start + hunk.oldCount) : start;

    if (hunkStatus[hunkId] === 'rejected' || !acceptedIds.has(hunkId)) {
      output.push(...originalLines.slice(start, end));
      while (index < lineMeta.length && lineMeta[index]?.hunkId === hunkId) index += 1;
      continue;
    }

    while (index < lineMeta.length && lineMeta[index]?.hunkId === hunkId) {
      const row = lineMeta[index];
      if (row?.kind !== 'removed') output.push(editorLines[index] ?? '');
      index += 1;
    }
  }

  return output.join('\n');
}

// Motivation vs Logic: partial hunk accepts shift line numbers in the merged editor buffer; inline review uses
// buildInlinePatchReviewModel so content widgets and decorations anchor to real editor lines.
export function hunkAnchorLineInMergedContent(
  originalContent: string,
  hunks: DiffHunk[],
  acceptedIds: ReadonlySet<string>,
  targetHunkId: string,
  hunkStatus: DiffHunkStatus = {},
): number {
  const { lineMeta } = buildInlinePatchReviewModel(originalContent, hunks, acceptedIds, hunkStatus);
  const range = hunkLineRangeInInlineReview(lineMeta, targetHunkId);
  return range?.startLine ?? 1;
}

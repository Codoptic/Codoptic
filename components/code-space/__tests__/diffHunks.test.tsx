import { describe, expect, it } from 'vitest';
import {
  buildInlinePatchReviewModel,
  countDiffLines,
  countHunkLines,
  fileContentFromInlineReviewEditor,
  hunkAnchorLineInMergedContent,
  hunkLineRangeInInlineReview,
  splitUnifiedDiffIntoHunks,
  acceptedHunkIdSet,
} from '../diffHunks';

describe('countDiffLines', () => {
  it('counts added and removed lines from a unified diff', () => {
    const unifiedDiff = ['@@ -1,2 +1,2 @@', '-old', '+new', ' context'].join('\n');
    expect(countDiffLines(unifiedDiff)).toEqual({ added: 1, removed: 1 });
  });

  it('aggregates counts across hunks', () => {
    const hunks = splitUnifiedDiffIntoHunks(
      ['@@ -1,1 +1,2 @@', '-a', '+b', '+c', '@@ -4,1 +5,1 @@', '-d', '+e'].join('\n'),
      'a\nx\nd',
      'b\nc\nx\ne',
    );
    expect(countDiffLines(undefined, hunks)).toEqual({ added: 3, removed: 2 });
  });
});

describe('countHunkLines', () => {
  it('counts only changed rows inside a hunk', () => {
    const hunks = splitUnifiedDiffIntoHunks('@@ -1 +1 @@\n-old\n+new\n context', 'old', 'new');
    const hunk = hunks[0];
    expect(hunk).toBeDefined();
    expect(countHunkLines(hunk!)).toEqual({ added: 1, removed: 1 });
  });
});

describe('buildInlinePatchReviewModel', () => {
  it('inlines pending hunks with added and removed rows in the buffer', () => {
    const hunks = splitUnifiedDiffIntoHunks('@@ -1 +1 @@\n-old\n+new', 'old', 'new');
    const model = buildInlinePatchReviewModel('old', hunks, new Set());
    expect(model.content).toBe('old\nnew');
    expect(model.lineMeta).toEqual([
      { hunkId: 'hunk:0', kind: 'removed' },
      { hunkId: 'hunk:0', kind: 'added' },
    ]);
  });
});

describe('fileContentFromInlineReviewEditor', () => {
  it('uses edited added lines when accepting a hunk', () => {
    const hunks = splitUnifiedDiffIntoHunks('@@ -1 +1 @@\n-old\n+new', 'old', 'new');
    const model = buildInlinePatchReviewModel('old', hunks, new Set());
    const edited = ['old', 'edited'];
    const result = fileContentFromInlineReviewEditor(edited, model.lineMeta, 'old', hunks, {}, 'hunk:0');
    expect(result).toBe('edited');
  });
});

describe('hunkLineRangeInInlineReview', () => {
  it('returns the first and last line for a pending hunk', () => {
    const hunks = splitUnifiedDiffIntoHunks('@@ -1,2 +1,2 @@\n-a\n+b\n context', 'a\nx', 'b\nx');
    const model = buildInlinePatchReviewModel('a\nx', hunks, new Set());
    expect(hunkLineRangeInInlineReview(model.lineMeta, 'hunk:0')).toEqual({ startLine: 1, endLine: 3 });
  });
});

describe('hunkAnchorLineInMergedContent', () => {
  it('tracks anchor lines after earlier hunks are accepted', () => {
    const hunks = splitUnifiedDiffIntoHunks(
      ['@@ -1,1 +1,2 @@', '-a', '+b', '+c', '@@ -3,1 +4,1 @@', '-tail', '+end'].join('\n'),
      'a\nmid\ntail',
      'b\nc\nmid\nend',
    );
    const firstHunk = hunks[0];
    const secondHunk = hunks[1];
    expect(firstHunk).toBeDefined();
    expect(secondHunk).toBeDefined();
    const accepted = acceptedHunkIdSet({ [firstHunk!.id]: 'accepted' });
    expect(hunkAnchorLineInMergedContent('a\nmid\ntail', hunks, accepted, secondHunk!.id)).toBe(4);
  });
});

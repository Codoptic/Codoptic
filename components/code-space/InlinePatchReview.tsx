'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { configureMonacoForCodeFiles } from '@/components/editor/monacoDefaults';
import { registerDslLanguage } from '@/components/editor/dslLanguage';
import {
  acceptedHunkIdSet,
  applyAcceptedDiffHunks,
  countDiffLines,
  countHunkLines,
  hunkAnchorLineInMergedContent,
  unresolvedHunks,
  type CodeSpacePendingDiff,
  type DiffHunk,
} from '@/components/code-space/diffHunks';

interface InlinePatchReviewProps {
  filePath: string;
  language: string;
  theme: 'codoptic-light' | 'codoptic-dark';
  diff: CodeSpacePendingDiff;
  minimapEnabled: boolean;
  wordWrap: boolean;
  onAcceptHunk: (hunkId: string) => void;
  onRejectHunk: (hunkId: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onEditorMount?: OnMount;
}

function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

function renderDiffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'code-space-diff-added-line text-[#3fb950]';
  if (line.startsWith('-') && !line.startsWith('---')) return 'code-space-diff-removed-line text-[#f85149]';
  if (line.startsWith('@@')) return 'text-[#79c0ff]';
  return 'text-[#c9d1d9]';
}

// Motivation vs Logic: keyboard hints in the action footer use the compact glyph form (⌘⌫, ⌘⏎,
// Ctrl⌫, Ctrl⏎) so each button can hold "Action" + shortcut on a single Cursor-style pill without
// wrapping inside the narrow Monaco view-zone width.
function shortcutGlyphs(modLabel: string): { reject: string; accept: string } {
  if (modLabel === '⌘') return { reject: '⌘⌫', accept: '⌘⏎' };
  return { reject: 'Ctrl⌫', accept: 'Ctrl⏎' };
}

function appendHunkActionFooter(
  container: HTMLDivElement,
  hunk: DiffHunk,
  counts: { added: number; removed: number },
  isBusy: boolean,
  isResolved: boolean,
  status: 'accepted' | 'rejected' | undefined,
  modLabel: string,
  onAccept: () => void,
  onReject: () => void,
): void {
  const footer = document.createElement('div');
  footer.className =
    'code-space-inline-hunk-actions flex items-center justify-end gap-2 border-t border-[#1f242d] bg-[#0d1117] px-2 py-1 text-[10px]';
  footer.dataset.hunkId = hunk.id;

  const count = document.createElement('span');
  count.className = 'mr-auto whitespace-nowrap text-[#8b949e]';
  count.innerHTML = `<span class="text-[#3fb950]">+${counts.added}</span> <span class="text-[#f85149]">-${counts.removed}</span>`;
  footer.appendChild(count);

  if (status) {
    const badge = document.createElement('span');
    badge.className =
      status === 'accepted'
        ? 'whitespace-nowrap uppercase tracking-wider text-[#3fb950]'
        : 'whitespace-nowrap uppercase tracking-wider text-[#f85149]';
    badge.textContent = status;
    footer.appendChild(badge);
  }

  const glyphs = shortcutGlyphs(modLabel);

  const rejectButton = document.createElement('button');
  rejectButton.type = 'button';
  rejectButton.disabled = isBusy || isResolved;
  rejectButton.className =
    'inline-flex items-center gap-1 whitespace-nowrap rounded border border-[#30363d] px-2 py-0.5 leading-none text-[#f85149] hover:bg-[#2d1517] disabled:cursor-not-allowed disabled:opacity-40';
  rejectButton.innerHTML = `<span>Reject</span><span class="text-[9px] text-[#8b949e]">${glyphs.reject}</span>`;
  rejectButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onReject();
  });
  footer.appendChild(rejectButton);

  const acceptButton = document.createElement('button');
  acceptButton.type = 'button';
  acceptButton.disabled = isBusy || isResolved;
  acceptButton.className =
    'inline-flex items-center gap-1 whitespace-nowrap rounded bg-[#238636] px-2 py-0.5 leading-none text-white hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-40';
  acceptButton.innerHTML = isBusy
    ? '<span>Applying…</span>'
    : `<span>Accept</span><span class="text-[9px] text-white/80">${glyphs.accept}</span>`;
  acceptButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onAccept();
  });
  footer.appendChild(acceptButton);

  container.appendChild(footer);
}

interface HunkBlockOptions {
  hunk: DiffHunk;
  counts: { added: number; removed: number };
  isBusy: boolean;
  isResolved: boolean;
  status: 'accepted' | 'rejected' | undefined;
  modLabel: string;
  onAccept: () => void;
  onReject: () => void;
}

// Motivation vs Logic: keep the patch preview and the action footer inside a single Monaco view
// zone so the buttons render exactly underneath the diff hunk (not as a floating ContentWidget
// above the anchor line). This eliminates the "external" look and guarantees the buttons share
// the same width constraints as the preview body, so the inline row never collapses vertically.
function createHunkBlockNode(options: HunkBlockOptions): HTMLDivElement {
  const { hunk, counts, isBusy, isResolved, status, modLabel, onAccept, onReject } = options;
  const container = document.createElement('div');
  container.className =
    'code-space-inline-hunk-preview border border-[#30363d] bg-[#0d1117] font-mono text-[11px] leading-5';
  container.dataset.hunkId = hunk.id;

  const header = document.createElement('div');
  header.className =
    'border-b border-[#1f242d] bg-[#111827] px-3 py-1 text-[9px] uppercase tracking-wider text-[#79c0ff]';
  header.textContent = `Patch ${hunk.index + 1}`;
  container.appendChild(header);

  const body = document.createElement('div');
  body.className = 'overflow-hidden py-0.5';
  for (const line of hunk.lines) {
    const row = document.createElement('div');
    row.className = `whitespace-pre-wrap break-all px-3 ${renderDiffLineClass(line)}`;
    row.textContent = line || ' ';
    body.appendChild(row);
  }
  container.appendChild(body);

  appendHunkActionFooter(container, hunk, counts, isBusy, isResolved, status, modLabel, onAccept, onReject);
  return container;
}

export function InlinePatchReview({
  filePath,
  language,
  theme,
  diff,
  minimapEnabled,
  wordWrap,
  onAcceptHunk,
  onRejectHunk,
  onAcceptAll,
  onRejectAll,
  onEditorMount,
}: InlinePatchReviewProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const viewZoneIdsRef = useRef<string[]>([]);
  const modLabel = isMacLike() ? '⌘' : 'Ctrl+';

  const acceptedIds = useMemo(() => acceptedHunkIdSet(diff.hunkStatus), [diff.hunkStatus]);
  const editorContent = useMemo(() => {
    if (diff.deleted && acceptedIds.size === 0) return diff.oldContent;
    return applyAcceptedDiffHunks(diff.oldContent, diff.hunks, acceptedIds);
  }, [acceptedIds, diff.deleted, diff.hunks, diff.oldContent]);

  const pendingHunks = useMemo(() => unresolvedHunks(diff.hunks, diff.hunkStatus), [diff.hunks, diff.hunkStatus]);
  const totalCounts = useMemo(() => countDiffLines(diff.unifiedDiff, diff.hunks), [diff.hunks, diff.unifiedDiff]);
  const activePatchIndex = useMemo(() => {
    const firstPending = pendingHunks[0];
    return firstPending ? firstPending.index + 1 : diff.hunks.length;
  }, [diff.hunks.length, pendingHunks]);

  const findHunkAtCursor = useCallback((): DiffHunk | null => {
    const editor = editorRef.current;
    if (!editor) return pendingHunks[0] ?? null;
    const line = editor.getPosition()?.lineNumber ?? 1;
    let closest: DiffHunk | null = pendingHunks[0] ?? null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const hunk of pendingHunks) {
      const anchor = hunkAnchorLineInMergedContent(diff.oldContent, diff.hunks, acceptedIds, hunk.id);
      const distance = Math.abs(anchor - line);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = hunk;
      }
    }
    return closest;
  }, [acceptedIds, diff.hunks, diff.oldContent, pendingHunks]);

  const syncInlineReview = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    editor.changeViewZones((accessor) => {
      for (const id of viewZoneIdsRef.current) accessor.removeZone(id);
      viewZoneIdsRef.current = [];
    });

    const isBusy = Boolean(diff.applyingAll || diff.applyingHunkId);

    editor.changeViewZones((accessor) => {
      for (const hunk of pendingHunks) {
        const anchorLine = hunkAnchorLineInMergedContent(diff.oldContent, diff.hunks, acceptedIds, hunk.id);
        const counts = countHunkLines(hunk);
        const status = diff.hunkStatus[hunk.id];
        const isResolved = status === 'accepted' || status === 'rejected';
        const blockNode = createHunkBlockNode({
          hunk,
          counts,
          isBusy,
          isResolved,
          status,
          modLabel,
          onAccept: () => onAcceptHunk(hunk.id),
          onReject: () => onRejectHunk(hunk.id),
        });
        const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
        // Root Cause vs Logic: scrollHeight is 0 until the node is in the DOM, so we estimate
        // height from line count + a fixed footer band (header ~20px, footer ~28px) and let
        // Monaco settle the final size after layout.
        const estimatedHeight = lineHeight * (hunk.lines.length + 1) + 48;
        const zoneId = accessor.addZone({
          afterLineNumber: Math.max(0, anchorLine - 1),
          heightInPx: estimatedHeight,
          domNode: blockNode,
          suppressMouseDown: false,
        });
        viewZoneIdsRef.current.push(zoneId);
      }
    });
  }, [
    acceptedIds,
    diff.applyingAll,
    diff.applyingHunkId,
    diff.hunkStatus,
    diff.hunks,
    diff.oldContent,
    modLabel,
    onAcceptHunk,
    onRejectHunk,
    pendingHunks,
  ]);

  useEffect(() => {
    syncInlineReview();
    return () => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.changeViewZones((accessor) => {
        for (const id of viewZoneIdsRef.current) accessor.removeZone(id);
        viewZoneIdsRef.current = [];
      });
    };
  }, [editorContent, syncInlineReview]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    configureMonacoForCodeFiles(monaco);
    registerDslLanguage(monaco);
    monaco.editor.setTheme(theme === 'codoptic-light' ? 'codoptic-light' : 'codoptic-dark');

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const hunk = findHunkAtCursor();
      if (hunk && !diff.hunkStatus[hunk.id]) onAcceptHunk(hunk.id);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backspace, () => {
      const hunk = findHunkAtCursor();
      if (hunk && !diff.hunkStatus[hunk.id]) onRejectHunk(hunk.id);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyY, () => {
      if (!diff.applyingAll) onAcceptAll();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyN, () => {
      if (!diff.applyingAll) onRejectAll();
    });

    onEditorMount?.(editor, monaco);
    syncInlineReview();
  };

  const hasBusyDiff = Boolean(diff.applyingAll || diff.applyingHunkId);

  return (
    <div className="relative h-full" data-code-space-inline-patch-review="true">
      <div className="pointer-events-none absolute right-3 top-2 z-20 flex items-center gap-2 rounded-md border border-[#30363d] bg-[#161b22e6] px-2 py-1 text-[10px] shadow-lg backdrop-blur">
        <span className="text-[#8b949e]">
          Patch {activePatchIndex}/{diff.hunks.length}
        </span>
        <span className="text-[#8b949e]">
          <span className="text-[#3fb950]">+{totalCounts.added}</span>{' '}
          <span className="text-[#f85149]">-{totalCounts.removed}</span>
        </span>
        <button
          type="button"
          disabled={hasBusyDiff}
          onClick={onRejectAll}
          className="pointer-events-auto rounded border border-[#30363d] px-2 py-0.5 text-[#f85149] hover:bg-[#2d1517] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Reject All {modLabel}Shift+N
        </button>
        <button
          type="button"
          disabled={hasBusyDiff}
          onClick={onAcceptAll}
          className="pointer-events-auto rounded bg-[#238636] px-2 py-0.5 text-white hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {hasBusyDiff ? 'Applying…' : `Accept All ${modLabel}Shift+Y`}
        </button>
      </div>
      {diff.error ? (
        <div className="absolute left-3 right-3 top-10 z-20 rounded border border-[#f8514944] bg-[#2d1517] px-2 py-1 text-[10px] text-[#f85149]">
          {diff.error}
        </div>
      ) : null}
      <Editor
        height="100%"
        theme={theme}
        language={language}
        path={`${filePath}:patch-review`}
        value={editorContent}
        onMount={handleMount}
        options={{
          readOnly: true,
          minimap: { enabled: minimapEnabled },
          wordWrap: wordWrap ? 'on' : 'off',
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          lineNumbers: 'on',
          folding: true,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          glyphMargin: true,
        }}
      />
    </div>
  );
}

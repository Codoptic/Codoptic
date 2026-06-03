'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { configureMonacoForCodeFiles } from '@/components/editor/monacoDefaults';
import { registerDslLanguage } from '@/components/editor/dslLanguage';
import {
  acceptedHunkIdSet,
  buildInlinePatchReviewModel,
  countDiffLines,
  countHunkLines,
  fileContentFromInlineReviewEditor,
  hunkAnchorLineInMergedContent,
  hunkLineRangeInInlineReview,
  unresolvedHunks,
  type CodeSpacePendingDiff,
  type DiffHunk,
  type InlineReviewLineMeta,
} from '@/components/code-space/diffHunks';

interface InlinePatchReviewProps {
  filePath: string;
  language: string;
  theme: 'codoptic-light' | 'codoptic-dark';
  diff: CodeSpacePendingDiff;
  minimapEnabled: boolean;
  wordWrap: boolean;
  onAcceptHunk: (hunkId: string, afterContent?: string) => void;
  onRejectHunk: (hunkId: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onEditorMount?: OnMount;
}

function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

function shortcutGlyphs(modLabel: string): { reject: string; accept: string } {
  if (modLabel === '⌘') return { reject: '⌘⌫', accept: '⌘⏎' };
  return { reject: 'Ctrl⌫', accept: 'Ctrl⏎' };
}

function decorationOptionsForLine(
  monaco: typeof import('monaco-editor'),
  kind: InlineReviewLineMeta['kind'],
): Monaco.editor.IModelDecorationOptions {
  if (kind === 'added') {
    return {
      isWholeLine: true,
      className: 'code-space-diff-added-line',
      glyphMarginClassName: 'code-space-diff-glyph-added',
      overviewRuler: { color: '#3fb95088', position: monaco.editor.OverviewRulerLane.Left },
    };
  }
  if (kind === 'removed') {
    return {
      isWholeLine: true,
      className: 'code-space-diff-removed-line',
      glyphMarginClassName: 'code-space-diff-glyph-removed',
      overviewRuler: { color: '#f8514988', position: monaco.editor.OverviewRulerLane.Left },
    };
  }
  return {};
}

class HunkActionContentWidget implements Monaco.editor.IContentWidget {
  allowEditorOverflow = true;
  suppressMouseDown = false;

  constructor(
    private readonly widgetId: string,
    private readonly domNode: HTMLDivElement,
    private getAnchorLine: () => number,
    private readonly monaco: typeof import('monaco-editor'),
  ) {}

  getId(): string {
    return this.widgetId;
  }

  getDomNode(): HTMLDivElement {
    return this.domNode;
  }

  getPosition(): Monaco.editor.IContentWidgetPosition | null {
    return {
      position: { lineNumber: this.getAnchorLine(), column: 1 },
      preference: [this.monaco.editor.ContentWidgetPositionPreference.EXACT],
    };
  }
}

function createHunkActionWidgetNode(options: {
  hunk: DiffHunk;
  patchIndex: number;
  patchTotal: number;
  counts: { added: number; removed: number };
  isBusy: boolean;
  isResolved: boolean;
  status: 'accepted' | 'rejected' | undefined;
  modLabel: string;
  onAccept: (afterContent?: string) => void;
  onReject: () => void;
  readAfterContent: () => string | undefined;
}): HTMLDivElement {
  const {
    hunk,
    patchIndex,
    patchTotal,
    counts,
    isBusy,
    isResolved,
    status,
    modLabel,
    onAccept,
    onReject,
    readAfterContent,
  } = options;
  const container = document.createElement('div');
  container.className =
    'code-space-inline-hunk-widget flex items-center gap-1.5 rounded-md border border-[#30363d] bg-[#161b22f2] px-2 py-1 text-[10px] shadow-lg backdrop-blur';
  container.dataset.hunkId = hunk.id;

  const counter = document.createElement('span');
  counter.className = 'whitespace-nowrap text-[#8b949e]';
  counter.textContent = `${patchIndex} of ${patchTotal}`;
  container.appendChild(counter);

  const count = document.createElement('span');
  count.className = 'whitespace-nowrap text-[#8b949e]';
  count.innerHTML = `<span class="text-[#3fb950]">+${counts.added}</span> <span class="text-[#f85149]">-${counts.removed}</span>`;
  container.appendChild(count);

  if (status) {
    const badge = document.createElement('span');
    badge.className = status === 'accepted' ? 'text-[#3fb950]' : 'text-[#f85149]';
    badge.textContent = status;
    container.appendChild(badge);
  }

  const glyphs = shortcutGlyphs(modLabel);

  const rejectButton = document.createElement('button');
  rejectButton.type = 'button';
  rejectButton.disabled = isBusy || isResolved;
  rejectButton.title = `Reject ${glyphs.reject}`;
  rejectButton.className =
    'inline-flex h-6 w-6 items-center justify-center rounded border border-[#30363d] text-[#f85149] hover:bg-[#2d1517] disabled:cursor-not-allowed disabled:opacity-40';
  rejectButton.textContent = '✕';
  rejectButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onReject();
  });
  container.appendChild(rejectButton);

  const acceptButton = document.createElement('button');
  acceptButton.type = 'button';
  acceptButton.disabled = isBusy || isResolved;
  acceptButton.title = isBusy ? 'Applying…' : `Accept ${glyphs.accept}`;
  acceptButton.className =
    'inline-flex h-6 w-6 items-center justify-center rounded bg-[#238636] text-white hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-40';
  acceptButton.textContent = isBusy ? '…' : '✓';
  acceptButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onAccept(readAfterContent());
  });
  container.appendChild(acceptButton);

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
  const lineMetaRef = useRef<InlineReviewLineMeta[]>([]);
  const decorationIdsRef = useRef<string[]>([]);
  const contentWidgetsRef = useRef<HunkActionContentWidget[]>([]);
  const modLabel = isMacLike() ? '⌘' : 'Ctrl+';

  const acceptedIds = useMemo(() => acceptedHunkIdSet(diff.hunkStatus), [diff.hunkStatus]);
  const reviewModel = useMemo(() => {
    if (diff.deleted && acceptedIds.size === 0) {
      return { content: diff.oldContent, lineMeta: diff.oldContent.split('\n').map(() => ({ kind: 'plain' as const })) };
    }
    return buildInlinePatchReviewModel(diff.oldContent, diff.hunks, acceptedIds, diff.hunkStatus);
  }, [acceptedIds, diff.deleted, diff.hunkStatus, diff.hunks, diff.oldContent]);

  const [editorValue, setEditorValue] = useState(reviewModel.content);
  useEffect(() => {
    setEditorValue(reviewModel.content);
  }, [reviewModel.content, diff.diffId]);

  useEffect(() => {
    lineMetaRef.current = reviewModel.lineMeta;
  }, [reviewModel.lineMeta]);

  const pendingHunks = useMemo(() => unresolvedHunks(diff.hunks, diff.hunkStatus), [diff.hunks, diff.hunkStatus]);
  const totalCounts = useMemo(() => countDiffLines(diff.unifiedDiff, diff.hunks), [diff.hunks, diff.unifiedDiff]);
  const activePatchIndex = useMemo(() => {
    const firstPending = pendingHunks[0];
    return firstPending ? firstPending.index + 1 : diff.hunks.length;
  }, [diff.hunks.length, pendingHunks]);

  const readAfterContentForHunk = useCallback(
    (hunkId: string): string | undefined => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!model) return undefined;
      return fileContentFromInlineReviewEditor(
        model.getLinesContent(),
        lineMetaRef.current,
        diff.oldContent,
        diff.hunks,
        diff.hunkStatus,
        hunkId,
      );
    },
    [diff.hunkStatus, diff.hunks, diff.oldContent],
  );

  const findHunkAtCursor = useCallback((): DiffHunk | null => {
    const editor = editorRef.current;
    if (!editor) return pendingHunks[0] ?? null;
    const line = editor.getPosition()?.lineNumber ?? 1;
    let closest: DiffHunk | null = pendingHunks[0] ?? null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const hunk of pendingHunks) {
      const anchor = hunkAnchorLineInMergedContent(
        diff.oldContent,
        diff.hunks,
        acceptedIds,
        hunk.id,
        diff.hunkStatus,
      );
      const distance = Math.abs(anchor - line);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = hunk;
      }
    }
    return closest;
  }, [acceptedIds, diff.hunkStatus, diff.hunks, diff.oldContent, pendingHunks]);

  const syncInlineDecorations = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
    reviewModel.lineMeta.forEach((meta, index) => {
      if (meta.kind !== 'added' && meta.kind !== 'removed') return;
      const options = decorationOptionsForLine(monaco, meta.kind);
      if (!options.className) return;
      decorations.push({
        range: new monaco.Range(index + 1, 1, index + 1, 1),
        options,
      });
    });
    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, decorations);
  }, [reviewModel.lineMeta]);

  const syncHunkActionWidgets = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    for (const widget of contentWidgetsRef.current) {
      editor.removeContentWidget(widget);
    }
    contentWidgetsRef.current = [];

    const isBusy = Boolean(diff.applyingAll || diff.applyingHunkId);
    const patchTotal = diff.hunks.length;

    for (const hunk of pendingHunks) {
      const range = hunkLineRangeInInlineReview(reviewModel.lineMeta, hunk.id);
      const anchorLine = range?.endLine ?? hunkAnchorLineInMergedContent(
        diff.oldContent,
        diff.hunks,
        acceptedIds,
        hunk.id,
        diff.hunkStatus,
      );
      const counts = countHunkLines(hunk);
      const status = diff.hunkStatus[hunk.id];
      const isResolved = status === 'accepted' || status === 'rejected';
      const domNode = createHunkActionWidgetNode({
        hunk,
        patchIndex: hunk.index + 1,
        patchTotal,
        counts,
        isBusy: isBusy || diff.applyingHunkId === hunk.id,
        isResolved,
        status,
        modLabel,
        onAccept: (afterContent) => onAcceptHunk(hunk.id, afterContent),
        onReject: () => onRejectHunk(hunk.id),
        readAfterContent: () => readAfterContentForHunk(hunk.id),
      });
      const widget = new HunkActionContentWidget(
        `code-space-hunk-widget-${hunk.id}`,
        domNode,
        () => anchorLine,
        monaco,
      );
      contentWidgetsRef.current.push(widget);
      editor.addContentWidget(widget);
    }
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
    readAfterContentForHunk,
    reviewModel.lineMeta,
  ]);

  const syncInlineReview = useCallback(() => {
    syncInlineDecorations();
    syncHunkActionWidgets();
  }, [syncHunkActionWidgets, syncInlineDecorations]);

  useEffect(() => {
    syncInlineReview();
    return () => {
      const editor = editorRef.current;
      if (!editor) return;
      for (const widget of contentWidgetsRef.current) {
        editor.removeContentWidget(widget);
      }
      contentWidgetsRef.current = [];
      decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
    };
  }, [reviewModel.content, syncInlineReview]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    configureMonacoForCodeFiles(monaco);
    registerDslLanguage(monaco);
    monaco.editor.setTheme(theme === 'codoptic-light' ? 'codoptic-light' : 'codoptic-dark');

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const hunk = findHunkAtCursor();
      if (hunk && !diff.hunkStatus[hunk.id]) {
        onAcceptHunk(hunk.id, readAfterContentForHunk(hunk.id));
      }
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
          Change {activePatchIndex}/{diff.hunks.length}
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
        value={editorValue}
        onChange={(value) => setEditorValue(value ?? '')}
        onMount={handleMount}
        options={{
          readOnly: false,
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

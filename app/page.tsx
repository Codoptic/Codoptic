'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from '@/components/shell/TopBar';
import { MonacoPanel } from '@/components/editor/MonacoPanel';
import { ExampleLoader } from '@/components/editor/ExampleLoader';
import { DiagramCanvas, type DiagramCanvasHandle } from '@/components/diagram/DiagramCanvas';
import { InspectorWorkspacePanel } from '@/components/inspector/InspectorWorkspacePanel';
import { AgentPanel } from '@/components/agent/AgentPanel';
import { CustomPromptPanel } from '@/components/agent/CustomPromptPanel';
import { MultiLayerPanel } from '@/components/multilayer/MultiLayerPanel';
import { LayerNavigator } from '@/components/multilayer/LayerNavigator';
import { CodeSpaceWorkspace } from '@/components/code-space/CodeSpaceWorkspace';
import { CodeSpaceWorkspaceEnhancements } from '@/components/code-space/CodeSpaceWorkspaceEnhancements';
import { flushDraftSave, useDiagramStore } from '@/lib/state/store';
import { readUiPreferences, writeUiPreference } from '@/lib/state/uiPreferences';
import { downloadPng } from '@/lib/export/png';
import { downloadSvg } from '@/lib/export/svg';
import { printSvgDiagram } from '@/lib/export/print';
import flowExample from '../examples/flow.txt';

export default function Page() {
  const mode = useDiagramStore((s) => s.mode);
  const theme = useDiagramStore((s) => s.theme);
  const setDsl = useDiagramStore((s) => s.setDsl);
  const clearOverrides = useDiagramStore((s) => s.clearOverrides);
  const hydrateUiPreferences = useDiagramStore((s) => s.hydrateUiPreferences);
  const applyDraft = useDiagramStore((s) => s.applyDraft);
  const canvasRef = useRef<DiagramCanvasHandle>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [isEditorVisible, setIsEditorVisible] = useState(true);
  const [isInspectorVisible, setIsInspectorVisible] = useState(true);
  const [isCompactShell, setIsCompactShell] = useState(false);
  const [compactFocus, setCompactFocus] = useState<'editor' | 'workspace'>('editor');

  useEffect(() => {
    hydrateUiPreferences();
    const preferences = readUiPreferences();
    if (typeof preferences.isEditorVisible === 'boolean') setIsEditorVisible(preferences.isEditorVisible);
    if (typeof preferences.isInspectorVisible === 'boolean') setIsInspectorVisible(preferences.isInspectorVisible);
  }, [hydrateUiPreferences]);

  const onHardSave = useCallback(() => {
    void flushDraftSave();
  }, []);

  const onPrintDiagram = useCallback(() => {
    const svg = canvasRef.current?.getSvg();
    if (!svg) return;
    void printSvgDiagram(svg, { title: 'Codoptic' });
  }, []);

  // Global undo / redo keyboard shortcut.
  // • Cmd+Z / Ctrl+Z  → undo the last diagram change (DSL edit or node drag)
  // • Cmd+Shift+Z / Ctrl+Shift+Z (or Ctrl+Y on Windows) → redo
  //
  // We defer to Monaco's own undo stack while the editor has focus so that
  // per-keystroke text undo continues to work as expected there.  Outside the
  // editor, Zundo's temporal store handles both DSL and override (node-drag)
  // history as a single unified undo stack.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const modKey = e.metaKey || e.ctrlKey;
      if (!modKey) return;

      const key = e.key.toLowerCase();
      const activeElement = document.activeElement as Element | null;

      // Let Monaco handle its own undo/redo when the editor has keyboard focus,
      // but still intercept save/print so the browser never falls back to the
      // page shell's default print/save actions.
      if (activeElement?.closest('.monaco-editor') && key !== 's' && key !== 'p') {
        return;
      }

      if (key === 's') {
        e.preventDefault();
        onHardSave();
      } else if (key === 'p') {
        e.preventDefault();
        onPrintDiagram();
      } else if (activeElement?.closest('.monaco-editor')) {
        return;
      } else if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useDiagramStore.temporal.getState().undo();
      } else if ((key === 'z' && e.shiftKey) || (key === 'y' && !e.metaKey)) {
        // Cmd+Shift+Z (Mac redo) and Ctrl+Y (Windows redo)
        e.preventDefault();
        useDiagramStore.temporal.getState().redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onHardSave, onPrintDiagram]);

  // Root Cause vs Logic: a browser refresh can still interrupt the last async
  // write, so we flush the draft one more time as the page is being hidden.
  useEffect(() => {
    const handlePageExit = () => {
      if (document.visibilityState !== 'hidden') return;
      void flushDraftSave();
    };

    window.addEventListener('beforeunload', handlePageExit);
    window.addEventListener('pagehide', handlePageExit);
    document.addEventListener('visibilitychange', handlePageExit);
    return () => {
      window.removeEventListener('beforeunload', handlePageExit);
      window.removeEventListener('pagehide', handlePageExit);
      document.removeEventListener('visibilitychange', handlePageExit);
    };
  }, []);

  // Async: after the fast synchronous localStorage hydration above, load the
  // IndexedDB draft and restore the latest persisted DSL + overrides. This is
  // the recovery path when localStorage is stale, missing, or quota-limited.
  useEffect(() => {
    async function hydrateDraft() {
      try {
        const { loadDraft } = await import('@/lib/cache/draftCache');
        // Read the project key that was just resolved by hydrateUiPreferences().
        const state = useDiagramStore.getState();
        const key = state.activeProjectId ?? 'scratch';
        const draft = await loadDraft(key);
        if (!draft) return;

        // Guard: ensure the user hasn't navigated away while we awaited.
        const currentState = useDiagramStore.getState();
        if ((currentState.activeProjectId ?? 'scratch') !== key) return;
        // Root Cause vs Logic: localStorage can be stale or quota-limited even
        // when IndexedDB has the latest draft, so the recovered draft must win
        // during hydration rather than acting like an optional overlay.
        applyDraft(draft);
      } catch {
        // Draft hydration is best-effort — never block the editor.
      } finally {
        setDraftHydrated(true);
      }
    }
    hydrateDraft();
  }, [applyDraft]);

  // Root Cause vs Logic: the starter example could win the race before the
  // IndexedDB draft had finished hydrating, which let a blank reload mask the
  // user's saved diagram. Wait for draft hydration to settle before seeding the
  // fallback example, and only seed it when there is still no persisted DSL.
  useEffect(() => {
    if (!draftHydrated) return;
    const preferences = readUiPreferences();
    const state = useDiagramStore.getState();
    if (preferences.dslText || state.dslText) return;
    setDsl(flowExample as unknown as string);
  }, [draftHydrated, setDsl]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 1535px)');
    const update = () => setIsCompactShell(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const onExportPng = useCallback(async () => {
    const svg = canvasRef.current?.getSvg();
    if (!svg) return;
    await downloadPng(svg, 'diagram.png', { scale: 2, includeBackground: true });
  }, []);

  const onExportSvg = useCallback(() => {
    const svg = canvasRef.current?.getSvg();
    if (!svg) return;
    downloadSvg(svg, 'diagram.svg', { includeBackground: true });
  }, []);

  const onResetLayout = useCallback(() => {
    clearOverrides();
    setTimeout(() => canvasRef.current?.fitView(), 50);
  }, [clearOverrides]);

  const onFitView = useCallback(() => {
    canvasRef.current?.fitView();
  }, []);

  const onToggleEditor = useCallback(() => {
    if (isCompactShell) {
      if (isEditorVisible && isInspectorVisible && compactFocus === 'editor') {
        setIsEditorVisible(false);
        writeUiPreference('isEditorVisible', false);
        return;
      }
      setIsEditorVisible(true);
      writeUiPreference('isEditorVisible', true);
      setCompactFocus('editor');
      return;
    }
    setIsEditorVisible((value) => {
      const next = !value;
      writeUiPreference('isEditorVisible', next);
      return next;
    });
  }, [compactFocus, isCompactShell, isEditorVisible, isInspectorVisible]);

  const onToggleInspector = useCallback(() => {
    if (isCompactShell) {
      if (isEditorVisible && isInspectorVisible && compactFocus === 'workspace') {
        setIsInspectorVisible(false);
        writeUiPreference('isInspectorVisible', false);
        return;
      }
      setIsInspectorVisible(true);
      writeUiPreference('isInspectorVisible', true);
      setCompactFocus('workspace');
      return;
    }
    setIsInspectorVisible((value) => {
      const next = !value;
      writeUiPreference('isInspectorVisible', next);
      return next;
    });
  }, [compactFocus, isCompactShell, isEditorVisible, isInspectorVisible]);

  const showEditorPanel =
    isEditorVisible && (!isCompactShell || !isInspectorVisible || compactFocus === 'editor');
  const showInspectorPanel =
    isInspectorVisible && (!isCompactShell || !isEditorVisible || compactFocus === 'workspace');

  // Motivation vs Logic: once the viewport drops under the shared side-panel breakpoint, the shell keeps only one ancillary pane visible so the canvas stays dominant instead of squeezing three regions into unreadable slivers.
  const editorGridColumns = useMemo(
    () =>
      [
        showEditorPanel ? 'minmax(320px, 420px)' : null,
        'minmax(0, 1fr)',
        showInspectorPanel ? 'minmax(340px, 460px)' : null,
      ]
        .filter(Boolean)
        .join(' '),
    [showEditorPanel, showInspectorPanel],
  );

  // Motivation vs Logic: the shell owns product-level theming and fixed workspace regions so editor, canvas, and inspector read as one enterprise workbench while the canvas remains layout-contained.
  return (
    <div data-theme={theme} className="flex h-screen flex-col overflow-hidden bg-ink-950 text-ink-100 surface-transition">
      <TopBar
        onExportPng={onExportPng}
        onExportSvg={onExportSvg}
        onResetLayout={onResetLayout}
        onFitView={onFitView}
        isEditorVisible={showEditorPanel}
        isInspectorVisible={showInspectorPanel}
        onToggleEditor={onToggleEditor}
        onToggleInspector={onToggleInspector}
      />

      {mode === 'editor' ? (
        <main className="grid min-h-0 flex-1 bg-ink-950" style={{ gridTemplateColumns: editorGridColumns, gridTemplateRows: 'minmax(0, 1fr)' }}>
          {showEditorPanel && (
            <section className="flex min-w-0 min-h-0 overflow-hidden flex-col border-r border-ink-700/80 bg-ink-900">
              <div className="flex min-h-12 items-center justify-between border-b border-ink-700/80 bg-ink-850/80 px-3">
                <ExampleLoader />
              </div>
              <div className="flex-1 min-h-0">
                <MonacoPanel />
              </div>
            </section>
          )}
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <LayerNavigator />
            <div className="relative min-h-0 flex-1">
              <DiagramCanvas ref={canvasRef} />
            </div>
          </section>
          {showInspectorPanel && (
            <aside className="min-w-0 border-l border-ink-700/80 bg-ink-900">
              <InspectorWorkspacePanel diagramRef={canvasRef} />
            </aside>
          )}
        </main>
      ) : mode === 'multi-layer' ? (
        // Root Cause vs Logic: Multi Layer was reachable from the toggle but fell through to AgentPanel, so the dedicated pipeline UI never mounted. Keep it as an explicit shell branch while editor remains the rendering destination for generated layers.
        <main className="flex-1 min-h-0 overflow-hidden bg-ink-950">
          <MultiLayerPanel />
        </main>
      ) : mode === 'code-space' ? (
        // Motivation vs Logic: Code Space is a unifying IDE surface that reuses repo, editor, custom-app, and multilayer services, so it lives as a first-class shell mode without changing the existing page contracts.
        <>
          <CodeSpaceWorkspace />
          <CodeSpaceWorkspaceEnhancements />
        </>
      ) : mode === 'custom-prompt' ? (
        <main className="flex-1 min-h-0 overflow-hidden bg-ink-950">
          <CustomPromptPanel />
        </main>
      ) : (
        <main className="flex-1 min-h-0 overflow-hidden bg-ink-950">
          <AgentPanel />
        </main>
      )}
    </div>
  );
}

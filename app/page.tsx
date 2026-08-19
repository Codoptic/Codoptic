'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, Bot, Code2, Layers3, PenTool, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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
import { flushDraftSave, storeHasFreshProject, useDiagramStore, type Mode } from '@/lib/state/store';
import { recoverCompletedGeneration } from '@/lib/state/generationRuntime';
import { hydrateProjectsFromCatalog } from '@/lib/state/projectStorage';
import { readUiPreferences, writeUiPreference } from '@/lib/state/uiPreferences';
import { downloadPng } from '@/lib/export/png';
import { downloadSvg } from '@/lib/export/svg';
import { printSvgDiagram } from '@/lib/export/print';
import logo from '@/public/logo.png';
import flowExample from '../examples/flow.txt';

const FEATURE_ROUTES: Array<{
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    href: '/diagram',
    title: 'Diagram Editor',
    description: 'Write DSL, shape layers, inspect nodes, and export production diagrams.',
    icon: PenTool,
  },
  {
    href: '/code',
    title: 'Code Space',
    description: 'Open the agentic coding workspace for repo-aware changes and review.',
    icon: Code2,
  },
  {
    href: '/single',
    title: 'Single Layer',
    description: 'Generate one focused architecture diagram from a repository.',
    icon: Bot,
  },
  {
    href: '/multi',
    title: 'Multi Layer',
    description: 'Build a navigable diagram bundle across systems and responsibilities.',
    icon: Layers3,
  },
  {
    href: '/plan',
    title: 'App Planner',
    description: 'Turn a product idea into clarified implementation guidance and diagrams.',
    icon: Sparkles,
  },
];

const ROUTE_ICON_SIZE = 16;

const LANDING_STORY = [
  {
    kicker: 'Alignment before execution',
    title: 'Turn architecture into the contract for the work.',
    copy: 'Codoptic gives product leads, architects, and implementation teams a shared source of truth before a coding agent touches the repo. The diagram is not decoration; it is the scope, the dependency map, and the conversation surface for tradeoffs.',
    value: 'Fewer ambiguous handoffs',
    proof: ['Scope decisions stay visible', 'Architecture vocabulary is shared', 'Reviewers see why files changed'],
  },
  {
    kicker: 'Repo-aware delivery',
    title: 'Move from intent to code with evidence attached.',
    copy: 'Code Space keeps prompts, file context, diffs, terminal output, validation, and plan artifacts in one workbench. Teams can approve the reasoning path instead of trusting a black-box answer pasted into the codebase.',
    value: 'Reviewable agent work',
    proof: ['Plans remain connected to patches', 'Diffs and validations stay inspectable', 'Human approval remains explicit'],
  },
  {
    kicker: 'Executive and engineering views',
    title: 'Explain one system at multiple altitudes.',
    copy: 'A single-layer view answers the immediate question. Multi-layer diagrams reveal ownership, data flow, deployment, and product capability without forcing every stakeholder through the same technical depth.',
    value: 'Faster stakeholder decisions',
    proof: ['Onboarding starts with structure', 'Planning moves past stale diagrams', 'Leaders see impact without losing fidelity'],
  },
  {
    kicker: 'Durable operating memory',
    title: 'Preserve the plan after the sprint moves on.',
    copy: 'Generated plans, diagrams, code runs, and implementation evidence become a durable trail. That history compounds into onboarding material, audit context, incident analysis, and faster future changes.',
    value: 'Institutional knowledge that compounds',
    proof: ['Less rediscovery work', 'Cleaner audit trails', 'Reusable project context'],
  },
];
const DEFAULT_LANDING_STORY = LANDING_STORY[0]!;

export function CodopticWorkbench({ routeMode }: { routeMode?: Mode }) {
  const mode = useDiagramStore((s) => s.mode);
  const theme = useDiagramStore((s) => s.theme);
  const setMode = useDiagramStore((s) => s.setMode);
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
    // Root Cause vs Logic: /diagram remount used to re-read localStorage over a
    // just-committed project. Skip that clobber when the store already holds it.
    if (!storeHasFreshProject()) hydrateUiPreferences();
    if (routeMode) setMode(routeMode);
    const preferences = readUiPreferences();
    if (typeof preferences.isEditorVisible === 'boolean') setIsEditorVisible(preferences.isEditorVisible);
    if (typeof preferences.isInspectorVisible === 'boolean') setIsInspectorVisible(preferences.isInspectorVisible);
  }, [hydrateUiPreferences, routeMode, setMode]);

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
        const { loadDraft, loadProjectCatalog } = await import('@/lib/cache/draftCache');
        await recoverCompletedGeneration();

        const catalog = await loadProjectCatalog();
        const stateAfterRecover = useDiagramStore.getState();
        if (
          catalog &&
          catalog.updatedAt > stateAfterRecover.stateUpdatedAt &&
          !storeHasFreshProject()
        ) {
          hydrateProjectsFromCatalog(catalog.projects, catalog.updatedAt);
          if (catalog.activeProjectId) {
            const active = catalog.projects.find((project) => project.id === catalog.activeProjectId);
            if (active) {
              useDiagramStore.getState().openProject({
                id: active.id,
                dsl: active.dsl,
                multiLayer: active.multiLayer,
                instructionMarkdown: active.instructionMarkdown,
              });
            }
          }
        }

        const state = useDiagramStore.getState();
        const key = state.activeProjectId ?? 'scratch';
        const draft = await loadDraft(key);
        if (!draft) return;

        const currentState = useDiagramStore.getState();
        if ((currentState.activeProjectId ?? 'scratch') !== key) return;
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
    <div data-theme={theme} className="dark-space-bg flex h-screen flex-col overflow-hidden text-ink-100 surface-transition">
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
        <main className="grid min-h-0 flex-1 bg-black/35" style={{ gridTemplateColumns: editorGridColumns, gridTemplateRows: 'minmax(0, 1fr)' }}>
          {showEditorPanel && (
            <section className="flex min-w-0 min-h-0 overflow-hidden flex-col border-r border-accent/15 bg-black/62">
              <div className="flex min-h-12 items-center justify-between border-b border-accent/15 bg-ink-950/78 px-3">
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
            <aside className="min-w-0 border-l border-accent/15 bg-black/62">
              <InspectorWorkspacePanel diagramRef={canvasRef} />
            </aside>
          )}
        </main>
      ) : mode === 'multi-layer' ? (
        // Root Cause vs Logic: Multi Layer was reachable from the toggle but fell through to AgentPanel, so the dedicated pipeline UI never mounted. Keep it as an explicit shell branch while editor remains the rendering destination for generated layers.
        <main className="flex-1 min-h-0 overflow-hidden bg-black/42">
          <MultiLayerPanel />
        </main>
      ) : mode === 'code-space' ? (
        // Motivation vs Logic: Code Space is a unifying IDE surface that reuses repo, editor, custom-app, and multilayer services, so it lives as a first-class shell mode without changing the existing page contracts.
        <>
          <CodeSpaceWorkspace />
          <CodeSpaceWorkspaceEnhancements />
        </>
      ) : mode === 'custom-prompt' ? (
        <main className="flex-1 min-h-0 overflow-hidden bg-black/42">
          <CustomPromptPanel />
        </main>
      ) : (
        <main className="flex-1 min-h-0 overflow-hidden bg-black/42">
          <AgentPanel />
        </main>
      )}
    </div>
  );
}

export default function Page() {
  const [activeStoryIndex, setActiveStoryIndex] = useState(0);
  const activeStory = LANDING_STORY[activeStoryIndex] ?? DEFAULT_LANDING_STORY;

  useEffect(() => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-story-step]'));
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntry = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        const index = Number(visibleEntry?.target.getAttribute('data-story-step'));
        if (Number.isInteger(index)) setActiveStoryIndex(index);
      },
      { rootMargin: '-35% 0px -35% 0px', threshold: [0.2, 0.45, 0.7] },
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  return (
    <main className="min-h-screen bg-ink-950 text-ink-100">
      <section className="relative isolate">
        <div className="dark-space-bg fixed inset-0 -z-30" />
        <div className="fixed inset-x-0 top-0 -z-20 h-96 bg-[linear-gradient(90deg,rgba(216,196,154,0.035)_1px,transparent_1px),linear-gradient(rgba(216,196,154,0.035)_1px,transparent_1px)] bg-[size:46px_46px] [mask-image:linear-gradient(to_bottom,black,transparent)]" />

        <header className="fixed inset-x-0 top-0 z-30 border-b border-accent/15 bg-black/82 px-5 py-4 backdrop-blur-xl sm:px-8 lg:px-10">
          <div className="mx-auto flex max-w-7xl items-center justify-between">
            <Link href="/" className="group inline-flex items-center gap-3" aria-label="Codoptic home">
              <span className="relative grid h-11 w-11 place-items-center overflow-hidden rounded-xl border border-accent/30 bg-ink-950 shadow-[0_0_0_1px_rgba(216,196,154,0.12),0_18px_45px_rgba(0,0,0,0.5)]">
                <Image alt="Codoptic logo" src={logo} className="h-full w-full object-contain" priority />
              </span>
              <span>
                <span className="font-luxury block text-xl leading-none tracking-[-0.02em] text-ink-100">Codoptic</span>
                <span className="luxury-kicker mt-1 block text-[9px] text-ink-400">Black Space Studio</span>
              </span>
            </Link>
            <nav className="hidden items-center gap-2 sm:flex">
              {FEATURE_ROUTES.map((route) => {
                const Icon = route.icon;
                return (
                  <Link
                    key={route.href}
                    href={route.href}
                    className="surface-transition flex items-center gap-2 rounded-full border border-ink-700/40 bg-black/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.35em] text-ink-400 transition hover:-translate-y-0.5 hover:border-accent/35 hover:text-ink-100"
                  >
                    <span className="grid h-6 w-6 place-items-center rounded bg-accent/15 text-accent">
                      <Icon size={ROUTE_ICON_SIZE} />
                    </span>
                    <span>{route.title}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </header>

        <div className="mx-auto grid max-w-7xl gap-10 px-5 pt-28 sm:px-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(420px,0.82fr)] lg:px-10">
          <div className="pb-20 lg:pb-36">
            <section className="relative flex min-h-[calc(100vh-7rem)] flex-col justify-center">
              <p className="mb-6 inline-flex w-fit rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-sm font-medium text-accent">
                Diagram-first software planning for serious builders
              </p>
              <h1 className="luxury-display max-w-5xl text-[clamp(4.15rem,10vw,5.9rem)] text-ink-100">
                A living map for the code you are about to change.
              </h1>
              <p className="mt-7 max-w-2xl text-pretty text-lg leading-8 text-ink-300">
                Codoptic turns architecture diagrams, repo exploration, implementation plans, and
                coding agents into one commercial workspace. Start with the system shape, then move
                directly into the files that make it real.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/diagram"
                  className="surface-transition inline-flex items-center justify-center gap-3 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-black hover:-translate-y-0.5 hover:bg-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Open Diagram Editor
                  <ArrowRight size={17} />
                </Link>
                <Link
                  href="/code"
                  className="surface-transition inline-flex items-center justify-center gap-3 rounded-full border border-accent/35 bg-black/35 px-6 py-3 text-sm font-semibold text-ink-100 hover:-translate-y-0.5 hover:border-accent/65 hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Open Coding Agent
                  <ArrowRight size={17} />
                </Link>
              </div>
            </section>

            <section className="relative py-8 lg:py-16">
              <div className="absolute bottom-24 left-4 top-20 hidden w-px bg-gradient-to-b from-accent/0 via-accent/45 to-accent-cool/0 sm:block" />
              {LANDING_STORY.map((story, index) => (
                <article
                  key={story.title}
                  data-story-step={index}
                  className="landing-story-section relative flex min-h-[82vh] max-w-3xl flex-col justify-center py-16 sm:pl-12"
                >
                  <span className="landing-story-node hidden sm:block" />
                  <p className="luxury-kicker text-[10px] font-semibold text-accent">{story.kicker}</p>
                  <h2 className="luxury-display mt-5 text-[clamp(2.8rem,5.7vw,4.8rem)] text-ink-100">
                    {story.title}
                  </h2>
                  <p className="mt-6 text-pretty text-lg leading-8 text-ink-300">{story.copy}</p>
                  <div className="mt-8 inline-flex w-fit rounded-full border border-accent/35 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent">
                    {story.value}
                  </div>
                  <div className="mt-7 grid gap-3 sm:grid-cols-3">
                    {story.proof.map((item) => (
                      <div key={item} className="rounded-xl border border-accent/15 bg-black/36 p-4 text-sm leading-6 text-ink-300">
                        {item}
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </section>
          </div>

          <aside className="relative hidden lg:block">
            <div className="luxury-panel sticky top-28 flex h-[calc(100vh-8rem)] flex-col gap-4 overflow-hidden rounded-2xl border p-5 backdrop-blur-md">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_28%_20%,rgba(216,196,154,0.16),transparent_20rem),radial-gradient(circle_at_74%_54%,rgba(165,142,255,0.14),transparent_24rem)]" />
              <div className="landing-morph-orb landing-morph-orb-a" />
              <div className="landing-morph-orb landing-morph-orb-b" />
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-accent/15 bg-black/66 p-5 backdrop-blur">
                <div className="flex shrink-0 items-start justify-between gap-4 border-b border-accent/15 pb-4">
                  <div className="min-w-0">
                    <p className="luxury-kicker text-[9px] font-medium text-accent">Business operating view</p>
                    <h3 className="mt-2 font-display text-2xl leading-tight tracking-[-0.02em] text-ink-100 xl:text-3xl">
                      {activeStory.value}
                    </h3>
                  </div>
                  <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl border border-accent/25 bg-black">
                    <Image alt="Codoptic logo" src={logo} className="h-full w-full object-contain" />
                  </div>
                </div>
                <div key={activeStory.title} className="landing-morph-slide flex min-h-0 flex-1 flex-col pt-5">
                  <p className="text-sm font-semibold text-accent">{activeStory.kicker}</p>
                  <p className="mt-4 text-pretty font-display text-[clamp(1.8rem,2.6vw,2.7rem)] leading-tight tracking-[-0.02em] text-ink-100">
                    {activeStory.title}
                  </p>
                  <div className="mt-auto grid gap-2 pt-5">
                    {activeStory.proof.map((item) => (
                      <div
                        key={item}
                        className="flex min-w-0 items-center gap-3 rounded-xl border border-accent/15 bg-ink-950/72 px-4 py-2.5 text-sm text-ink-300"
                      >
                        <span className="h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_18px_rgba(216,196,154,0.55)]" />
                        <span className="truncate">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="relative grid shrink-0 grid-cols-2 gap-2">
                {FEATURE_ROUTES.map((route) => {
                  const Icon = route.icon;
                  return (
                    <Link
                      key={route.href}
                      href={route.href}
                      className="surface-transition group flex min-w-0 items-center gap-3 rounded-xl border border-accent/15 bg-black/58 px-3 py-3 backdrop-blur hover:-translate-y-0.5 hover:border-accent/45"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
                        <Icon size={ROUTE_ICON_SIZE} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-display text-lg leading-none text-ink-100">{route.title}</span>
                        <span className="block truncate text-xs text-ink-400">
                          {route.description}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </aside>
        </div>

        <section className="mx-auto max-w-7xl px-5 pb-24 sm:px-8 lg:px-10">
          <div className="luxury-panel relative overflow-hidden rounded-2xl border p-8 sm:p-10">
            <div className="absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_70%_50%,rgba(216,196,154,0.18),transparent_22rem)]" />
            <div className="relative max-w-3xl">
              <h2 className="luxury-display text-[clamp(2.7rem,5.4vw,4.9rem)]">
                Pick the doorway. Codoptic opens on the exact surface your work needs.
              </h2>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/diagram"
                  className="surface-transition inline-flex items-center justify-center gap-3 rounded-full bg-ink-100 px-6 py-3 text-sm font-semibold text-black hover:-translate-y-0.5"
                >
                  Start diagramming
                  <ArrowRight size={17} />
                </Link>
                <Link
                  href="/code"
                  className="surface-transition inline-flex items-center justify-center gap-3 rounded-full border border-ink-100/25 bg-black/35 px-6 py-3 text-sm font-semibold text-ink-100 hover:-translate-y-0.5 hover:bg-ink-950/55"
                >
                  Start coding with agent
                  <ArrowRight size={17} />
                </Link>
              </div>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

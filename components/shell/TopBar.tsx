'use client';

import Image from 'next/image';
import {
  Download,
  FileCode2,
  Maximize2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  Sun,
} from 'lucide-react';
import logo from '@/public/logo.png';
import { ModeToggle } from './ModeToggle';
import { useDiagramStore } from '@/lib/state/store';

interface TopBarProps {
  onExportPng: () => void;
  onExportSvg: () => void;
  onResetLayout: () => void;
  onFitView: () => void;
  isEditorVisible: boolean;
  isInspectorVisible: boolean;
  onToggleEditor: () => void;
  onToggleInspector: () => void;
}

export function TopBar({
  onExportPng,
  onExportSvg,
  onResetLayout,
  onFitView,
  isEditorVisible,
  isInspectorVisible,
  onToggleEditor,
  onToggleInspector,
}: TopBarProps) {
  const mode = useDiagramStore((s) => s.mode);
  const theme = useDiagramStore((s) => s.theme);
  const setTheme = useDiagramStore((s) => s.setTheme);
  const isLight = theme === 'light';

  return (
    <header className="glass-panel z-20 flex min-h-[80px] items-center justify-between border-b border-ink-700/80 px-4 py-3">
      <div className="flex min-w-0 items-center gap-5">
        <div className="flex items-center gap-3">
          {/* Motivation vs Logic: keep the app identity on the shared logo asset so the header stays in sync with the browser icon without duplicating artwork. */}
          <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-ink-700/70 bg-ink-900/40 shadow-glow">
            <Image
              alt="Codoptic logo"
              className="h-full w-full object-contain"
              priority
              src={logo}
            />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight text-ink-100">Codoptic</div>
            <div className="text-[10px] uppercase tracking-[0.24em] text-ink-400">Local Studio</div>
          </div>
        </div>
        <span className="h-8 w-px bg-ink-700" />
        <ModeToggle />
      </div>

      <div className="flex items-center gap-2 text-xs">
        <button
          onClick={() => setTheme(isLight ? 'dark' : 'light')}
          className="surface-transition inline-flex h-9 w-9 items-center justify-center rounded-md border border-ink-700 bg-ink-850 text-ink-300 hover:-translate-y-0.5 hover:border-accent/50 hover:text-ink-100"
          type="button"
          title={isLight ? 'Dark theme' : 'Light theme'}
          aria-label={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
        >
          {isLight ? <Moon size={16} /> : <Sun size={16} />}
        </button>

        {mode === 'editor' && (
          <>
            <span className="mx-1 h-8 w-px bg-ink-700" />
            <button
              onClick={onFitView}
              className="surface-transition inline-flex h-9 w-9 items-center justify-center rounded-md border border-ink-700 bg-ink-850 text-ink-300 hover:-translate-y-0.5 hover:border-accent/50 hover:text-ink-100"
              type="button"
              title="Fit view"
              aria-label="Fit view"
            >
              <Maximize2 size={16} />
            </button>
            <button
              onClick={onResetLayout}
              className="surface-transition inline-flex h-9 w-9 items-center justify-center rounded-md border border-ink-700 bg-ink-850 text-ink-300 hover:-translate-y-0.5 hover:border-accent/50 hover:text-ink-100"
              type="button"
              title="Reset layout"
              aria-label="Reset layout"
            >
              <RotateCcw size={16} />
            </button>
            <span className="mx-1 h-8 w-px bg-ink-700" />
            <button
              onClick={onToggleEditor}
              className={`surface-transition inline-flex h-9 w-9 items-center justify-center rounded-md border ${
                isEditorVisible
                  ? 'border-accent/50 bg-accent/15 text-accent'
                  : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-accent/50 hover:text-ink-100'
              } hover:-translate-y-0.5`}
              type="button"
              title={isEditorVisible ? 'Hide code editor' : 'Show code editor'}
              aria-label={isEditorVisible ? 'Hide code editor' : 'Show code editor'}
              aria-pressed={isEditorVisible}
            >
              {isEditorVisible ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
            <button
              onClick={onToggleInspector}
              className={`surface-transition inline-flex h-9 w-9 items-center justify-center rounded-md border ${
                isInspectorVisible
                  ? 'border-accent/50 bg-accent/15 text-accent'
                  : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-accent/50 hover:text-ink-100'
              } hover:-translate-y-0.5`}
              type="button"
              title={isInspectorVisible ? 'Hide inspector' : 'Show inspector'}
              aria-label={isInspectorVisible ? 'Hide properties inspector' : 'Show properties inspector'}
              aria-pressed={isInspectorVisible}
            >
              {isInspectorVisible ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
            <span className="mx-1 h-8 w-px bg-ink-700" />
            <button
              onClick={onExportSvg}
              className="surface-transition inline-flex h-9 items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-3 text-ink-200 hover:-translate-y-0.5 hover:border-accent/50"
              type="button"
            >
              <FileCode2 size={15} />
              SVG
            </button>
            <button
              onClick={onExportPng}
              className="surface-transition inline-flex h-9 items-center gap-2 rounded-md border border-accent/50 bg-accent/15 px-3 font-medium text-accent hover:-translate-y-0.5 hover:bg-accent/25"
              type="button"
            >
              <Download size={15} />
              PNG
            </button>
          </>
        )}
      </div>
    </header>
  );
}

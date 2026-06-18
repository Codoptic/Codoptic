'use client';

import Image from 'next/image';
import {
  Download,
  FileCode2,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
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

  return (
    <header className="glass-panel z-20 flex min-h-[84px] items-center justify-between border-b border-accent/15 px-4 py-3">
      <div className="flex min-w-0 items-center gap-5">
        <div className="flex items-center gap-3">
          {/* Motivation vs Logic: keep the app identity on the shared logo asset so the header stays in sync with the browser icon without duplicating artwork. */}
          <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-xl border border-accent/25 bg-black shadow-[0_0_0_1px_rgba(216,196,154,0.12),0_16px_38px_rgba(0,0,0,0.5)]">
            <Image
              alt="Codoptic logo"
              className="h-full w-full object-contain"
              priority
              src={logo}
            />
          </div>
          <div className="leading-tight">
            <div className="font-luxury text-xl leading-none tracking-[-0.02em] text-ink-100">Codoptic</div>
            <div className="luxury-kicker mt-1 text-[9px] text-ink-400">Local Studio</div>
          </div>
        </div>
        <span className="h-9 w-px bg-accent/15" />
        <ModeToggle />
      </div>

      <div className="flex items-center gap-2 text-xs">
        {mode === 'editor' && (
          <>
            <button
              onClick={onFitView}
              className="surface-transition inline-flex h-9 w-9 items-center justify-center rounded-full border border-accent/15 bg-black/45 text-ink-300 hover:-translate-y-0.5 hover:border-accent/45 hover:text-ink-100"
              type="button"
              title="Fit view"
              aria-label="Fit view"
            >
              <Maximize2 size={16} />
            </button>
            <button
              onClick={onResetLayout}
              className="surface-transition inline-flex h-9 w-9 items-center justify-center rounded-full border border-accent/15 bg-black/45 text-ink-300 hover:-translate-y-0.5 hover:border-accent/45 hover:text-ink-100"
              type="button"
              title="Reset layout"
              aria-label="Reset layout"
            >
              <RotateCcw size={16} />
            </button>
            <span className="mx-1 h-8 w-px bg-accent/15" />
            <button
              onClick={onToggleEditor}
              className={`surface-transition inline-flex h-9 w-9 items-center justify-center rounded-full border ${
                isEditorVisible
                  ? 'border-accent/45 bg-accent/15 text-accent'
                  : 'border-accent/15 bg-black/45 text-ink-300 hover:border-accent/45 hover:text-ink-100'
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
              className={`surface-transition inline-flex h-9 w-9 items-center justify-center rounded-full border ${
                isInspectorVisible
                  ? 'border-accent/45 bg-accent/15 text-accent'
                  : 'border-accent/15 bg-black/45 text-ink-300 hover:border-accent/45 hover:text-ink-100'
              } hover:-translate-y-0.5`}
              type="button"
              title={isInspectorVisible ? 'Hide inspector' : 'Show inspector'}
              aria-label={isInspectorVisible ? 'Hide properties inspector' : 'Show properties inspector'}
              aria-pressed={isInspectorVisible}
            >
              {isInspectorVisible ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
            <span className="mx-1 h-8 w-px bg-accent/15" />
            <button
              onClick={onExportSvg}
              className="surface-transition inline-flex h-9 items-center gap-2 rounded-full border border-accent/15 bg-black/45 px-3 text-ink-200 hover:-translate-y-0.5 hover:border-accent/45"
              type="button"
            >
              <FileCode2 size={15} />
              SVG
            </button>
            <button
              onClick={onExportPng}
              className="surface-transition inline-flex h-9 items-center gap-2 rounded-full border border-accent/45 bg-accent/15 px-3 font-medium text-accent hover:-translate-y-0.5 hover:bg-accent/20"
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

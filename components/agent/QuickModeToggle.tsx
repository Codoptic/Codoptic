'use client';

import { useDiagramStore } from '@/lib/state/store';

export function QuickModeToggle() {
  const quickMode = useDiagramStore((s) => s.quickMode);
  const setQuickMode = useDiagramStore((s) => s.setQuickMode);

  return (
    <div className="space-y-2 rounded-xl border border-accent/15 bg-black/42 p-4 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-widest text-ink-400">Quick Mode</div>
        <button
          type="button"
          role="switch"
          aria-checked={quickMode}
          onClick={() => setQuickMode(!quickMode)}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
            quickMode ? 'border-accent/70 bg-accent/40' : 'border-ink-600 bg-ink-800'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-ink-100 transition-transform ${
              quickMode ? 'translate-x-[18px]' : 'translate-x-[2px]'
            }`}
          />
        </button>
      </div>
      <p className="text-ink-400">
        {quickMode ? (
          <>
            Builds the diagram from the repo&apos;s <strong>structural skeleton only</strong> — folder
            clusters, import graph, routes, exports, env vars, docs. Skips per-file content reads and
            module summarization. Much faster &amp; cheaper, but less detailed.
          </>
        ) : (
          <>
            Off (default). The agent reads each relevant file and summarizes it with the LLM before
            planning the diagram. More accurate, slower, more tokens.
          </>
        )}
      </p>
    </div>
  );
}

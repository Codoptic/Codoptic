'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useDiagramStore } from '@/lib/state/store';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';

export function LayerNavigator() {
  const ml = useDiagramStore((s) => s.multiLayer);
  const active = useDiagramStore((s) => s.activeLayer);
  const setActive = useDiagramStore((s) => s.setActiveLayer);
  const setDsl = useDiagramStore((s) => s.setDsl);
  const clearOverrides = useDiagramStore((s) => s.clearOverrides);
  const removeLayer = useDiagramStore((s) => s.removeLayer);

  // name of the layer pending deletion, or null when the dialog is closed
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  if (!ml) return null;

  const select = (name: string, dsl: string) => {
    setActive(name);
    clearOverrides();
    setDsl(dsl);
  };

  const requestDelete = (name: string) => setPendingDelete(name);

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const wasActive = active === pendingDelete;
    removeLayer(pendingDelete);
    // Clear leftover drag/layout overrides when the active layer is removed
    if (wasActive) clearOverrides();
    setPendingDelete(null);
  };

  return (
    <>
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-accent/15 bg-black/58 px-3 py-2">
        <span className="mr-2 shrink-0 text-[10px] uppercase tracking-widest text-ink-400">
          Layers
        </span>

        {/* Overview tab — never deletable */}
        <button
          onClick={() => select('overview', ml.overview.dsl)}
          className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
            active === 'overview'
              ? 'border-accent/60 bg-accent/15 text-ink-100'
              : 'border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
          }`}
        >
          Overview
        </button>

        {/* Per-layer tabs with delete button */}
        {ml.layers.map((l) => {
          const isActive = active === l.name;
          return (
            <span key={l.name} className="group flex shrink-0 items-stretch">
              {/* Layer name — click to select */}
              <button
                onClick={() => select(l.name, l.dsl)}
                title={l.description}
                className={`rounded-l-md border-b border-l border-t px-2.5 py-1 text-[11px] transition-colors ${
                  isActive
                    ? 'border-accent/60 bg-accent/15 text-ink-100'
                    : 'border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
                }`}
              >
                {l.name}
              </button>

              {/* Delete button — visible on hover */}
              <button
                type="button"
                title="Remove layer"
                onClick={(e) => {
                  e.stopPropagation();
                  requestDelete(l.name);
                }}
                className={`flex items-center rounded-r-md border-b border-r border-t px-1 opacity-0 transition-opacity group-hover:opacity-100 ${
                  isActive
                    ? 'border-accent/60 bg-accent/15 text-ink-400 hover:bg-red-500/20 hover:text-red-300'
                    : 'border-ink-700 bg-ink-800 text-ink-500 hover:bg-red-500/20 hover:text-red-300'
                }`}
              >
                <X size={9} />
              </button>
            </span>
          );
        })}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete layer"
        message={`Delete "${pendingDelete}" permanently? This cannot be undone.`}
        confirmLabel="Delete layer"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}

'use client';

import { useDiagramStore } from '@/lib/state/store';

const KINDS: Array<{ id: 'architecture' | 'sequence' | 'class' | 'data-flow' | 'deployment'; label: string; hint: string }> = [
  { id: 'architecture', label: 'Architecture', hint: 'System overview with grouped subsystems' },
  { id: 'sequence', label: 'Sequence', hint: 'Time-ordered interactions between participants' },
  { id: 'class', label: 'Class', hint: 'Entities, fields, relationships' },
  { id: 'data-flow', label: 'Data Flow', hint: 'Sources → transforms → sinks' },
  { id: 'deployment', label: 'Deployment', hint: 'Environments, services, infra' },
];

export function DiagramTypePicker() {
  const kind = useDiagramStore((s) => s.diagramType);
  const setKind = useDiagramStore((s) => s.setDiagramType);

  return (
    <div className="space-y-2 rounded-xl border border-accent/15 bg-black/42 p-4 text-xs">
      <div className="text-[10px] uppercase tracking-widest text-ink-400">Diagram type</div>
      <div className="grid grid-cols-2 gap-2">
        {KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => setKind(k.id)}
            className={`rounded-md border px-2.5 py-2 text-left transition-colors ${
              kind === k.id ? 'border-accent/60 bg-accent/10' : 'border-ink-700 bg-ink-800 hover:bg-ink-700'
            }`}
          >
            <div className="text-ink-100">{k.label}</div>
            <div className="text-[10px] text-ink-400">{k.hint}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

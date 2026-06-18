'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Bot, Code2, GalleryVerticalEnd, Layers3, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useDiagramStore, type Mode } from '@/lib/state/store';

const ICON_SIZE = 17;
const SEGMENT_WIDTH = 150;

const MODES: Array<{ id: Mode; label: string; hint: string; icon: LucideIcon }> = [
  { id: 'editor', label: 'Diagram Editor', hint: 'DSL → diagram', icon: Code2 },
  { id: 'code-space', label: 'Code Space', hint: 'Agentic coding workspace', icon: GalleryVerticalEnd },
  { id: 'agent', label: 'Single Layer', hint: 'Repo → single layer diagram', icon: Bot },
  { id: 'multi-layer', label: 'Multi Layer', hint: 'Repo → layered diagrams', icon: Layers3 },
  { id: 'custom-prompt', label: 'App Planner', hint: 'Describe → ask → diagram', icon: Sparkles },
];

const MODE_ROUTES: Record<Mode, string> = {
  editor: '/diagram',
  'code-space': '/code',
  agent: '/single',
  'multi-layer': '/multi',
  'custom-prompt': '/plan',
};

export function ModeToggle() {
  const mode = useDiagramStore((s) => s.mode);
  const setMode = useDiagramStore((s) => s.setMode);
  const pathname = usePathname();
  const router = useRouter();
  const activeIdx = MODES.findIndex((m) => m.id === mode);
  const offset = Math.max(activeIdx, 0) * SEGMENT_WIDTH;

  return (
    <div className="mode-route-rail relative inline-flex rounded-full border border-accent/15 bg-black/55 p-1 shadow-[0_0_0_1px_rgba(216,196,154,0.08),0_18px_45px_rgba(0,0,0,0.38)]">
      <div
        className="mode-route-thumb pointer-events-none absolute bottom-1 top-1 rounded-full border border-accent/25 bg-accent/10"
        style={{ width: SEGMENT_WIDTH, transform: `translateX(${offset}px)` }}
      />
      {MODES.map((m) => {
        const active = mode === m.id;
        const Icon = m.icon;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              setMode(m.id);
              const href = MODE_ROUTES[m.id];
              if (pathname !== href) router.push(href);
            }}
            className={`mode-route-tab relative z-10 flex items-center justify-center gap-2 rounded-full px-3 py-2 whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              active ? 'text-ink-100' : 'text-ink-400 hover:text-ink-200'
            }`}
            style={{ width: SEGMENT_WIDTH }}
            aria-pressed={active}
            title={m.hint}
          >
            <span className={`mode-route-icon ${active ? 'mode-route-icon-active' : ''}`}>
              <Icon size={ICON_SIZE} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <span className={`mode-route-label ${active ? 'font-semibold' : 'font-medium'}`}>{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}

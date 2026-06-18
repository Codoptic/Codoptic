'use client';

import { useDiagramStore } from '@/lib/state/store';

export function FocusPromptBox() {
  const focus = useDiagramStore((s) => s.focusPrompt);
  const setFocus = useDiagramStore((s) => s.setFocusPrompt);
  return (
    <div className="space-y-2 rounded-xl border border-accent/15 bg-black/42 p-4 text-xs">
      <div className="text-[10px] uppercase tracking-widest text-ink-400">Focus (optional)</div>
      <textarea
        value={focus}
        onChange={(e) => setFocus(e.target.value)}
        placeholder="e.g. focus on the authentication flow; show database relationships; simplify to top 30 components"
        rows={3}
        className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5"
      />
    </div>
  );
}

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlinePatchReview } from '../InlinePatchReview';
import { splitUnifiedDiffIntoHunks, type CodeSpacePendingDiff } from '../diffHunks';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

vi.mock('@/components/editor/monacoDefaults', () => ({
  configureMonacoForCodeFiles: vi.fn(),
}));

vi.mock('@/components/editor/dslLanguage', () => ({
  registerDslLanguage: vi.fn(),
}));

vi.mock('@monaco-editor/react', () => ({
  default: function MockMonacoEditor({
    onMount,
    value,
  }: {
    onMount?: (editor: unknown, monaco: unknown) => void;
    value?: string;
  }) {
    React.useEffect(() => {
      const editor = {
        getPosition: () => ({ lineNumber: 1, column: 1 }),
        getModel: () => ({
          getLinesContent: () => (value ?? '').split('\n'),
        }),
        deltaDecorations: (_old: string[], decorations: unknown[]) => decorations.map((_, index) => `dec-${index}`),
        addContentWidget: () => undefined,
        removeContentWidget: () => undefined,
        addCommand: () => undefined,
      };
      const monaco = {
        editor: {
          setTheme: () => undefined,
          EditorOption: { lineHeight: 1 },
          ContentWidgetPositionPreference: { EXCLUSIVE: 0 },
          OverviewRulerLane: { Left: 1 },
        },
        Range: class MockRange {
          constructor(
            public startLineNumber: number,
            public startColumn: number,
            public endLineNumber: number,
            public endColumn: number,
          ) {}
        },
        KeyMod: { CtrlCmd: 1, Shift: 2 },
        KeyCode: { Enter: 3, Backspace: 4, KeyY: 5, KeyN: 6 },
      };
      onMount?.(editor, monaco);
    }, [onMount]);
    return <div data-testid="monaco-editor">{value}</div>;
  },
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function buildDiff(): CodeSpacePendingDiff {
  const unifiedDiff = ['@@ -1,1 +1,2 @@', '-old', '+new', '+more'].join('\n');
  return {
    diffId: 'diff-1',
    filePath: 'src/example.ts',
    oldContent: 'old',
    newContent: 'new\nmore',
    unifiedDiff,
    hunks: splitUnifiedDiffIntoHunks(unifiedDiff, 'old', 'new\nmore'),
    hunkStatus: {},
  };
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
});

describe('InlinePatchReview', () => {
  it('calls accept and reject handlers from the global action bar once', () => {
    const onAcceptAll = vi.fn();
    const onRejectAll = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <InlinePatchReview
          filePath="src/example.ts"
          language="typescript"
          theme="codoptic-dark"
          diff={buildDiff()}
          minimapEnabled={false}
          wordWrap={false}
          onAcceptHunk={vi.fn()}
          onRejectHunk={vi.fn()}
          onAcceptAll={onAcceptAll}
          onRejectAll={onRejectAll}
        />,
      );
    });

    const acceptAll = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Accept All'),
    );
    const rejectAll = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Reject All'),
    );

    act(() => {
      rejectAll?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      acceptAll?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onRejectAll).toHaveBeenCalledTimes(1);
    expect(onAcceptAll).toHaveBeenCalledTimes(1);
  });
});

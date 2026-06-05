import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileMentionInput } from '../FileMentionInput';
import { buildMentionIndex } from '@/lib/code-space/mentions/index';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function buildIndex(paths: ReadonlyArray<string>) {
  return buildMentionIndex(paths);
}

interface RenderOptions {
  value?: string;
  filePaths?: ReadonlyArray<string>;
  onChange?: ReturnType<typeof vi.fn>;
  onSubmit?: ReturnType<typeof vi.fn>;
  disabled?: boolean;
  placeholder?: string;
}

function renderInput(opts: RenderOptions = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onChange = opts.onChange ?? vi.fn();
  const onSubmit = opts.onSubmit ?? vi.fn();
  const filePaths = opts.filePaths ?? ['src/foo.ts', 'src/bar/baz.tsx', 'lib/utils.ts'];
  const index = buildIndex(filePaths);
  act(() => {
    root?.render(
      <FileMentionInput
        value={opts.value ?? ''}
        onChange={onChange}
        onSubmit={onSubmit}
        mentionIndex={index}
        disabled={opts.disabled ?? false}
        placeholder={opts.placeholder ?? 'Type here...'}
      />,
    );
  });
  return { container: container!, onChange, onSubmit };
}

function editor(): HTMLDivElement {
  const el = container!.querySelector<HTMLDivElement>('[data-testid="mention-editor"]');
  if (!el) throw new Error('editor missing');
  return el;
}

// Simulate a user typing text into the contenteditable by inserting a text node and dispatching
// an `input` event. Caret is placed at the end of the inserted node.
function typeIntoEditor(text: string) {
  const el = editor();
  act(() => {
    const node = document.createTextNode(text);
    el.appendChild(node);
    const range = document.createRange();
    range.setStart(node, text.length);
    range.collapse(true);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function optionTexts(): string[] {
  return Array.from(container!.querySelectorAll('[role="option"]')).map(
    (item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  );
}

function optionEls(): HTMLElement[] {
  return Array.from(container!.querySelectorAll<HTMLElement>('[role="option"]'));
}

function selectNode(node: Node) {
  const range = document.createRange();
  range.selectNode(node);
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('FileMentionInput (contenteditable)', () => {
  it('renders a contenteditable composer', () => {
    renderInput();
    const el = editor();
    expect(el.getAttribute('contenteditable')).toBe('true');
    expect(el.getAttribute('role')).toBe('textbox');
  });

  it('does not show the suggestor when there is no active @ token', () => {
    renderInput({ value: '' });
    typeIntoEditor('hello world');
    expect(container!.querySelector('[data-testid="mention-dropdown"]')).toBeNull();
  });

  it('opens the suggestor when @ is typed', () => {
    renderInput({ filePaths: ['src/foo.ts', 'src/bar/baz.tsx'] });
    typeIntoEditor('@');
    expect(container!.querySelector('[data-testid="mention-dropdown"]')).toBeTruthy();
  });

  it('shows root-nearest options for @ with no query', () => {
    renderInput({
      filePaths: [
        'README.md',
        'package.json',
        'backend/main.py',
        'frontend/App.tsx',
        'docs/intro.md',
        'lib/core.ts',
        'config/app.yml',
      ],
    });
    typeIntoEditor('@');
    const labels = optionTexts();
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((label) => label.startsWith('README.md'))).toBe(true);
    expect(labels.some((label) => label.startsWith('package.json'))).toBe(true);
    expect(labels.some((label) => label.startsWith('backend/'))).toBe(true);
  });

  it('lists the children of an exact directory token', () => {
    renderInput({
      filePaths: [
        'backend/main.py',
        'backend/README.md',
        'backend/components/Button.py',
        'backend/services/api.py',
        'frontend/App.tsx',
      ],
    });
    typeIntoEditor('@backend');
    const labels = optionTexts();
    expect(labels.some((label) => label.startsWith('main.py'))).toBe(true);
    expect(labels.some((label) => label.startsWith('README.md'))).toBe(true);
    expect(labels.some((label) => label.startsWith('components'))).toBe(true);
    expect(labels.some((label) => label.startsWith('services'))).toBe(true);
    // Nothing from outside backend
    expect(labels.some((label) => label.includes('frontend'))).toBe(false);
  });

  it('keyboard navigation: ArrowDown changes highlight; Enter selects', () => {
    const onChange = vi.fn();
    renderInput({
      onChange,
      filePaths: ['src/Alpha.ts', 'src/Beta.ts'],
    });
    typeIntoEditor('@');
    const before = optionEls();
    expect(before.length).toBeGreaterThan(1);
    const initial = before.findIndex((el) => el.getAttribute('aria-selected') === 'true');

    act(() => {
      editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });

    const after = optionEls();
    const moved = after.findIndex((el) => el.getAttribute('aria-selected') === 'true');
    expect(moved).not.toBe(initial);

    act(() => {
      editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onChange).toHaveBeenCalled();
    // After insertion, a chip span should be present.
    const chips = container!.querySelectorAll('[data-mention-chip="true"]');
    expect(chips.length).toBe(1);
  });

  it('Escape closes the suggestor without inserting', () => {
    renderInput({ filePaths: ['src/Foo.ts'] });
    typeIntoEditor('@');
    expect(container!.querySelector('[data-testid="mention-dropdown"]')).toBeTruthy();
    act(() => {
      editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="mention-dropdown"]')).toBeNull();
  });

  it('clicking a suggestion inserts a chip with markdown-style text and full-path metadata', () => {
    const onChange = vi.fn();
    renderInput({
      onChange,
      filePaths: ['app/components/control/controlPanel.tsx'],
    });
    typeIntoEditor('@control');
    const target = optionEls().find((el) =>
      el.getAttribute('data-mention-path') === 'app/components/control/controlPanel.tsx',
    );
    expect(target).toBeTruthy();
    act(() => {
      target!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    const chip = container!.querySelector<HTMLSpanElement>('[data-mention-chip="true"]');
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toBe('controlPanel.tsx');
    expect(chip!.getAttribute('data-mention-path')).toBe('app/components/control/controlPanel.tsx');
    expect(chip!.getAttribute('data-mention-name')).toBe('controlPanel.tsx');
    expect(chip!.getAttribute('data-mention-display-name')).toBe('controlPanel.tsx');
    expect(chip!.getAttribute('data-mention-type')).toBe('file');
    expect(chip!.getAttribute('data-mention-icon-kind')).toBe('extension');
    expect(chip!.querySelector('.mention-chip__icon--extension')).toBeTruthy();
    expect(chip!.getAttribute('title')).toBe('app/components/control/controlPanel.tsx');
    expect(chip!.getAttribute('aria-label')).toBe('File app/components/control/controlPanel.tsx');
    // Critical regression: the DOM stays compact, but the serialized prompt text preserves the full path.
    expect(chip!.textContent).not.toContain('app/components');
    expect(chip!.textContent).not.toContain('/');

    // onChange was called with (text, mentions).
    const lastCall = onChange.mock.calls.at(-1) ?? [];
    expect(lastCall[0]).toContain('[controlPanel.tsx](app/components/control/controlPanel.tsx)');
    expect(Array.isArray(lastCall[1])).toBe(true);
    expect(lastCall[1][0].relativePath).toBe('app/components/control/controlPanel.tsx');
  });

  it('does not trigger the suggestor on email-like patterns', () => {
    renderInput({ filePaths: ['lib/email.ts'] });
    typeIntoEditor('test@example.com');
    expect(container!.querySelector('[data-testid="mention-dropdown"]')).toBeNull();
  });

  it('Enter without an open dropdown submits with text + mentions', () => {
    const onSubmit = vi.fn();
    renderInput({ onSubmit, filePaths: ['lib/utils.ts'] });
    typeIntoEditor('hello there');
    act(() => {
      editor().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, shiftKey: false }),
      );
    });
    expect(onSubmit).toHaveBeenCalled();
    const call = onSubmit.mock.calls[0] ?? [];
    expect(call[0]).toBe('hello there');
    expect(call[1]).toEqual([]);
  });

  it('clears the editor when the parent transitions value from non-empty back to empty', () => {
    // Drive the component as a real controlled parent would: onChange writes back to `value`
    // each render. Then the post-submit clear path drops the prop back to ''.
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    let currentValue = '';
    const index = buildIndex(['lib/utils.ts']);
    const render = () => {
      act(() => {
        root?.render(
          <FileMentionInput
            value={currentValue}
            onChange={(nextValue) => {
              currentValue = nextValue;
              render();
            }}
            onSubmit={vi.fn()}
            mentionIndex={index}
            placeholder=""
          />,
        );
      });
    };
    render();
    typeIntoEditor('hello there');
    expect(currentValue).toBe('hello there');
    currentValue = '';
    render();
    expect(editor().textContent).toBe('');
  });

  it('folder selections render with a trailing slash and folder metadata', () => {
    const onChange = vi.fn();
    renderInput({ onChange, filePaths: ['backend/components/Button.tsx', 'backend/main.py'] });
    typeIntoEditor('@back');
    const folder = optionEls().find(
      (el) => el.getAttribute('data-mention-type') === 'folder' &&
        el.getAttribute('data-mention-path') === 'backend',
    );
    expect(folder).toBeTruthy();
    act(() => {
      folder!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    const chip = container!.querySelector<HTMLSpanElement>('[data-mention-chip="true"]');
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toBe('backend/');
    expect(chip!.getAttribute('data-mention-type')).toBe('folder');
    expect(chip!.getAttribute('data-mention-icon-kind')).toBe('folder');
    expect(chip!.querySelector('.mention-chip__icon--folder')).toBeTruthy();
    expect(chip!.getAttribute('data-mention-path')).toBe('backend');
    expect(chip!.getAttribute('data-mention-display-name')).toBe('backend/');
    expect(chip!.getAttribute('aria-label')).toBe('Folder backend');
  });

  it('renders type-aware icons in the suggestion list', () => {
    renderInput({
      filePaths: ['README.md', 'main.py', 'device.yaml', 'alert.tsx', 'system/guide.md'],
    });
    typeIntoEditor('@');
    const kindsByPath = new Map(
      optionEls().map((el) => [el.getAttribute('data-mention-path') ?? '', el.getAttribute('data-mention-icon-kind') ?? '']),
    );
    expect(kindsByPath.get('README.md')).toBe('document');
    expect(kindsByPath.get('main.py')).toBe('stack');
    expect(kindsByPath.get('device.yaml')).toBe('file');
    expect(kindsByPath.get('alert.tsx')).toBe('extension');
    expect(kindsByPath.get('system')).toBe('folder');
  });

  it('copies a selected chip as markdown text with the full project path', () => {
    renderInput({
      filePaths: ['app/components/control/controlPanel.tsx'],
    });
    typeIntoEditor('@control');
    const target = optionEls().find((el) =>
      el.getAttribute('data-mention-path') === 'app/components/control/controlPanel.tsx',
    );
    expect(target).toBeTruthy();
    act(() => {
      target!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    const chip = container!.querySelector<HTMLSpanElement>('[data-mention-chip="true"]');
    expect(chip).toBeTruthy();
    act(() => {
      selectNode(chip!);
    });
    const setData = vi.fn();
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, 'clipboardData', {
      value: { setData },
    });
    act(() => {
      editor().dispatchEvent(copyEvent);
    });

    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      '[controlPanel.tsx](app/components/control/controlPanel.tsx)',
    );
  });
});

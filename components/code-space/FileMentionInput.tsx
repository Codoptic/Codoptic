'use client';

// Motivation vs Logic: This component is the agent composer. The legacy implementation was a
// `<textarea>` that stored mentions as `[basename](path)` markdown text inside the value; the
// mirror highlighted the entire `[...](...)` substring, which is why the visible "chip" still
// showed the full project path. The rewrite uses a contenteditable div with atomic
// `contenteditable=false` mention chips. Visible chip text stays compact, but the relative path
// lives on `data-mention-path`, `title`, and the serialized markdown form so tooltips, copy, and
// agent payloads all preserve the full project-root path. The DOM is the source of truth during
// user interaction; React only mounts the initial empty state and listens for external resets
// (e.g. clearing the input after submit). On every input/selection change we recompute the active
// `@token`, run it through `queryMentionSuggestions`, and reposition the suggestor.

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { FileMentionIndex } from '@/lib/code-space/mentions/index';
import { queryMentionSuggestions } from '@/lib/code-space/mentions/query';
import type { MentionSuggestion, SelectedMention } from '@/lib/code-space/mentions/types';
import type { MentionIndexStatus } from '@/lib/code-space/mentions/useMentionIndex';
import { MentionSuggestor } from './mentions/MentionSuggestor';
import {
  createMentionChipNode,
  mentionChipMarkdown,
  MENTION_CHIP_CLASS,
} from './mentions/MentionChip';

const MAX_SUGGESTIONS = 10;
const TOKEN_CHAR_RE = /[A-Za-z0-9_./\-]/;
// Hard delimiters per spec: space/newline/tab/comma/semicolon/closing brackets/quotes/backtick.
const BOUNDARY_BEFORE_RE = /[\s,;()[\]{}'"`]/;

export interface FileMentionInputProps {
  /** Plain-text view of the composer. Reset to '' to clear externally (e.g. after submit). */
  value: string;
  /** Structured mentions parallel to `value`. */
  mentions?: SelectedMention[];
  onChange: (value: string, mentions: SelectedMention[]) => void;
  onSubmit: (value: string, mentions: SelectedMention[]) => void;
  mentionIndex: FileMentionIndex;
  indexStatus?: MentionIndexStatus;
  indexError?: string;
  openFiles?: ReadonlyArray<string>;
  recentFiles?: ReadonlyArray<string>;
  currentEditorFilePath?: string;
  disabled?: boolean;
  placeholder?: string;
}

interface ActiveToken {
  rawToken: string;
  range: Range;
}

function readMentionDisplayName(el: HTMLElement, fallback: string): string {
  return el.getAttribute('data-mention-display-name') ?? fallback;
}

function serializeMentionChip(el: HTMLElement): string {
  const type = (el.getAttribute('data-mention-type') as 'file' | 'folder') ?? 'file';
  const relativePath = el.getAttribute('data-mention-path') ?? '';
  const basename = el.getAttribute('data-mention-name') ?? el.textContent ?? '';
  const displayName = readMentionDisplayName(el, type === 'folder' ? `${basename}/` : basename);
  const mention: SelectedMention = {
    id: `mention:preview:${relativePath}`,
    type,
    basename,
    displayName,
    relativePath,
  };
  return mentionChipMarkdown(mention);
}

function serializeNode(node: Node, mentions: SelectedMention[] | null = null): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/\u00A0/g, ' ');
  }
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    let text = '';
    node.childNodes.forEach((child) => {
      text += serializeNode(child, mentions);
    });
    return text;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  if (el.getAttribute && el.getAttribute('data-mention-chip') === 'true') {
    if (mentions) {
      const type = (el.getAttribute('data-mention-type') as 'file' | 'folder') ?? 'file';
      const relativePath = el.getAttribute('data-mention-path') ?? '';
      const basename = el.getAttribute('data-mention-name') ?? el.textContent ?? '';
      const displayName = readMentionDisplayName(el, type === 'folder' ? `${basename}/` : basename);
      mentions.push({
        id: `mention:${mentions.length}:${relativePath}`,
        type,
        basename,
        displayName,
        relativePath,
      });
    }
    return serializeMentionChip(el);
  }
  if (el.tagName === 'BR') return '\n';
  let text = '';
  el.childNodes.forEach((child) => {
    text += serializeNode(child, mentions);
  });
  return text;
}

// Serialize the editor's DOM tree into (text, mentions). Mentions are recognised by their
// `data-mention-chip="true"` flag; everything else contributes plain text. `&nbsp;` (U+00A0) is
// converted back to a regular space so the submitted text is human-readable.
function serializeEditor(root: HTMLElement): { text: string; mentions: SelectedMention[] } {
  const mentions: SelectedMention[] = [];
  const text = serializeNode(root, mentions);
  return { text, mentions };
}

// Walk back from the caret (within a single text node) to detect an active `@token`. Returns the
// range covering `@`..caret and the raw token text (everything after `@`), or null when there is
// no active token. The boundary char before `@` must be a hard delimiter (or start-of-input) so
// emails like `test@example.com` do not trigger.
function detectActiveToken(root: HTMLElement): ActiveToken | null {
  const selection = root.ownerDocument?.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return null;
  if (!root.contains(range.startContainer)) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const textNode = node as Text;
  const offset = range.startOffset;
  const text = textNode.data ?? '';
  // Find the last '@' before the caret.
  let atIdx = -1;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === '@') {
      atIdx = i;
      break;
    }
    if (!TOKEN_CHAR_RE.test(ch)) {
      // Hit a delimiter before finding '@' — not in an active token.
      return null;
    }
  }
  if (atIdx === -1) return null;
  const before = atIdx === 0 ? null : text[atIdx - 1];
  // Boundary must be: start of node, or a hard delimiter char, or the start of the parent block.
  if (before !== null && before !== undefined && !BOUNDARY_BEFORE_RE.test(before)) {
    // If the '@' sits at the very start of a text node whose previous sibling is a chip span, we
    // still treat it as the start of a token.
    if (atIdx !== 0) return null;
    const prev = textNode.previousSibling;
    const prevIsChip =
      prev && prev.nodeType === Node.ELEMENT_NODE &&
      (prev as HTMLElement).getAttribute &&
      (prev as HTMLElement).getAttribute('data-mention-chip') === 'true';
    if (!prevIsChip && prev !== null) return null;
  }

  const rawToken = text.slice(atIdx + 1, offset);
  const tokenRange = root.ownerDocument!.createRange();
  tokenRange.setStart(textNode, atIdx);
  tokenRange.setEnd(textNode, offset);
  return { rawToken, range: tokenRange };
}

// Set the caret immediately after `node` inside `root`. Creates a fresh selection.
function placeCaretAfter(root: HTMLElement, node: Node): void {
  const sel = root.ownerDocument?.getSelection?.();
  if (!sel) return;
  const range = root.ownerDocument!.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function FileMentionInput({
  value,
  mentions: _externalMentions,
  onChange,
  onSubmit,
  mentionIndex,
  indexStatus = 'ready',
  indexError,
  openFiles,
  recentFiles,
  currentEditorFilePath,
  disabled = false,
  placeholder = 'Describe a task...',
}: FileMentionInputProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const [activeToken, setActiveToken] = useState<ActiveToken | null>(null);
  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null);
  const lastSerialized = useRef<{ text: string; mentions: SelectedMention[] }>({
    text: '',
    mentions: [],
  });

  const openFilesKey = (openFiles ?? []).join('\u0001');
  const recentFilesKey = (recentFiles ?? []).join('\u0001');
  const openFilesMemo = useMemo(() => openFiles ?? [], [openFilesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const recentFilesMemo = useMemo(() => recentFiles ?? [], [recentFilesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const emitChange = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    const { text, mentions } = serializeEditor(root);
    lastSerialized.current = { text, mentions };
    onChange(text, mentions);
  }, [onChange]);

  // Recompute the suggestor for the current caret + active token.
  const refreshSuggestions = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    const detected = detectActiveToken(root);
    if (!detected) {
      setActiveToken(null);
      setSuggestions([]);
      return;
    }
    setActiveToken(detected);
    const next = queryMentionSuggestions(mentionIndex, {
      rawToken: detected.rawToken,
      openFiles: openFilesMemo,
      recentFiles: recentFilesMemo,
      currentEditorFilePath,
      maxResults: MAX_SUGGESTIONS,
    });
    setSuggestions(next);
    setActiveIndex(0);
    // Caret position for the popover anchor.
    try {
      const rect = detected.range.getBoundingClientRect();
      setAnchorRect(rect);
    } catch {
      setAnchorRect(null);
    }
    if (containerRef.current) setContainerRect(containerRef.current.getBoundingClientRect());
  }, [mentionIndex, openFilesMemo, recentFilesMemo, currentEditorFilePath]);

  // External resets: clear the DOM only when the parent transitions `value` from non-empty back
  // to '' (the post-submit clear pattern). A render where `value` stays '' should NOT clear
  // mid-keystroke edits where the controlled parent hasn't caught up yet — that would race
  // typing flows and break test fixtures that pass a no-op `onChange`.
  const prevValueRef = useRef(value);
  useLayoutEffect(() => {
    const prev = prevValueRef.current;
    prevValueRef.current = value;
    const root = editorRef.current;
    if (!root) return;
    if (prev !== '' && value === '' && root.childNodes.length > 0) {
      root.innerHTML = '';
      lastSerialized.current = { text: '', mentions: [] };
      setActiveToken(null);
      setSuggestions([]);
    }
  });

  // Insert a chip at the active token's range and emit onChange.
  const insertMention = useCallback(
    (suggestion: MentionSuggestion) => {
      const root = editorRef.current;
      if (!root || !activeToken) return;
      const doc = root.ownerDocument!;
      const selected: SelectedMention = {
        id: `mention:${Date.now()}:${suggestion.relativePath}`,
        type: suggestion.type,
        basename: suggestion.basename,
        displayName: suggestion.displayName,
        relativePath: suggestion.relativePath,
      };
      const chip = createMentionChipNode(doc, selected);
      const spacer = doc.createTextNode('\u00A0');

      try {
        activeToken.range.deleteContents();
        activeToken.range.insertNode(spacer);
        activeToken.range.insertNode(chip);
      } catch {
        // If the range became invalid (DOM mutated externally), append at the end.
        root.appendChild(chip);
        root.appendChild(spacer);
      }
      placeCaretAfter(root, spacer);

      setActiveToken(null);
      setSuggestions([]);
      emitChange();
    },
    [activeToken, emitChange],
  );

  // ---- Event handlers ----

  const handleInput = useCallback(() => {
    refreshSuggestions();
    emitChange();
  }, [refreshSuggestions, emitChange]);

  const handleSelectionChange = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    const doc = root.ownerDocument;
    if (!doc) return;
    const selection = doc.getSelection?.();
    if (!selection || selection.rangeCount === 0) return;
    if (!root.contains(selection.anchorNode)) return;
    refreshSuggestions();
  }, [refreshSuggestions]);

  useEffect(() => {
    const doc = editorRef.current?.ownerDocument;
    if (!doc) return;
    const listener = () => handleSelectionChange();
    doc.addEventListener('selectionchange', listener);
    return () => doc.removeEventListener('selectionchange', listener);
  }, [handleSelectionChange]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      const dropdownOpen = activeToken !== null && suggestions.length > 0;
      if (dropdownOpen) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActiveIndex((i) => (i + 1) % suggestions.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const choice = suggestions[activeIndex];
          if (choice) insertMention(choice);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setActiveToken(null);
          setSuggestions([]);
          return;
        }
      }
      if (event.key === 'Enter' && !event.shiftKey && !dropdownOpen) {
        event.preventDefault();
        const root = editorRef.current;
        if (!root) return;
        const { text, mentions } = serializeEditor(root);
        if (text.trim()) onSubmit(text, mentions);
      }
    },
    [activeIndex, activeToken, disabled, insertMention, onSubmit, suggestions],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;
      const doc = editorRef.current?.ownerDocument;
      if (!doc) return;
      const selection = doc.getSelection?.();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = doc.createTextNode(text);
      range.insertNode(node);
      placeCaretAfter(editorRef.current!, node);
      handleInput();
    },
    [handleInput],
  );

  const handleCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const root = editorRef.current;
    if (!root) return;
    const doc = root.ownerDocument;
    if (!doc) return;
    const selection = doc.getSelection?.();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;

    const fragment = range.cloneContents();
    const copied = serializeNode(fragment);
    if (!copied) return;

    const clipboard = event.clipboardData;
    if (!clipboard) return;
    event.preventDefault();
    clipboard.setData('text/plain', copied);
    clipboard.setData('text/html', copied);
  }, []);

  const handleBeforeInput = useCallback(
    (event: Event) => {
      const inputEvent = event as InputEvent;
      if (inputEvent.inputType !== 'deleteContentBackward') return;
      const root = editorRef.current;
      if (!root) return;
      const doc = root.ownerDocument;
      if (!doc) return;
      const selection = doc.getSelection?.();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!range.collapsed) return;
      const node = range.startContainer;
      const offset = range.startOffset;
      // If the caret sits immediately after a chip span, remove the chip whole.
      let target: ChildNode | null = null;
      if (node.nodeType === Node.TEXT_NODE && offset === 0) {
        target = (node as Text).previousSibling;
      } else if (node === root && offset > 0) {
        target = root.childNodes.item(offset - 1) ?? null;
      }
      if (
        target &&
        target.nodeType === Node.ELEMENT_NODE &&
        (target as HTMLElement).getAttribute('data-mention-chip') === 'true'
      ) {
        event.preventDefault();
        target.parentNode?.removeChild(target);
        handleInput();
      }
    },
    [handleInput],
  );

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.addEventListener('beforeinput', handleBeforeInput as EventListener);
    return () => editor.removeEventListener('beforeinput', handleBeforeInput as EventListener);
  }, [handleBeforeInput]);

  const handleFocus = useCallback(() => {
    refreshSuggestions();
  }, [refreshSuggestions]);

  const handleBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    // Only collapse when focus leaves the composer's container entirely.
    const next = event.relatedTarget as Node | null;
    if (next && containerRef.current?.contains(next)) return;
    setActiveToken(null);
    setSuggestions([]);
  }, []);

  // Track suggestor open state for ARIA semantics.
  const expanded = activeToken !== null && suggestions.length > 0;

  return (
    <div ref={containerRef} className="relative flex-1">
      {expanded && (
        <MentionSuggestor
          suggestions={suggestions}
          activeIndex={activeIndex}
          status={indexStatus}
          error={indexError}
          anchorRect={anchorRect}
          containerRect={containerRect}
          onSelect={insertMention}
          onHighlight={setActiveIndex}
          listboxId={listboxId}
        />
      )}
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-disabled={disabled || undefined}
        aria-controls={expanded ? listboxId : undefined}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        aria-label={placeholder}
        data-placeholder={placeholder}
        data-testid="mention-editor"
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCopy={handleCopy}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className="mention-editor max-h-28 min-h-[28px] w-full overflow-y-auto rounded border border-[#30363d] bg-[#161b22] px-2 py-1.5 font-mono text-[11px] leading-5 text-[#e6edf3] outline-none focus-within:border-[#58a6ff]"
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
      />
    </div>
  );
}

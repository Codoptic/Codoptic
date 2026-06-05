'use client';

// Motivation vs Logic: A mention chip needs two distinct surfaces. (1) Inside the contenteditable
// composer it must be an atomic DOM node — `contenteditable="false"` so the caret and Backspace
// treat it as a single unit, with `data-mention-*` attributes that survive a DOM->JSON round
// trip. (2) Outside the composer (e.g. the suggestion preview or an attachment summary) it can be
// a regular React component. This file exposes both: `MentionChip` (React) renders the chip via
// JSX, and `createMentionChipNode` builds the identical DOM node imperatively so the composer
// can splice it into the editable tree without fighting React's reconciler.

import type { SelectedMention } from '@/lib/code-space/mentions/types';

export const MENTION_CHIP_CLASS = 'mention-chip';
export type MentionChipIconKind = 'document' | 'extension' | 'file' | 'folder' | 'stack';

const DOC_NAMES_RE = /^(README|AGENTS|CHANGELOG|CONTRIBUTING|LICENSE|COPYING)(\.[^.]+)?$/i;
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const STACK_EXTENSIONS = new Set(['.py', '.rb', '.go', '.rs', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt', '.kts', '.sh', '.bash', '.zsh', '.lua']);
const EXTENSION_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']);

function fileExtensionFor(mention: SelectedMention): string {
  const lower = mention.basename.toLowerCase();
  const dotIndex = lower.lastIndexOf('.');
  return dotIndex > 0 ? lower.slice(dotIndex) : '';
}

export function mentionChipIconKind(mention: SelectedMention): MentionChipIconKind {
  if (mention.type === 'folder') return 'folder';
  const ext = fileExtensionFor(mention);
  if (DOC_NAMES_RE.test(mention.basename) || DOC_EXTENSIONS.has(ext)) return 'document';
  if (STACK_EXTENSIONS.has(ext)) return 'stack';
  if (EXTENSION_EXTENSIONS.has(ext)) return 'extension';
  return 'file';
}

function ariaLabelFor(mention: SelectedMention): string {
  return mention.type === 'file'
    ? `File ${mention.relativePath}`
    : `Folder ${mention.relativePath}`;
}

export function mentionChipLabel(mention: SelectedMention): string {
  if (mention.type === 'folder') {
    return mention.displayName || `${mention.basename}/`;
  }
  return mention.displayName || mention.basename;
}

export function mentionChipMarkdown(mention: SelectedMention): string {
  return `[${mentionChipLabel(mention)}](${mention.relativePath})`;
}

/**
 * Build the DOM node that lives inside the contenteditable composer. The composer treats the
 * returned span as opaque (contenteditable=false) and reads back its `data-mention-*` attributes
 * when serializing to (text, mentions) on submit or copy. Keep this in sync with `MentionChip`
 * below.
 */
export function createMentionChipNode(
  doc: Document,
  mention: SelectedMention,
): HTMLSpanElement {
  const span = doc.createElement('span');
  span.className = `${MENTION_CHIP_CLASS} ${mention.type === 'folder' ? 'mention-chip--folder' : 'mention-chip--file'}`;
  span.setAttribute('contenteditable', 'false');
  span.setAttribute('data-mention-chip', 'true');
  span.setAttribute('data-mention-type', mention.type);
  span.setAttribute('data-mention-icon-kind', mentionChipIconKind(mention));
  span.setAttribute('data-mention-path', mention.relativePath);
  span.setAttribute('data-mention-name', mention.basename);
  span.setAttribute('data-mention-display-name', mention.displayName);
  span.setAttribute('title', mention.relativePath);
  span.setAttribute('aria-label', ariaLabelFor(mention));
  span.setAttribute('role', 'button');
  span.setAttribute('tabindex', '-1');
  const icon = doc.createElement('span');
  icon.className = `mention-chip__icon mention-chip__icon--${mentionChipIconKind(mention)}`;
  icon.setAttribute('aria-hidden', 'true');
  span.append(icon, doc.createTextNode(mentionChipLabel(mention)));
  return span;
}

export interface MentionChipProps {
  mention: SelectedMention;
  onRemove?: (mention: SelectedMention) => void;
  removable?: boolean;
}

/**
 * Read-only render of a mention chip outside the composer. Same shape as
 * `createMentionChipNode` so screen readers and tooltips still expose the full path while the
 * visible label stays compact.
 */
export function MentionChip({ mention, onRemove, removable = false }: MentionChipProps) {
  const visible = mentionChipLabel(mention);
  const ariaLabel = ariaLabelFor(mention);
  const iconKind = mentionChipIconKind(mention);
  return (
    <span
      className={`${MENTION_CHIP_CLASS} ${mention.type === 'folder' ? 'mention-chip--folder' : 'mention-chip--file'}`}
      title={mention.relativePath}
      aria-label={ariaLabel}
      data-mention-chip="true"
      data-mention-type={mention.type}
      data-mention-icon-kind={iconKind}
      data-mention-path={mention.relativePath}
      data-mention-name={mention.basename}
      data-mention-display-name={mention.displayName}
    >
      <span className={`mention-chip__icon mention-chip__icon--${iconKind}`} aria-hidden="true" />
      <span className="mention-chip__label">{visible}</span>
      {removable && onRemove ? (
        <button
          type="button"
          onClick={() => onRemove(mention)}
          className="mention-chip__remove"
          aria-label={`Remove ${ariaLabel}`}
        >
          x
        </button>
      ) : null}
    </span>
  );
}

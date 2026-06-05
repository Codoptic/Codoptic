'use client';

// Motivation vs Logic: The suggestion popover is the only user-visible surface that has to
// translate `MentionSuggestion` objects into IDE-style rows. Keeping it stateless (everything
// driven by `suggestions`, `activeIndex`, `status`) means the composer can swap between fresh
// query results without coordinating internal state. Rows render the basename as the primary
// label with the matched substring highlighted, and a muted parent-path line below for
// disambiguation (e.g. when two `controlPanel.tsx` files exist).

import React, { type CSSProperties } from 'react';
import type { MentionMatchRange, MentionSuggestion } from '@/lib/code-space/mentions/types';
import type { MentionIndexStatus } from '@/lib/code-space/mentions/useMentionIndex';
import { mentionChipIconKind } from './MentionChip';

export interface MentionSuggestorProps {
  suggestions: MentionSuggestion[];
  activeIndex: number;
  status: MentionIndexStatus;
  error?: string;
  anchorRect: DOMRect | null;
  containerRect: DOMRect | null;
  onSelect: (suggestion: MentionSuggestion) => void;
  onHighlight: (index: number) => void;
  listboxId: string;
}

function highlightBasename(basename: string, ranges: MentionMatchRange[]): React.ReactNode {
  const basenameRanges = ranges
    .filter((range) => range.field === 'basename')
    .sort((a, b) => a.start - b.start);
  if (basenameRanges.length === 0) return basename;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  basenameRanges.forEach((range, idx) => {
    const start = Math.max(range.start, cursor);
    const end = Math.min(range.end, basename.length);
    if (start > cursor) parts.push(basename.slice(cursor, start));
    if (end > start) {
      parts.push(
        <span key={`m:${idx}`} className="mention-suggestor__match">
          {basename.slice(start, end)}
        </span>,
      );
    }
    cursor = Math.max(cursor, end);
  });
  if (cursor < basename.length) parts.push(basename.slice(cursor));
  return parts;
}

export function MentionSuggestor({
  suggestions,
  activeIndex,
  status,
  error,
  anchorRect,
  containerRect,
  onSelect,
  onHighlight,
  listboxId,
}: MentionSuggestorProps) {
  const positionStyle: CSSProperties = (() => {
    if (!anchorRect || !containerRect) return { display: 'none' };
    const left = Math.max(0, anchorRect.left - containerRect.left);
    return {
      left,
      bottom: Math.max(0, containerRect.bottom - anchorRect.top + 4),
      position: 'absolute',
      minWidth: 280,
      maxWidth: 520,
    };
  })();

  const isLoading = status === 'loading' && suggestions.length === 0;
  const isError = status === 'error';

  return (
    <ul
      id={listboxId}
      role="listbox"
      data-testid="mention-dropdown"
      style={positionStyle}
      className="mention-suggestor z-50 max-h-80 overflow-y-auto rounded border border-[#30363d] bg-[#161b22] shadow-lg"
    >
      {isError && (
        <li className="px-3 py-2 text-[10px] text-[#f85149]" role="alert">
          Could not index project files{error ? `: ${error}` : ''}
        </li>
      )}
      {!isError && isLoading && (
        <li className="px-3 py-2 text-[10px] text-[#8b949e]">Indexing project files...</li>
      )}
      {!isError && !isLoading && suggestions.length === 0 && (
        <li className="px-3 py-2 text-[10px] text-[#8b949e]">
          <div>No matching files or folders</div>
          <div className="text-[#6e7681]">Try a different path or check ignored files.</div>
        </li>
      )}
      {suggestions.map((suggestion, index) => {
        const iconKind = mentionChipIconKind({
          id: suggestion.id,
          type: suggestion.type,
          basename: suggestion.basename,
          displayName: suggestion.displayName,
          relativePath: suggestion.relativePath,
        });
        const isActive = index === activeIndex;
        return (
          <li
            key={suggestion.id}
            id={`${listboxId}-option-${index}`}
            role="option"
            aria-selected={isActive}
            data-suggestion-index={index}
            data-mention-type={suggestion.type}
            data-mention-icon-kind={iconKind}
            data-mention-path={suggestion.relativePath}
            title={suggestion.tooltip}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(suggestion);
            }}
            onMouseEnter={() => onHighlight(index)}
            className={`flex cursor-pointer items-start gap-2 border-b border-transparent px-2 py-1.5 text-[11px] ${
              isActive ? 'bg-[#1f6feb33] text-[#e6edf3]' : 'text-[#c9d1d9] hover:bg-[#1f1f1f]'
            }`}
          >
            <span
              className={`mention-chip__icon mention-chip__icon--${iconKind} mt-[2px] shrink-0`}
              aria-hidden="true"
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-1.5 truncate font-medium text-[#e6edf3]">
                <span className="truncate">
                  {highlightBasename(suggestion.basename, suggestion.matchRanges)}
                  {suggestion.type === 'folder' ? <span className="text-[#8b949e]">/</span> : null}
                </span>
                {suggestion.badges.includes('open') && (
                  <span className="rounded bg-[#1f6feb33] px-1 text-[9px] uppercase text-[#58a6ff]">open</span>
                )}
                {suggestion.badges.includes('recent') && (
                  <span className="rounded bg-[#3fb95033] px-1 text-[9px] uppercase text-[#3fb950]">recent</span>
                )}
              </div>
              {suggestion.parentPath ? (
                <div
                  className="truncate text-[10px] text-[#6e7681]"
                  title={suggestion.relativePath}
                >
                  {suggestion.parentPath}
                </div>
              ) : (
                <div className="text-[10px] text-[#6e7681]">project root</div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

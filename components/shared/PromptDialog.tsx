'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, X } from 'lucide-react';

interface Props {
  open: boolean;
  title: string;
  /** Optional supporting copy shown above the input. */
  description?: string;
  /** Label rendered above the text input. Defaults to "Value". */
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Helper text rendered below the input when the value is valid. */
  helperText?: string;
  /** When provided, called with the trimmed value. Return an error message to block submit. */
  validate?: (value: string) => string | null;
  /**
   * When true, the input contents are selected on open so the user can immediately overwrite the
   * default value (mirrors the behaviour of `window.prompt`).
   */
  selectOnOpen?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/**
 * Motivation vs Logic: Many flows used `window.prompt` for quick text input. Browser prompts
 * are unstyled, blocking, and leak the page origin ("localhost:4000 says"). This component is
 * the in-app replacement: a portal-mounted modal with keyboard handling, validation, and
 * theme-consistent chrome so file/folder/project renames feel native to the workspace.
 */
export function PromptDialog({
  open,
  title,
  description,
  label = 'Value',
  placeholder,
  defaultValue = '',
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  helperText,
  validate,
  selectOnOpen = true,
  onConfirm,
  onCancel,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (open) setValue(defaultValue);
  }, [defaultValue, open]);

  const trimmed = useMemo(() => value.trim(), [value]);
  const validationError = useMemo(() => {
    if (!validate) return null;
    return validate(trimmed);
  }, [trimmed, validate]);
  const canSubmit = trimmed.length > 0 && !validationError;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
      if (event.key === 'Enter' && !event.shiftKey && canSubmit) {
        event.preventDefault();
        onConfirm(trimmed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSubmit, onCancel, onConfirm, open, trimmed]);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      if (selectOnOpen) input.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, selectOnOpen]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      aria-modal="true"
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="dialog"
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-700 bg-slate-850 px-4 py-3">
          <div className="flex items-center gap-2">
            <Pencil size={14} className="shrink-0 text-accent" />
            <span className="text-[13px] font-medium text-slate-100">{title}</span>
          </div>
          <button
            aria-label="Cancel"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-100"
            onClick={onCancel}
            type="button"
          >
            <X size={13} />
          </button>
        </div>

        <div className="px-4 py-4">
          {description ? (
            <p className="mb-3 text-[12px] leading-relaxed text-slate-400">{description}</p>
          ) : null}
          <label
            className="block text-[12px] font-medium text-slate-200"
            htmlFor="codoptic-prompt-dialog-input"
          >
            {label}
          </label>
          <input
            ref={inputRef}
            id="codoptic-prompt-dialog-input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            className={`mt-2 h-10 w-full rounded-lg border bg-slate-950 px-3 text-[13px] text-slate-100 outline-none transition-colors focus:border-accent/70 focus:ring-2 focus:ring-accent/20 ${
              validationError ? 'border-red-500/60' : 'border-slate-700'
            }`}
            aria-invalid={Boolean(validationError)}
          />
          <p
            className={`mt-2 text-[12px] leading-relaxed ${
              validationError ? 'text-red-300' : 'text-slate-400'
            }`}
          >
            {validationError ?? helperText ?? '\u00A0'}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-700 bg-slate-850 px-4 py-3">
          <button
            className="inline-flex h-9 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-[12px] text-slate-200 transition-colors hover:bg-slate-700 hover:text-slate-100"
            onClick={onCancel}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className="inline-flex h-9 items-center rounded-md border border-accent/40 bg-accent/20 px-3 text-[12px] font-medium text-accent transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => canSubmit && onConfirm(trimmed)}
            disabled={!canSubmit}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

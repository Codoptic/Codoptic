'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export type AlertDialogVariant = 'info' | 'success' | 'warning' | 'error';

interface Props {
  open: boolean;
  title: string;
  message: string;
  variant?: AlertDialogVariant;
  confirmLabel?: string;
  onClose: () => void;
}

const VARIANT_STYLES: Record<AlertDialogVariant, { iconClass: string; pillClass: string; Icon: typeof Info }>
  = {
  info: {
    iconClass: 'text-sky-300',
    pillClass: 'border-sky-500/40 bg-sky-500/15 text-sky-200',
    Icon: Info,
  },
  success: {
    iconClass: 'text-emerald-300',
    pillClass: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
    Icon: CheckCircle2,
  },
  warning: {
    iconClass: 'text-amber-300',
    pillClass: 'border-amber-500/40 bg-amber-500/15 text-amber-200',
    Icon: AlertTriangle,
  },
  error: {
    iconClass: 'text-red-300',
    pillClass: 'border-red-500/50 bg-red-500/15 text-red-200',
    Icon: AlertTriangle,
  },
};

/**
 * Motivation vs Logic: Browser `alert()` dialogs leak the page origin, block the JS thread,
 * and look out of place next to the in-app chrome. This portal-mounted modal renders the same
 * information with a variant-aware icon, focus trap-friendly chrome, and `Enter`/`Escape`
 * shortcuts so error and informational messages feel like part of the workspace.
 */
export function AlertDialog({
  open,
  title,
  message,
  variant = 'info',
  confirmLabel = 'OK',
  onClose,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, open]);

  if (!open || typeof document === 'undefined') return null;

  const { iconClass, pillClass, Icon } = VARIANT_STYLES[variant];

  return createPortal(
    <div
      aria-modal="true"
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="alertdialog"
    >
      <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-700 bg-slate-850 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className={`inline-flex h-7 w-7 items-center justify-center rounded-md border ${pillClass}`}>
              <Icon size={14} className={iconClass} />
            </span>
            <span className="text-[13px] font-medium text-slate-100">{title}</span>
          </div>
          <button
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-100"
            onClick={onClose}
            type="button"
          >
            <X size={13} />
          </button>
        </div>

        <div className="px-4 py-4">
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-300">{message}</p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-700 bg-slate-850 px-4 py-3">
          <button
            autoFocus
            className="inline-flex h-9 items-center rounded-md border border-accent/40 bg-accent/20 px-3 text-[12px] font-medium text-accent transition-colors hover:bg-accent/30"
            onClick={onClose}
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

'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertDialog, type AlertDialogVariant } from './AlertDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { PromptDialog } from './PromptDialog';

interface PromptOptions {
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  helperText?: string;
  choices?: Array<{
    value: string;
    label: string;
    description?: string;
    icon?: ReactNode;
  }>;
  validate?: (value: string) => string | null;
  selectOnOpen?: boolean;
}

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
}

interface AlertOptions {
  title: string;
  message: string;
  variant?: AlertDialogVariant;
  confirmLabel?: string;
}

interface PromptState extends PromptOptions {
  resolve: (value: string | null) => void;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

interface AlertState extends AlertOptions {
  resolve: () => void;
}

interface UseAppDialogs {
  /** Show a single-text-input modal. Resolves with the trimmed value or `null` on cancel. */
  prompt(options: PromptOptions): Promise<string | null>;
  /** Show a confirm modal. Resolves `true` on confirm, `false` on cancel. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Show an informational/error alert. Resolves when dismissed. */
  alert(options: AlertOptions): Promise<void>;
  /** Element to render anywhere in the component tree to mount the dialogs. */
  dialogs: ReactNode;
}

/**
 * Motivation vs Logic: The native `window.prompt`, `window.confirm`, and `window.alert` flows
 * across CodeSpace were imperative-async (callers awaited a synchronous return value). Re-doing
 * each call site as React state would touch dozens of callbacks. This hook keeps the original
 * `await` ergonomics by returning Promises that resolve when the user interacts with the
 * portal-mounted modals, while letting consumers render a single `dialogs` element to mount the
 * UI. Only one dialog of each kind is queued at a time which matches browser semantics.
 */
export function useAppDialogs(): UseAppDialogs {
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [alertState, setAlertState] = useState<AlertState | null>(null);

  const promptResolveRef = useRef<((value: string | null) => void) | null>(null);
  const confirmResolveRef = useRef<((value: boolean) => void) | null>(null);
  const alertResolveRef = useRef<(() => void) | null>(null);

  const prompt = useCallback((options: PromptOptions) => {
    if (promptResolveRef.current) {
      promptResolveRef.current(null);
      promptResolveRef.current = null;
    }
    return new Promise<string | null>((resolve) => {
      promptResolveRef.current = resolve;
      setPromptState({ ...options, resolve });
    });
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    if (confirmResolveRef.current) {
      confirmResolveRef.current(false);
      confirmResolveRef.current = null;
    }
    return new Promise<boolean>((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmState({ ...options, resolve });
    });
  }, []);

  const alert = useCallback((options: AlertOptions) => {
    if (alertResolveRef.current) {
      alertResolveRef.current();
      alertResolveRef.current = null;
    }
    return new Promise<void>((resolve) => {
      alertResolveRef.current = resolve;
      setAlertState({ ...options, resolve });
    });
  }, []);

  const handlePromptConfirm = useCallback(
    (value: string) => {
      const resolve = promptResolveRef.current;
      promptResolveRef.current = null;
      setPromptState(null);
      resolve?.(value);
    },
    [],
  );

  const handlePromptCancel = useCallback(() => {
    const resolve = promptResolveRef.current;
    promptResolveRef.current = null;
    setPromptState(null);
    resolve?.(null);
  }, []);

  const handleConfirmAccept = useCallback(() => {
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    setConfirmState(null);
    resolve?.(true);
  }, []);

  const handleConfirmCancel = useCallback(() => {
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    setConfirmState(null);
    resolve?.(false);
  }, []);

  const handleAlertClose = useCallback(() => {
    const resolve = alertResolveRef.current;
    alertResolveRef.current = null;
    setAlertState(null);
    resolve?.();
  }, []);

  const dialogs = useMemo(
    () => (
      <>
        <PromptDialog
          open={Boolean(promptState)}
          title={promptState?.title ?? ''}
          description={promptState?.description}
          label={promptState?.label}
          placeholder={promptState?.placeholder}
          defaultValue={promptState?.defaultValue}
          confirmLabel={promptState?.confirmLabel}
          cancelLabel={promptState?.cancelLabel}
          helperText={promptState?.helperText}
          choices={promptState?.choices}
          validate={promptState?.validate}
          selectOnOpen={promptState?.selectOnOpen}
          onConfirm={handlePromptConfirm}
          onCancel={handlePromptCancel}
        />
        <ConfirmDialog
          open={Boolean(confirmState)}
          title={confirmState?.title ?? ''}
          message={confirmState?.message ?? ''}
          confirmLabel={confirmState?.confirmLabel}
          onConfirm={handleConfirmAccept}
          onCancel={handleConfirmCancel}
        />
        <AlertDialog
          open={Boolean(alertState)}
          title={alertState?.title ?? ''}
          message={alertState?.message ?? ''}
          variant={alertState?.variant}
          confirmLabel={alertState?.confirmLabel}
          onClose={handleAlertClose}
        />
      </>
    ),
    [
      alertState,
      confirmState,
      handleAlertClose,
      handleConfirmAccept,
      handleConfirmCancel,
      handlePromptCancel,
      handlePromptConfirm,
      promptState,
    ],
  );

  return { prompt, confirm, alert, dialogs };
}

'use client';

import { AlertTriangle, Archive, History, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CodeSpaceAgentSession } from '@/lib/code-space/core';
import { CollapsibleSection } from './CollapsibleSection';

interface SessionListSectionProps {
  sessions: CodeSpaceAgentSession[];
  activeSessionId: string | null;
  activeProjectName?: string;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (session: CodeSpaceAgentSession) => void;
  onDeleteSession: (session: CodeSpaceAgentSession) => void | Promise<void>;
}

function buildSessionSubtitle(session: CodeSpaceAgentSession): string {
  const lastMessage = [...session.messages].reverse().find((message) => message.role !== 'tool' && message.content.trim());
  if (lastMessage) {
    return lastMessage.content.replace(/\s+/g, ' ').slice(0, 72);
  }
  return session.status;
}

export function SessionListSection({
  sessions,
  activeSessionId,
  activeProjectName,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: SessionListSectionProps) {
  const [deleteTarget, setDeleteTarget] = useState<CodeSpaceAgentSession | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const closeDeleteDialog = () => {
    if (isDeleting) return;
    setDeleteTarget(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget || isDeleting) return;
    setIsDeleting(true);

    // Root Cause vs Logic: this modal is the only confirmation layer for session deletion now
    // that the parent workspace no longer triggers `window.confirm`. The parent exposes a
    // confirm-free removal callback, so we can call it directly without shadowing globals.
    try {
      await onDeleteSession(deleteTarget);
      setDeleteTarget(null);
    } finally {
      setIsDeleting(false);
    }
  };

  useEffect(() => {
    if (!deleteTarget) return;
    const stillExists = sessions.some((session) => session.id === deleteTarget.id);
    if (!stillExists) setDeleteTarget(null);
  }, [deleteTarget, sessions]);

  useEffect(() => {
    if (!deleteTarget) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDeleteDialog();
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void confirmDelete();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [deleteTarget, isDeleting]);

  return (
    <>
      <CollapsibleSection
        title="Session"
        defaultOpen={false}
        compact
        rightSlot={
          <div className="flex items-center gap-2">
            {activeProjectName ? (
              <span className="rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-accent">
                {activeProjectName}
              </span>
            ) : null}
            <span className="text-[9px] text-[#6d6d6d]">{sessions.length}</span>
          </div>
        }
      >
        <div className="max-h-64 overflow-y-auto rounded border border-[#2a2a2a] bg-[#111111] p-1">
          {sessions.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-[#8b8b8b]">No sessions yet.</div>
          ) : (
            sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const subtitle = buildSessionSubtitle(session);
              const handleSelect = () => onSelectSession(session.id);
              const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectSession(session.id);
                }
              };

              return (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  onClick={handleSelect}
                  onKeyDown={handleKeyDown}
                  aria-current={isActive ? 'true' : undefined}
                  className={`group mb-1 flex items-start justify-between rounded border px-2 py-2 text-[12px] ${
                    isActive ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:border-[#2a2a2a] hover:bg-[#1b1b1b]'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {session.archived && <Archive size={12} className="text-[#8b8b8b]" />}
                      <div className="truncate font-medium text-[#d4d4d4]">{session.title}</div>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[#8b8b8b]">
                      <History size={11} />
                      <span>{session.archived ? 'archived' : session.status}</span>
                      <span>·</span>
                      <span>{new Date(session.updatedAt).toLocaleString()}</span>
                    </div>
                    <div className="mt-1 truncate text-[10px] text-[#6d6d6d]">{subtitle}</div>
                  </div>
                  <div className="ml-3 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRenameSession(session);
                      }}
                      className="rounded border border-transparent px-1.5 text-[#8b8b8b] hover:border-[#3a3a3a] hover:text-[#d4d4d4]"
                      title="Rename session"
                      aria-label="Rename session"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteTarget(session);
                      }}
                      className="rounded border border-transparent px-1.5 text-[#8b8b8b] hover:border-[#3a3a3a] hover:text-[#f85149]"
                      title="Delete session"
                      aria-label="Delete session"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CollapsibleSection>

      {deleteTarget && typeof document !== 'undefined'
        ? createPortal(
            // Root Cause vs Logic: the AgentPanel right rail applies `font-mono` to its entire
            // subtree, so when this modal rendered inline it inherited the terminal font shown in
            // the screenshot bug report. Mounting through a portal at document.body escapes that
            // context, and the explicit `font-sans` keeps the dialog readable even if a future
            // ancestor toggles its typography.
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-session-title"
              className="fixed inset-0 z-[1200] flex items-center justify-center bg-slate-950/70 px-4 font-sans backdrop-blur-sm"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) closeDeleteDialog();
              }}
            >
              <div className="w-full max-w-md overflow-hidden rounded-xl border border-slate-700 bg-slate-900 text-slate-100 shadow-2xl">
                <div className="flex items-center justify-between border-b border-slate-700 bg-slate-850 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="shrink-0 text-red-400" />
                    <h2 id="delete-session-title" className="text-[13px] font-medium text-slate-100">
                      Delete session
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={closeDeleteDialog}
                    aria-label="Close delete session dialog"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-100"
                  >
                    <X size={13} />
                  </button>
                </div>

                <div className="space-y-3 px-4 py-4">
                  <p className="text-[13px] leading-relaxed text-slate-300">
                    This removes the coding session from your local workspace history. Project files on disk are not changed.
                  </p>
                  <div className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                      Session
                    </div>
                    <div className="mt-0.5 truncate text-[13px] font-medium text-slate-100">
                      {deleteTarget.title}
                    </div>
                  </div>
                  <p className="text-[12px] leading-relaxed text-red-300">
                    This action cannot be undone from the session list.
                  </p>
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-slate-700 bg-slate-850 px-4 py-3">
                  <button
                    type="button"
                    onClick={closeDeleteDialog}
                    disabled={isDeleting}
                    className="inline-flex h-8 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-[12px] text-slate-200 transition-colors hover:bg-slate-700 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmDelete()}
                    disabled={isDeleting}
                    className="inline-flex h-8 items-center rounded-md border border-red-500/50 bg-red-500/15 px-3 text-[12px] font-medium text-red-300 transition-colors hover:bg-red-500/25 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isDeleting ? 'Deleting…' : 'Delete session'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

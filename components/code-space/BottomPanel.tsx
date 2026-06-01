'use client';

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  MessageCircle,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import type { CodeSpaceAgentSession, CodeSpaceBottomTab } from '@/lib/code-space/core';
import { CodeSpaceTerminal } from '@/components/code-space/CodeSpaceTerminal';

interface BottomPanelProps {
  activeSession: CodeSpaceAgentSession | null;
  bottomActiveTab: CodeSpaceBottomTab;
  error: string | null;
  minimapEnabled: boolean;
  onToggleMinimap: () => void;
  wordWrap: boolean;
  onToggleWordWrap: () => void;
  onTabChange: (tab: CodeSpaceBottomTab) => void;
  onHide: () => void;
  projectName: string;
  projectRoot?: string;
}

interface ProblemEntry {
  id: string;
  source: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  timestamp?: number;
}

const TAB_META: Record<CodeSpaceBottomTab, { label: string; icon: typeof AlertCircle }> = {
  problems: { label: 'Problems', icon: AlertTriangle },
  output: { label: 'Output', icon: TerminalSquare },
  debug: { label: 'Console', icon: MessageCircle },
  terminal: { label: 'Terminal', icon: TerminalSquare },
};

const severityOrder: Record<ProblemEntry['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

const EMPTY_PLACEHOLDER = 'No events yet — run a prompt, tool, or command to fill this area.';

function entrySignature(parts: Array<string | number | boolean | null | undefined>): string {
  return parts.map((part) => String(part ?? '')).join('|');
}

// Motivation vs Logic: Align the bottom console with Cursor's Problems/Output/Debug/Terminal workflow so
// each tab surface real diagnostics, logs, and terminal output instead of a single catch-all stream.
export function BottomPanel({
  activeSession,
  bottomActiveTab,
  error,
  minimapEnabled,
  onToggleMinimap,
  wordWrap,
  onToggleWordWrap,
  onTabChange,
  onHide,
  projectName,
  projectRoot,
}: BottomPanelProps) {
  const [clearedSignatures, setClearedSignatures] = useState<{
    problems: Set<string>;
    output: Set<string>;
    debug: Set<string>;
    workspaceError: string | null;
  }>({
    problems: new Set(),
    output: new Set(),
    debug: new Set(),
    workspaceError: null,
  });
  const toolCalls = activeSession?.toolCalls ?? [];
  const verificationResults = activeSession?.verificationResults ?? [];
  const plan = activeSession?.plan ?? [];
  const todos = activeSession?.todos ?? [];
  const debugMessages = activeSession?.messages ?? [];

  const problems = useMemo<Array<ProblemEntry & { signature: string }>>(() => {
    const entries: ProblemEntry[] = [];
    if (error) {
      entries.push({
        id: 'workspace-error',
        source: 'Workspace',
        severity: 'error',
        message: error,
        timestamp: Date.now(),
      });
    }
    toolCalls
      .filter((call) => call.status === 'error')
      .forEach((call) => {
        entries.push({
          id: call.id,
          source: call.name,
          severity: 'error',
          message: call.summary,
          timestamp: call.updatedAt,
        });
      });
    verificationResults.forEach((result) => {
      entries.push({
        id: result.id,
        source: result.command,
        severity: result.status === 'failed' ? 'error' : 'info',
        message: result.output,
        timestamp: Date.now(),
      });
    });
    todos
      .filter((todo) => !todo.done)
      .forEach((todo) => {
        entries.push({
          id: todo.id,
          source: 'Plan',
          severity: 'warning',
          message: `Pending: ${todo.text}`,
          timestamp: Date.now(),
        });
      });
    entries.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    return entries.map((entry) => ({
      ...entry,
      signature: entrySignature([entry.id, entry.source, entry.severity, entry.message]),
    }));
  }, [error, toolCalls, verificationResults, todos]);

  const visibleWorkspaceError = error && error !== clearedSignatures.workspaceError ? error : null;
  const visibleProblems = useMemo(
    () =>
      problems.filter((problem) => !clearedSignatures.problems.has(problem.signature)).filter((problem) => {
        if (problem.source !== 'Workspace') return true;
        return visibleWorkspaceError === problem.message;
      }),
    [clearedSignatures.problems, problems, visibleWorkspaceError],
  );
  const visibleOutput = useMemo(
    () =>
      toolCalls.filter((call) => !clearedSignatures.output.has(entrySignature([call.id, call.status, call.summary]))),
    [clearedSignatures.output, toolCalls],
  );
  const visibleDebug = useMemo(() => {
    const visiblePlan = plan
      .map((step, index) => ({
        id: entrySignature(['plan', index, step]),
        signature: entrySignature(['plan', index, step]),
        step,
      }))
      .filter((entry) => !clearedSignatures.debug.has(entry.signature));
    const visibleTodos = todos
      .map((todo) => ({
        id: entrySignature(['todo', todo.id, todo.text, todo.done]),
        signature: entrySignature(['todo', todo.id, todo.text, todo.done]),
        todo,
      }))
      .filter((entry) => !clearedSignatures.debug.has(entry.signature));
    const visibleMessages = debugMessages
      .map((message) => ({
        id: entrySignature(['message', message.id, message.role, message.content]),
        signature: entrySignature(['message', message.id, message.role, message.content]),
        message,
      }))
      .filter((entry) => !clearedSignatures.debug.has(entry.signature));
    return { visiblePlan, visibleTodos, visibleMessages };
  }, [clearedSignatures.debug, debugMessages, plan, todos]);

  const problemsCount = visibleProblems.length;
  const outputCount = visibleOutput.length;
  const debugCount = visibleDebug.visiblePlan.length + visibleDebug.visibleTodos.length + visibleDebug.visibleMessages.length;
  const terminalCount = projectRoot ? 1 : 0;

  const handleClearLogs = () => {
    setClearedSignatures((current) => {
      const nextProblems = new Set(current.problems);
      const nextOutput = new Set(current.output);
      const nextDebug = new Set(current.debug);

      for (const problem of visibleProblems) nextProblems.add(problem.signature);
      for (const call of visibleOutput) nextOutput.add(entrySignature([call.id, call.status, call.summary]));
      for (const entry of visibleDebug.visiblePlan) nextDebug.add(entry.signature);
      for (const entry of visibleDebug.visibleTodos) nextDebug.add(entry.signature);
      for (const entry of visibleDebug.visibleMessages) nextDebug.add(entry.signature);

      return {
        problems: nextProblems,
        output: nextOutput,
        debug: nextDebug,
        workspaceError: visibleWorkspaceError ?? current.workspaceError,
      };
    });
  };

  const renderTabContent = () => {
    if (bottomActiveTab === 'problems') {
      return visibleProblems.length ? (
        <div className="space-y-2 text-sm">
          {visibleProblems.map((problem) => (
            <div
              key={problem.id}
              className="flex items-center justify-between rounded border border-[#2a2a2a] bg-[#0f0f0f] p-2"
            >
              <div>
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[#9ea9b8]">
                  {problem.severity === 'error' ? (
                    <AlertCircle size={12} className="text-[#ff6565]" />
                  ) : (
                    <CheckCircle2 size={12} className="text-[#43b581]" />
                  )}
                  <span>{problem.source}</span>
                </div>
                <p className="text-[12px] text-[#d4d4d4]">{problem.message}</p>
              </div>
              <span className="text-[10px] text-[#7d7d7d]">
                {problem.timestamp ? new Date(problem.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-[#8b8b8b]">{EMPTY_PLACEHOLDER}</div>
      );
    }
    if (bottomActiveTab === 'output') {
      return visibleOutput.length ? (
        <div className="space-y-2 text-[12px]">
          {visibleOutput.map((call) => (
            <div key={call.id} className="rounded border border-[#2a2a2a] bg-[#0f0f0f] p-2">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <div className="flex flex-wrap items-center gap-2 font-semibold uppercase tracking-wider text-[#8ca0c2]">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${call.status === 'error' ? 'bg-[#5c1616] text-[#ffadad]' : 'bg-[#1a4c28] text-[#6ee69c]'}`}>
                    {call.status.toUpperCase()}
                  </span>
                  <span>{call.name}</span>
                </div>
                <span className="text-[10px] text-[#6d6d6d]">
                  {new Date(call.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <p className="mt-1 text-[12px] text-[#d4d4d4]">{call.summary}</p>
              {(call.input !== undefined || call.output !== undefined) && (
                <div className="mt-2 space-y-1 text-[10px] text-[#8b8b8b]">
                  {call.input !== undefined && (
                    <details className="rounded border border-[#2a2a2a] bg-[#151515] p-2">
                      <summary className="cursor-pointer">Input</summary>
                      <pre className="whitespace-pre-wrap text-[11px] text-[#c6d0e1]">
                        {JSON.stringify(call.input, null, 2)}
                      </pre>
                    </details>
                  )}
                  {call.output !== undefined && (
                    <details className="rounded border border-[#2a2a2a] bg-[#151515] p-2">
                      <summary className="cursor-pointer">Output</summary>
                      <pre className="whitespace-pre-wrap text-[11px] text-[#c6d0e1]">
                        {JSON.stringify(call.output, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-[#8b8b8b]">No output yet. {EMPTY_PLACEHOLDER}</div>
      );
    }
    if (bottomActiveTab === 'debug') {
      return (
        <div className="space-y-3 text-[11px]">
          <section>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-[#6d6d6d]">
              <span>Plan</span>
              <span>{visibleDebug.visiblePlan.length} step{visibleDebug.visiblePlan.length === 1 ? '' : 's'}</span>
            </div>
            {visibleDebug.visiblePlan.length ? (
              <ol className="mt-1 space-y-1 pl-4 text-[#d4d4d4]">
                {visibleDebug.visiblePlan.map((entry) => (
                  <li key={entry.id} className="marker:text-[#6d6d6d]">
                    {entry.step}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-1 text-[#8b8b8b]">Add a prompt to start building a plan.</p>
            )}
          </section>
          <section>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-[#6d6d6d]">
              <span>Todos</span>
              <span>{visibleDebug.visibleTodos.filter((entry) => !entry.todo.done).length} active</span>
            </div>
            {visibleDebug.visibleTodos.length ? (
              <div className="mt-1 space-y-1 text-[#d4d4d4]">
                {visibleDebug.visibleTodos.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2 text-[11px]">
                    <span className={`h-3 w-3 rounded-full border ${entry.todo.done ? 'border-[#3b8b3b] bg-[#3b8b3b]' : 'border-[#4a4a4a]'}`} />
                    <span className={entry.todo.done ? 'text-[#6d6d6d]' : 'text-[#d4d4d4]'}>{entry.todo.text}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-[#8b8b8b]">Lifecycle tasks appear once you submit a prompt.</p>
            )}
          </section>
          <section>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-[#6d6d6d]">
              <span>Messages</span>
              <span>{visibleDebug.visibleMessages.length}</span>
            </div>
            {visibleDebug.visibleMessages.length ? (
              <div className="mt-1 space-y-2 max-h-[120px] overflow-y-auto">
                {visibleDebug.visibleMessages.map((entry) => (
                  <div key={entry.id} className="rounded border border-[#2a2a2a] bg-[#0f0f0f] p-2">
                    <div className="flex items-center justify-between text-[10px] text-[#6d6d6d]">
                      <div className="flex items-center gap-2">
                        {entry.message.role === 'assistant' ? (
                          <Bot size={12} className="text-[#9ec3ff]" />
                        ) : (
                          <MessageCircle size={12} className="text-[#f3a3ff]" />
                        )}
                        <span className="uppercase tracking-widest">{entry.message.role}</span>
                      </div>
                      <span>{new Date(entry.message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className="mt-1 text-[12px] text-[#d4d4d4]">{entry.message.content}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-[#8b8b8b]">{EMPTY_PLACEHOLDER}</p>
            )}
          </section>
        </div>
      );
    }
    return <CodeSpaceTerminal projectRoot={projectRoot} active={bottomActiveTab === 'terminal'} />;
  };

  return (
    <div className="h-52 border-t border-[#2a2a2a] bg-[#121212]">
      <div className="flex h-9 items-center justify-between border-b border-[#2a2a2a] px-3">
        <div className="flex items-center gap-1.5">
          {Object.entries(TAB_META).map(([id, { label, icon: Icon }]) => {
            const tabId = id as CodeSpaceBottomTab;
            const count =
              tabId === 'problems'
                ? problemsCount
                : tabId === 'output'
                ? outputCount
                : tabId === 'debug'
                ? debugCount
                : terminalCount;
            return (
              <button
                key={tabId}
                type="button"
                onClick={() => onTabChange(tabId)}
                aria-pressed={bottomActiveTab === tabId}
                className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-normal transition ${
                  bottomActiveTab === tabId
                    ? 'bg-[#171717] text-white'
                    : 'text-[#8c8c8c] hover:text-white'
                }`}
              >
                {/* Root Cause vs Logic: lucide icons are React components, not plain functions, so render via JSX. */}
                <Icon
                  size={12}
                  className={bottomActiveTab === tabId ? 'text-white' : 'text-[#8c8c8c]'}
                />
                <span className="whitespace-nowrap">
                  {label}
                  <span className="ml-1 text-[9px] text-[#6d6d6d]">({count})</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-[#8c8c8c]">
          <span className="rounded-full border border-[#2a2a2a] px-2 py-0.5 text-[9px] uppercase">{activeSession?.status ?? 'idle'}</span>
          <button
            type="button"
            onClick={handleClearLogs}
            disabled={!visibleProblems.length && !visibleOutput.length && !visibleDebug.visiblePlan.length && !visibleDebug.visibleTodos.length && !visibleDebug.visibleMessages.length && !visibleWorkspaceError}
            className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[9px] text-[#8c8c8c] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            title="Clear Problems, Output, and Console logs"
            aria-label="Clear Problems, Output, and Console logs"
          >
            <span className="inline-flex items-center gap-1">
              <Trash2 size={10} />
              Clear
            </span>
          </button>
          <button type="button" onClick={onToggleMinimap} className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[9px] text-[#8c8c8c] hover:text-white">
            Minimap {minimapEnabled ? 'On' : 'Off'}
          </button>
          <button type="button" onClick={onToggleWordWrap} className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[9px] text-[#8c8c8c] hover:text-white">
            Wrap {wordWrap ? 'On' : 'Off'}
          </button>
          <button type="button" onClick={onHide} className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[9px] text-[#8c8c8c] hover:text-white">
            Hide
          </button>
        </div>
      </div>
      <div
        className={`h-[calc(100%-2.25rem)] text-[12px] text-[#d4d4d4] ${
          bottomActiveTab === 'terminal' ? 'min-h-0 overflow-hidden p-1' : 'overflow-auto p-3'
        }`}
      >
        {renderTabContent()}
      </div>
    </div>
  );
}

'use client';

import React, { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Bot, Loader2, Zap } from 'lucide-react';
import { addSessionTokens, estimateTokens } from '@/lib/code-space/tokenUsage';
import { TokenUsageSpinbar } from './TokenUsageSpinbar';
import type { CodeSpaceAgentSession, CodeSpaceMessage } from '@/lib/code-space/core';
import type { CodeSpaceAgentMode } from '@/lib/code-space/agentModes';
import { getCodeSpaceExecutionPolicyMeta, type CodeSpaceExecutionPolicy } from '@/lib/code-space/executionPolicy';
import { buildPlanImplementationPrompt, type CodeSpacePromptOptions } from '@/lib/code-space/planBuild';
import { AgentModeSelector } from './AgentModeSelector';
import { ExecutionPolicySelector } from './ExecutionPolicySelector';
import { CollapsibleSection } from './CollapsibleSection';
import { SessionListSection } from './SessionListSection';
import { FileMentionInput } from './FileMentionInput';
import { PlanClarificationPanel } from './PlanClarificationPanel';
import { PlanLink } from './PlanLink';
import type { FileMentionIndex } from '@/lib/code-space/mentions/index';
import { buildMentionIndex } from '@/lib/code-space/mentions/index';
import type { MentionIndexStatus } from '@/lib/code-space/mentions/useMentionIndex';
import type { SelectedMention } from '@/lib/code-space/mentions/types';

interface AgentPanelProps {
  session: CodeSpaceAgentSession | null;
  sessions: CodeSpaceAgentSession[];
  activeProjectName?: string;
  isRunning: boolean;
  toolBudget: number;
  pendingDiffs: Array<{
    diffId: string;
    filePath: string;
    oldContent: string;
    newContent: string;
    explanation?: string;
    unifiedDiff?: string;
  }>;
  appliedDiffs: Array<{
    filePath: string;
    beforeContent: string;
    afterContent: string;
    deleted?: boolean;
    acceptedAt: number;
  }>;
  providerSummary: string;
  agentMode: CodeSpaceAgentMode;
  executionPolicy: CodeSpaceExecutionPolicy;
  onOpenModelConfig: () => void;
  onGenerateDiagram: () => void;
  onOpenAppPlanner: () => void;
  onAgentModeChange: (mode: CodeSpaceAgentMode) => void;
  onExecutionPolicyChange: (policy: CodeSpaceExecutionPolicy) => void;
  canGenerateDiagram: boolean;
  onSelectSession: (sessionId: string | null) => void;
  onRenameSession: (session: CodeSpaceAgentSession) => void;
  onDeleteSession: (session: CodeSpaceAgentSession) => void;
  onSubmitPrompt: (prompt: string, attachments?: SelectedMention[], options?: CodeSpacePromptOptions) => void;
  onCancelRun: () => void;
  onAcceptDiff: (diffId: string) => void;
  onRejectDiff: (diffId: string) => void;
  onOpenDiffFile?: (filePath: string) => void;
  onOpenPlanFile?: (filePath: string) => void;
  onBuildFromPlan?: (filePath: string) => void;
  mentionIndex?: FileMentionIndex;
  indexStatus?: MentionIndexStatus;
  indexError?: string;
  openFiles?: ReadonlyArray<string>;
  recentFiles?: ReadonlyArray<string>;
  currentEditorFilePath?: string;
  filePaths?: string[];
}

function renderMessageText(message: CodeSpaceMessage) {
  const content = message.content.trim() || ' ';
  if (message.role !== 'assistant') return content;

  const legacyDummyResponse =
    /I looked through the relevant project files[\s\S]*Reviewed \d+ files?[\s\S]*Validation available:/i.test(content) ||
    /Reviewed \d+ files? in [\s\S]*Validation available:/i.test(content);

  if (legacyDummyResponse) {
    return 'I gathered project context, but that older run did not produce a direct answer. Send the task again to use the improved Ask/Plan workflow.';
  }

  const looksLikeInternalWorkflow =
    content.includes('Visible workflow:') ||
    content.includes('Repository map:') ||
    content.includes('Dependency trace:') ||
    content.includes('Code mode now performs deep workflow analysis');

  if (!looksLikeInternalWorkflow) return content;

  const appliedIndex = content.indexOf('Applied changes:');
  if (appliedIndex >= 0) return content.slice(appliedIndex).trim();

  return 'I reviewed the project context. No code changes were applied in this run.';
}

function renderDiff(diff: string) {
  return diff.split('\n').map((line, index) => {
    let className = 'text-[#c9d1d9]';
    if (line.startsWith('+') && !line.startsWith('+++')) {
      className = 'bg-[#12261b] text-[#3fb950]';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      className = 'bg-[#2d1517] text-[#f85149]';
    } else if (line.startsWith('@@')) {
      className = 'text-[#79c0ff]';
    }

    return (
      <div key={`${index}:${line.slice(0, 12)}`} className={`whitespace-pre-wrap break-all px-1 ${className}`}>
        {line || ' '}
      </div>
    );
  });
}

function getWorkingLabel(mode: CodeSpaceAgentMode) {
  if (mode === 'plan') return 'Gathering context and preparing the plan workflow…';
  if (mode === 'ask') return 'Reading project context…';
  return 'Working on the implementation…';
}

function formatPhaseLabel(phase?: string) {
  if (!phase) return 'Idle';
  return phase.replace(/_/g, ' ');
}

function modeContract(mode: CodeSpaceAgentMode) {
  if (mode === 'ask') return 'Read-only answers from repository evidence';
  if (mode === 'plan') return 'Writes an executable plan artifact';
  return 'Reviewable patches with validation gates';
}

export function AgentPanel({
  session,
  sessions,
  activeProjectName,
  isRunning,
  pendingDiffs,
  appliedDiffs,
  providerSummary,
  agentMode,
  executionPolicy,
  onOpenModelConfig,
  onGenerateDiagram,
  onOpenAppPlanner,
  onAgentModeChange,
  onExecutionPolicyChange,
  canGenerateDiagram,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onSubmitPrompt,
  onCancelRun,
  onAcceptDiff,
  onRejectDiff,
  onOpenDiffFile,
  onOpenPlanFile,
  onBuildFromPlan,
  mentionIndex,
  indexStatus = 'ready',
  indexError,
  openFiles,
  recentFiles,
  currentEditorFilePath,
  filePaths = [],
}: AgentPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [promptMentions, setPromptMentions] = useState<SelectedMention[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(0);
  const prevSessionIdRef = useRef<string | null>(null);

  const effectiveIndex = useMemo<FileMentionIndex>(() => {
    if (mentionIndex) return mentionIndex;
    return buildMentionIndex(filePaths);
  }, [mentionIndex, filePaths]);
  const executionPolicyMeta = getCodeSpaceExecutionPolicyMeta(executionPolicy);

  const chatEntries = useMemo(() => {
    return (session?.messages ?? [])
      .filter((message) => message.role !== 'tool')
      .map((message, index) => ({
        key: message.id ?? `${message.role}:${index}`,
        message,
      }));
  }, [session?.messages]);

  const visibleValidationResults = useMemo(() => {
    return (session?.verificationResults ?? []).filter((result) => result.status === 'failed' || result.output.trim());
  }, [session?.verificationResults]);
  const visiblePlanBuildStatus = session?.planMarkdown?.buildStatus ?? 'available';

  // Motivation vs Logic: Cursor-style review keeps applied patches visible alongside pending ones, so the sidebar
  // shows the full change history instead of dropping a container as soon as a patch is accepted.
  const visibleDiffs = useMemo(() => {
    const pending = pendingDiffs.map((diff) => ({
      ...diff,
      kind: 'pending' as const,
      oldContent: diff.oldContent,
      newContent: diff.newContent,
      sortAt: Number.MAX_SAFE_INTEGER,
    }));
    const applied = appliedDiffs.map((diff) => ({
      ...diff,
      diffId: `applied:${diff.acceptedAt}:${diff.filePath}`,
      oldContent: diff.beforeContent,
      newContent: diff.afterContent,
      explanation: 'Applied change',
      unifiedDiff: undefined,
      kind: 'applied' as const,
      sortAt: diff.acceptedAt,
    }));
    return [...pending, ...applied].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'pending' ? -1 : 1;
      if (a.kind === 'pending' && b.kind === 'pending') return 0;
      return b.sortAt - a.sortAt;
    });
  }, [appliedDiffs, pendingDiffs]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages, isRunning, session?.planMarkdown?.filePath]);

  // Estimate token usage from new messages and record to the usage tracker
  useEffect(() => {
    const sessionId = session?.id ?? null;
    const messages = session?.messages ?? [];

    if (sessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = sessionId;
      prevMessageCountRef.current = 0;
    }

    const prevCount = prevMessageCountRef.current;
    if (messages.length <= prevCount) return;

    const newMessages = messages.slice(prevCount);
    const combined = newMessages.map((m) => m.content).join('');
    const estimated = estimateTokens(combined);
    if (estimated > 0) {
      const providerId = providerSummary.split('/')[0] ?? 'unknown';
      addSessionTokens(estimated, providerId);
    }
    prevMessageCountRef.current = messages.length;
  }, [session?.messages, session?.id, providerSummary]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || isRunning) return;
    onSubmitPrompt(value, promptMentions);
    setPrompt('');
    setPromptMentions([]);
  };

  const handleOpenPlanFile = (filePath: string) => {
    if (onOpenPlanFile) {
      onOpenPlanFile(filePath);
      return;
    }
    window.dispatchEvent(new CustomEvent('code-space:open-plan-file', { detail: { filePath } }));
  };

  const handleBuildFromPlan = (filePath: string) => {
    if (onBuildFromPlan) {
      onBuildFromPlan(filePath);
      return;
    }
    onAgentModeChange('code');
    // Motivation vs Logic: hide the detailed build instructions from the user, but still inject them into the
    // agent payload so the implementation run respects the plan guidance.
    const planPrompt = buildPlanImplementationPrompt(filePath);
    const visiblePrompt = `Build from the approved plan at ${filePath}.`;
    onSubmitPrompt(visiblePrompt, [], {
      modeOverride: 'code',
      buildPlanPath: filePath,
      agentPrompt: planPrompt,
    });
  };

  return (
    <div className="flex h-full flex-col border-l border-[#30363d] bg-[#0d1117] text-xs font-mono text-[#e6edf3]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#30363d] px-3 py-2">
        <Bot size={14} className="text-[#58a6ff]" />
        <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">Agent</span>
        {activeProjectName ? (
          <span className="rounded-full border border-[#1f6feb66] bg-[#1f6feb22] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-[#79b8ff]">
            {activeProjectName}
          </span>
        ) : null}
        <span className="ml-auto truncate text-[10px] text-[#6e7681]">{providerSummary}</span>
        <button type="button" onClick={onOpenModelConfig} className="text-[10px] text-[#58a6ff] underline underline-offset-2 hover:text-[#79b8ff]">
          Model Configuration
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        <SessionListSection
          sessions={sessions}
          activeSessionId={session?.id ?? null}
          activeProjectName={activeProjectName}
          onSelectSession={onSelectSession}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
        />
        <PlanClarificationPanel questions={session?.clarifyingQuestions ?? []} disabled={isRunning} onSubmitAnswers={onSubmitPrompt} />
        <div className="rounded border border-[#30363d] bg-[#11182766] px-2 py-1.5 text-[10px] text-[#8b949e]">
          <div className="flex items-center justify-between gap-2">
            <span className="uppercase tracking-wider text-[#6e7681]">State</span>
            <span className="text-[#c9d1d9]">{modeContract(agentMode)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="uppercase tracking-wider text-[#6e7681]">Phase</span>
            <span className={session?.runtimeStatus === 'needs_review' ? 'text-[#f0883e]' : session?.runtimeStatus === 'verified' ? 'text-[#3fb950]' : 'text-[#58a6ff]'}>
              {formatPhaseLabel(session?.runtimePhase)}
            </span>
          </div>
        </div>
        {(session?.todos ?? []).length > 0 && (
          <CollapsibleSection title="Todos" defaultOpen={false} compact rightSlot={<span className="text-[9px] text-[#6d6d6d]">{session?.todos.filter((todo) => !todo.done).length ?? 0}</span>}>
            <div className="space-y-1 rounded border border-[#2a2a2a] bg-[#111111] p-2">
              {(session?.todos ?? []).map((todo) => (
                <div key={todo.id} className="flex items-start gap-2 text-[10px] text-[#c9d1d9]">
                  <span className={todo.done ? 'text-[#3fb950]' : 'text-[#8b949e]'}>{todo.done ? 'done' : 'todo'}</span>
                  <span className={todo.done ? 'text-[#6e7681] line-through' : ''}>{todo.text}</span>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-[#2a2a2a] bg-[#111111] p-2">
          {chatEntries.length === 0 ? (
            <p className="mt-6 text-center text-[#6e7681]">Describe a task to get started</p>
          ) : (
            <div className="space-y-2">
              {chatEntries.map(({ key, message }) => (
                <div key={key} className={`rounded border px-2 py-1.5 ${message.role === 'user' ? 'border-[#1f6feb55] bg-[#1f6feb1f] text-[#e6edf3]' : message.role === 'assistant' ? 'border-[#30363d] bg-[#161b22] text-[#e6edf3]' : message.role === 'reasoning' ? 'border-[#30363d33] bg-[#0d1117] text-[#6e7681] italic' : 'border-[#30363d] bg-[#151515] text-[#8b949e]'}`}>
                  <div className="mb-1 flex items-center gap-1 text-[9px] uppercase tracking-widest text-[#6e7681]">
                    {message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : message.role === 'reasoning' ? 'Thinking' : message.role}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-[11px] leading-5">{renderMessageText(message)}</div>
                </div>
              ))}
              <PlanLink
                filePath={session?.planMarkdown?.filePath}
                disabled={isRunning}
                buildStatus={visiblePlanBuildStatus}
                onView={handleOpenPlanFile}
                onRun={handleBuildFromPlan}
              />
              {isRunning && (
                <div className="flex items-center gap-2 text-[10px] text-[#8b949e]">
                  <Loader2 size={12} className="animate-spin" />
                  <span>{getWorkingLabel(agentMode)}</span>
                </div>
              )}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {visibleDiffs.length > 0 && (
          <CollapsibleSection title="Code changes" defaultOpen compact rightSlot={<span className="text-[9px] text-[#6d6d6d]">{visibleDiffs.length}</span>}>
            <div className="space-y-2 rounded border border-[#2a2a2a] bg-[#111111] p-2">
              {visibleDiffs.map((diff) => (
                <div key={diff.diffId} className="rounded border border-[#30363d] bg-[#0f1114]">
                  <div className="flex items-center gap-2 border-b border-[#1f1f1f] px-2 py-1">
                    <button
                      type="button"
                      onClick={() => onOpenDiffFile?.(diff.filePath)}
                      className="truncate text-[10px] text-[#58a6ff] underline-offset-2 hover:underline"
                      title={`Open ${diff.filePath}`}
                    >
                      {diff.filePath}
                    </button>
                    <span className={`ml-auto text-[9px] uppercase tracking-wider ${executionPolicyMeta.accentClassName}`}>
                      {diff.kind === 'applied' ? 'applied' : executionPolicy === 'auto' ? 'auto mode enabled' : 'confirm mode required'}
                    </span>
                  </div>
                  {diff.explanation && <p className="px-2 pt-2 text-[10px] leading-4 text-[#8b949e]">{diff.explanation}</p>}
                  <div className="max-h-72 overflow-auto border-t border-[#1b1f24] bg-[#0d1117] py-2 text-[9px] leading-4">
                    {renderDiff(diff.unifiedDiff ?? `${diff.oldContent}\n---\n${diff.newContent}`)}
                  </div>
                  <div className="flex justify-end gap-2 border-t border-[#1f1f1f] px-2 py-1.5">
                    {diff.kind === 'applied' || executionPolicy === 'auto' ? (
                      <span className={`text-[9px] uppercase tracking-wider ${executionPolicyMeta.accentClassName}`}>Applied</span>
                    ) : (
                      <>
                        <button type="button" onClick={() => onRejectDiff(diff.diffId)} className="rounded border border-[#30363d] px-2 py-1 text-[10px] text-[#f85149] hover:bg-[#2d1517]">Reject</button>
                        <button type="button" onClick={() => onAcceptDiff(diff.diffId)} className="rounded bg-[#238636] px-2 py-1 text-[10px] text-white hover:bg-[#2ea043]">Accept</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {visibleValidationResults.length > 0 && (
          <CollapsibleSection title="Validation" defaultOpen={false} compact rightSlot={<span className="text-[9px] text-[#6d6d6d]">{visibleValidationResults.length}</span>}>
            <div className="space-y-1 rounded border border-[#2a2a2a] bg-[#111111] p-2">
              {visibleValidationResults.map((result) => (
                <div key={result.id} className="rounded border border-[#1f1f1f] bg-[#0f1114] px-2 py-1">
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className={result.status === 'passed' ? 'text-[#3fb950]' : result.status === 'failed' ? 'text-[#f85149]' : 'text-[#f0883e]'}>{result.status}</span>
                    <span className="truncate text-[#c9d1d9]">{result.command}</span>
                  </div>
                  {result.output && <pre className="mt-1 max-h-24 overflow-auto text-[9px] leading-4 text-[#8b949e]">{result.output}</pre>}
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex-shrink-0 border-t border-[#30363d] p-2">
        <div className="flex items-end gap-2">
          <FileMentionInput value={prompt} mentions={promptMentions} onChange={(nextValue, nextMentions) => { setPrompt(nextValue); setPromptMentions(nextMentions); }} onSubmit={(nextValue, nextMentions) => { const trimmed = nextValue.trim(); if (!trimmed || isRunning) return; onSubmitPrompt(trimmed, nextMentions); setPrompt(''); setPromptMentions([]); }} mentionIndex={effectiveIndex} indexStatus={indexStatus} indexError={indexError} openFiles={openFiles} recentFiles={recentFiles} currentEditorFilePath={currentEditorFilePath} disabled={isRunning} placeholder="Describe a task..." />
          {isRunning ? <button type="button" onClick={onCancelRun} className="rounded bg-[#b91c1c] px-2 py-1 text-[10px] text-white">Stop</button> : <button type="submit" disabled={!prompt.trim()} className="rounded bg-[#1f6feb] px-2 py-1 text-[10px] text-white disabled:opacity-40"><Zap size={10} /></button>}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 px-0.5">
          <div className="flex items-center gap-3 text-[10px] whitespace-nowrap">
            <button type="button" onClick={onGenerateDiagram} disabled={!canGenerateDiagram || isRunning} title={canGenerateDiagram ? 'Open the current project in Multi Layer mode' : 'Open a project first'} className="text-[#58a6ff] underline underline-offset-2 hover:text-[#79b8ff] disabled:cursor-not-allowed disabled:text-[#6e7681] disabled:no-underline">Generate Diagram</button>
            <button type="button" onClick={onOpenAppPlanner} className="text-[#58a6ff] underline underline-offset-2 hover:text-[#79b8ff]">App Planner</button>
          </div>
          <TokenUsageSpinbar />
          <div className="flex items-center gap-2 whitespace-nowrap">
            <ExecutionPolicySelector policy={executionPolicy} disabled={isRunning} onChange={onExecutionPolicyChange} />
            <AgentModeSelector mode={agentMode} disabled={isRunning} onChange={onAgentModeChange} />
          </div>
        </div>
      </form>
    </div>
  );
}

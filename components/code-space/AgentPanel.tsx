'use client';

import React, { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Bot, Check, Copy, Edit3, ExternalLink, Layers3, Loader2, Settings, Share2, Sparkles, Zap } from 'lucide-react';
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
import { countDiffLines, type CodeSpacePendingDiff } from '@/components/code-space/diffHunks';
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';
import type { FileMentionIndex } from '@/lib/code-space/mentions/index';
import { buildMentionIndex } from '@/lib/code-space/mentions/index';
import type { MentionIndexStatus } from '@/lib/code-space/mentions/useMentionIndex';
import type { SelectedMention } from '@/lib/code-space/mentions/types';
import { MentionChip } from './mentions/MentionChip';

interface AgentPanelProps {
  session: CodeSpaceAgentSession | null;
  sessions: CodeSpaceAgentSession[];
  activeProjectName?: string;
  isRunning: boolean;
  toolBudget: number;
  pendingDiffs: CodeSpacePendingDiff[];
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
  onEditPrompt: (messageId: string) => void;
  onCancelRun: () => void;
  onAcceptDiff: (diffId: string) => void;
  onRejectDiff: (diffId: string) => void;
  onOpenDiffFile?: (filePath: string) => void;
  onOpenPlanFile?: (filePath: string) => void;
  onOpenKnowledgeGraph?: () => void;
  onBuildFromPlan?: (filePath: string) => void;
  draftPrompt?: string;
  draftPromptVersion?: number;
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

function flattenNodeText(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(flattenNodeText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return flattenNodeText((children as { props: { children?: React.ReactNode } }).props.children);
  }
  return '';
}

function mentionFromLink(children: React.ReactNode, href: string): SelectedMention | null {
  const label = flattenNodeText(children).trim();
  const normalizedHref = href.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalizedHref || normalizedHref.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/.test(normalizedHref) || normalizedHref.startsWith('//')) return null;
  if (!label) return null;
  const type = label.endsWith('/') || href.trim().endsWith('/') ? 'folder' : 'file';
  const basename = type === 'folder' ? label.replace(/\/+$/, '') : label;
  return {
    id: `mention:chat:${normalizedHref}`,
    type,
    basename: type === 'folder' ? basename.split('/').pop() ?? basename : basename,
    displayName: type === 'folder' ? (label.endsWith('/') ? label : `${label}/`) : label,
    relativePath: normalizedHref,
  };
}

function renderMessageLink(children: React.ReactNode, href = '') {
  const mention = mentionFromLink(children, href);
  if (mention) return <MentionChip mention={mention} />;

  const isExternal = /^[a-z][a-z0-9+.-]*:/.test(href) || href.startsWith('//');
  return (
    <a
      className="inline-flex items-center gap-1 text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
      href={href}
      rel={isExternal ? 'noreferrer' : undefined}
      target={isExternal ? '_blank' : undefined}
      title={flattenNodeText(children)}
    >
      {children}
      {isExternal && <ExternalLink size={12} className="opacity-70" />}
    </a>
  );
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
  const labels: Record<string, string> = {
    diff_review_emitted: 'Review emitted',
    awaiting_diff_confirmation: 'Awaiting validation confirmation',
    validating: 'Validating',
    repairing: 'Repairing',
    verified: 'Verified',
    needs_review: 'Needs review',
  };
  if (labels[phase]) return labels[phase];
  return phase.replace(/_/g, ' ');
}

function modeContract(mode: CodeSpaceAgentMode) {
  if (mode === 'ask') return 'Read-only answers from repository evidence';
  if (mode === 'plan') return 'Writes an executable plan artifact';
  return 'Reviewable patches with validation gates';
}

function truncateInlineText(value: string, maxLength = 72): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function basename(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath;
}

function formatLineRange(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const start = typeof record.startLine === 'number' ? Math.max(1, Math.floor(record.startLine)) : null;
  const end = typeof record.endLine === 'number' ? Math.max(1, Math.floor(record.endLine)) : null;
  if (start == null && end == null) return '';
  if (start != null && end != null && start !== end) return ` L${start}-${end}`;
  return ` L${start ?? end ?? 1}`;
}

function describeToolCall(name: string, input: unknown): { label: string; kind: 'file' | 'search' | 'task'; detail?: string } {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (name === 'read_file') {
      const path = typeof record.path === 'string' ? record.path : 'file';
      return { label: `Read ${basename(path)}${formatLineRange(input)}`, kind: 'file' };
    }
    if (name === 'search_text') {
      const query = typeof record.query === 'string' ? record.query : '';
      return { label: `Searched ${truncateInlineText(query, 48) || 'the repo'}`, kind: 'search' };
    }
    if (name === 'list_files') {
      const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.';
      return { label: `Listed ${path}`, kind: 'task' };
    }
    if (name === 'dependency_trace') {
      const paths = Array.isArray(record.paths) ? record.paths.filter((path): path is string => typeof path === 'string') : [];
      const firstPath = paths[0];
      return {
        label: firstPath ? `Traced dependencies for ${basename(firstPath)}` : 'Traced dependencies',
        kind: 'task',
      };
    }
    if (name === 'repo_map') {
      return { label: 'Mapped repository', kind: 'task' };
    }
    if (name === 'git_status') {
      return { label: 'Checked git status', kind: 'task' };
    }
    if (name === 'git_diff') {
      const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '';
      return { label: path ? `Read git diff for ${basename(path)}` : 'Read git diff', kind: 'task' };
    }
    if (name === 'read_artifact') {
      const artifactId = typeof record.artifactId === 'string' ? record.artifactId : '';
      return { label: artifactId ? `Read artifact ${artifactId}` : 'Read artifact', kind: 'task' };
    }
    if (name === 'grep_artifact') {
      const pattern = typeof record.pattern === 'string' ? record.pattern : '';
      return { label: pattern ? `Searched artifact for ${truncateInlineText(pattern, 40)}` : 'Searched artifact', kind: 'search' };
    }
    if (name === 'run_command') {
      const command = typeof record.command === 'string' ? record.command : '';
      const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === 'string') : [];
      return {
        label: command ? `Ran ${truncateInlineText([command, ...args].join(' '), 56)}` : 'Ran command',
        kind: 'task',
      };
    }
    if (name === 'edit_file') {
      const edits = Array.isArray(record.edits) ? record.edits.length : 0;
      return { label: edits > 0 ? `Prepared ${edits} edit${edits === 1 ? '' : 's'}` : 'Prepared edits', kind: 'task' };
    }
  }

  return { label: `${name.replace(/_/g, ' ')}`, kind: 'task' };
}

function buildToolActivity(session: CodeSpaceAgentSession | null): {
  summary: string;
  entries: Array<{ id: string; label: string; detail?: string; timestamp: number; kind: 'file' | 'search' | 'task' }>;
} {
  const toolCalls = session?.toolCalls ?? [];
  const readFiles = new Set<string>();
  let searchCount = 0;
  const entries = toolCalls
    .map((call) => {
      const description = describeToolCall(call.name, call.input);
      if (call.name === 'read_file' && call.input && typeof call.input === 'object') {
        const record = call.input as Record<string, unknown>;
        const path = typeof record.path === 'string' ? record.path.trim() : '';
        if (path) readFiles.add(path);
      }
      if (call.name === 'search_text') searchCount += 1;
      return {
        id: call.id,
        label: description.label,
        detail: call.status === 'error' ? call.error ?? call.summary : call.status === 'success' ? call.summary : undefined,
        timestamp: call.updatedAt ?? call.createdAt,
        kind: description.kind,
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  const filesLabel = `${readFiles.size} file${readFiles.size === 1 ? '' : 's'}`;
  const searchesLabel = `${searchCount} search${searchCount === 1 ? '' : 'es'}`;
  return {
    summary: `Explored ${filesLabel}, ${searchesLabel}`,
    entries,
  };
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
  onEditPrompt,
  onCancelRun,
  onAcceptDiff,
  onRejectDiff,
  onOpenDiffFile,
  onOpenPlanFile,
  onOpenKnowledgeGraph,
  onBuildFromPlan,
  draftPrompt,
  draftPromptVersion = 0,
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
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
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
  const toolActivity = useMemo(() => buildToolActivity(session), [session]);

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

  useEffect(() => {
    if (draftPrompt == null) return;
    setPrompt(draftPrompt);
    setPromptMentions([]);
  }, [draftPrompt, draftPromptVersion]);

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

  const handleCopyPrompt = async (message: CodeSpaceMessage) => {
    const text = renderMessageText(message);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => (current === message.id ? null : current)), 1400);
    } catch {
      setCopiedMessageId(null);
    }
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
        {session?.knowledgeGraph ? (
          <button
            type="button"
            onClick={onOpenKnowledgeGraph}
            title={`${session.knowledgeGraph.nodeCount} files · ${session.knowledgeGraph.edgeCount} import edges`}
            className="inline-flex items-center gap-1 rounded-full border border-[#2ea04366] bg-[#2ea04322] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[#56d364] hover:bg-[#2ea04333]"
          >
            <Share2 size={10} />
            Knowledge graph
          </button>
        ) : null}
        <span className="ml-auto truncate text-[10px] text-[#6e7681]">{providerSummary}</span>
        <button
          type="button"
          onClick={onOpenModelConfig}
          className="rounded p-1 text-[#8b949e] hover:bg-[#161b22] hover:text-[#79b8ff]"
          title="Model Configuration"
          aria-label="Model Configuration"
        >
          <Settings size={14} />
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
        {toolActivity.entries.length > 0 ? (
          <CollapsibleSection
            title={toolActivity.summary}
            defaultOpen={false}
            compact
            rightSlot={<span className="text-[9px] text-[#6d6d6d]">{toolActivity.entries.length}</span>}
          >
            <div className="space-y-1 rounded border border-[#2a2a2a] bg-[#111111] p-1.5">
              {toolActivity.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 rounded px-1.5 py-1 text-[11px] leading-5 text-[#c9d1d9] hover:bg-[#161b22]"
                >
                  <span
                    className={`mt-0.5 inline-flex h-2 w-2 shrink-0 rounded-full ${
                      entry.kind === 'file' ? 'bg-[#58a6ff]' : entry.kind === 'search' ? 'bg-[#f0883e]' : 'bg-[#8b949e]'
                    }`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{entry.label}</div>
                    {entry.detail ? <div className="mt-0.5 truncate text-[10px] text-[#6e7681]">{entry.detail}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        ) : null}
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
                  <MarkdownRenderer
                    markdown={renderMessageText(message)}
                    className="text-inherit"
                    contentClassName="text-[11px] leading-5"
                    componentsOverride={{ a: ({ children, href = '' }) => renderMessageLink(children, href) }}
                  />
                  {message.role === 'user' ? (
                    <div className="mt-1.5 flex items-center gap-1 border-t border-[#1f6feb33] pt-1">
                      <button
                        type="button"
                        onClick={() => void handleCopyPrompt(message)}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[#8b949e] hover:bg-[#1f6feb22] hover:text-[#c9d1d9]"
                        title="Copy prompt"
                        aria-label="Copy prompt"
                      >
                        {copiedMessageId === message.id ? <Check size={11} /> : <Copy size={11} />}
                        {copiedMessageId === message.id ? 'Copied' : 'Copy'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onEditPrompt(message.id)}
                        disabled={isRunning}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[#8b949e] hover:bg-[#1f6feb22] hover:text-[#c9d1d9] disabled:cursor-not-allowed disabled:opacity-40"
                        title="Edit prompt and rewind context"
                        aria-label="Edit prompt and rewind context"
                      >
                        <Edit3 size={11} />
                        Edit
                      </button>
                    </div>
                  ) : null}
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
              {visibleDiffs.map((diff) => {
                const lineCounts = countDiffLines(diff.unifiedDiff, 'hunks' in diff ? diff.hunks : undefined);
                const hunkCount = 'hunks' in diff && diff.hunks?.length ? diff.hunks.length : 1;
                return (
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
                    {diff.kind === 'pending' ? (
                      <>
                        <span className="rounded border border-[#30363d] px-1.5 py-0.5 text-[9px]">
                          <span className="text-[#3fb950]">+{lineCounts.added}</span>{' '}
                          <span className="text-[#f85149]">-{lineCounts.removed}</span>
                        </span>
                        <span className="rounded border border-[#30363d] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[#8b949e]">
                          {hunkCount} patch{hunkCount === 1 ? '' : 'es'}
                        </span>
                      </>
                    ) : null}
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
                );
              })}
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
            <button
              type="button"
              onClick={onGenerateDiagram}
              disabled={!canGenerateDiagram || isRunning}
              title="Generate Diagram"
              aria-label="Generate Diagram"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[#58a6ff] hover:bg-[#161b22] hover:text-[#79b8ff] disabled:cursor-not-allowed disabled:text-[#6e7681] disabled:hover:bg-transparent"
            >
              <Layers3 size={15} />
            </button>
            <button
              type="button"
              onClick={onOpenAppPlanner}
              title="App Planner"
              aria-label="App Planner"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[#58a6ff] hover:bg-[#161b22] hover:text-[#79b8ff]"
            >
              <Sparkles size={15} />
            </button>
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

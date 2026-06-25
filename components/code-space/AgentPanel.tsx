'use client';

import React, { useEffect, useMemo, useRef, useState, type FormEvent, type SetStateAction } from 'react';
import { Bot, Check, ChevronRight, Copy, Edit3, ExternalLink, FileCode2, Layers3, Loader2, Mic, Paperclip, Settings, Share2, Sparkles, Zap } from 'lucide-react';
import { addSessionTokens, estimateTokens } from '@/lib/code-space/tokenUsage';
import { TokenUsageSpinbar } from './TokenUsageSpinbar';
import type { CodeSpaceAgentSession, CodeSpaceMessage } from '@/lib/code-space/core';
import type { CodeSpaceAgentMode } from '@/lib/code-space/agentModes';
import { getCodeSpaceExecutionPolicyMeta, type CodeSpaceExecutionPolicy } from '@/lib/code-space/executionPolicy';
import { buildPlanImplementationPrompt, type CodeSpacePromptOptions } from '@/lib/code-space/planBuild';
import { AgentModeSelector } from './AgentModeSelector';
import { ExecutionPolicySelector } from './ExecutionPolicySelector';
import { ScaleProfileSelector } from './ScaleProfileSelector';
import { MissionBoard } from './MissionBoard';
import { SessionListSection } from './SessionListSection';
import { FileMentionInput } from './FileMentionInput';
import { PlanClarificationPanel } from './PlanClarificationPanel';
import { PlanLink } from './PlanLink';
import type { CodeSpacePendingDiff } from '@/components/code-space/diffHunks';
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';
import type { FileMentionIndex } from '@/lib/code-space/mentions/index';
import { buildMentionIndex } from '@/lib/code-space/mentions/index';
import type { MentionIndexStatus } from '@/lib/code-space/mentions/useMentionIndex';
import type { SelectedMention } from '@/lib/code-space/mentions/types';
import { MentionChip } from './mentions/MentionChip';
import { buildAgentTimeline, type AgentTimelineItem } from './agentTimeline';
import { sanitizeAgentDisplayText } from '@/lib/code-space/agent/displaySanitizer';

export type RuntimeScaleProfile = 'standard' | 'deep' | 'massive' | 'full_access_local';

interface AgentPanelProps {
  session: CodeSpaceAgentSession | null;
  sessions: CodeSpaceAgentSession[];
  projectKnowledgeGraph?: CodeSpaceAgentSession['knowledgeGraph'] | null;
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
  scaleProfile?: RuntimeScaleProfile;
  onOpenModelConfig: () => void;
  onGenerateDiagram: () => void;
  onOpenAppPlanner: () => void;
  onAgentModeChange: (mode: CodeSpaceAgentMode) => void;
  onExecutionPolicyChange: (policy: CodeSpaceExecutionPolicy) => void;
  onScaleProfileChange?: (profile: RuntimeScaleProfile) => void;
  canGenerateDiagram: boolean;
  onSelectSession: (sessionId: string | null) => void;
  onRenameSession: (session: CodeSpaceAgentSession) => void;
  onDeleteSession: (session: CodeSpaceAgentSession) => void;
  onSubmitPrompt: (prompt: string, attachments?: SelectedMention[], options?: CodeSpacePromptOptions) => void;
  onClarifyingAnswersChange?: React.Dispatch<SetStateAction<Record<string, string[]>>>;
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
  const sanitized = sanitizeAgentDisplayText(content);

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

  if (!looksLikeInternalWorkflow) return sanitized || content;

  const appliedIndex = content.indexOf('Applied changes:');
  if (appliedIndex >= 0) return sanitizeAgentDisplayText(content.slice(appliedIndex).trim()) || content.slice(appliedIndex).trim();

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
      className="inline-flex min-w-0 items-center gap-1 break-all text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
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

const COMPACT_MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mb-2 mt-1 text-[15px] font-semibold leading-6 text-inherit">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mb-1 mt-1.5 text-[14px] font-semibold leading-6 text-inherit">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mb-0.5 mt-1.5 text-[13px] font-semibold leading-5 text-inherit">{children}</h3>
  ),
  h4: ({ children }: { children?: React.ReactNode }) => (
    <h4 className="mb-0.5 mt-1 text-[12px] font-medium leading-5 text-inherit">{children}</h4>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-0 break-words leading-5 text-inherit">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-0.5 list-disc space-y-0 pl-4 text-inherit">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-0.5 list-decimal space-y-0 pl-4 text-inherit">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li className="pl-1 leading-5 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&>p]:my-0">{children}</li>,
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="my-2 max-h-40 max-w-full overflow-auto rounded-md border border-[#30363d] bg-[#0b1017] p-2 font-mono text-[11px] leading-5 text-[#c9d1d9]">
      {children}
    </pre>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="break-all rounded border border-[#30363d] bg-[#0b1017] px-1 py-0.5 font-mono text-[0.92em] text-[#9ecbff]">
      {children}
    </code>
  ),
};

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

function mentionForPath(filePath: string): SelectedMention {
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const basename = normalizedPath.split('/').filter(Boolean).pop() ?? normalizedPath;
  return {
    id: `mention:exploration:${normalizedPath}`,
    type: normalizedPath.endsWith('/') ? 'folder' : 'file',
    basename,
    displayName: normalizedPath,
    relativePath: normalizedPath,
  };
}

function ExplorationSummary({
  item,
  onOpenFile,
}: {
  item: Extract<AgentTimelineItem, { kind: 'exploration_summary' }>;
  onOpenFile?: (filePath: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-w-0 max-w-full font-sans text-[12px] font-medium leading-5 text-[#8e8e93]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-[#161b22] hover:text-[#d6d6d6]"
      >
        <span aria-hidden="true" className="text-[11px] leading-none">{open ? 'Δ' : '∇'}</span>
        <span className="truncate">{item.text}</span>
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1.5 rounded-lg border border-[#242424] bg-[#101419] px-2.5 py-2 text-[11px] font-normal leading-5 text-[#8e8e93]">
          {item.filePaths.length ? (
            <div className="space-y-1">
              <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#6e7681]">Files</div>
              <div className="flex flex-wrap gap-1">
                {item.filePaths.map((filePath) => {
                  const mention = mentionForPath(filePath);
                  if (!onOpenFile) return <MentionChip key={filePath} mention={mention} />;
                  return (
                    <button
                      key={filePath}
                      type="button"
                      onClick={() => onOpenFile(filePath)}
                      className="min-w-0 rounded hover:ring-1 hover:ring-[#30363d]"
                      title={`Open ${filePath}`}
                    >
                      <MentionChip mention={mention} />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {item.searches.length ? (
            <div className="space-y-1">
              <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#6e7681]">Searches</div>
              <div className="space-y-1">
                {item.searches.map((search, index) => (
                  <div key={`${index}:${search.query}`} className="min-w-0 break-words rounded border border-[#242424] bg-[#0b1017] px-2 py-1 font-mono text-[10.5px] leading-4 text-[#9ecbff]">
                    {search.query}
                    {search.glob ? <span className="text-[#6e7681]"> · {search.glob}</span> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AgentPanel({
  session,
  sessions,
  projectKnowledgeGraph,
  activeProjectName,
  isRunning,
  pendingDiffs,
  appliedDiffs,
  providerSummary,
  agentMode,
  executionPolicy,
  scaleProfile = 'deep',
  onOpenModelConfig,
  onGenerateDiagram,
  onOpenAppPlanner,
  onAgentModeChange,
  onExecutionPolicyChange,
  onScaleProfileChange = () => undefined,
  canGenerateDiagram,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onSubmitPrompt,
  onClarifyingAnswersChange,
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

  const visiblePlanBuildStatus = session?.planMarkdown?.buildStatus ?? 'available';
  const hasClarifyingQuestions = (session?.clarifyingQuestions?.length ?? 0) > 0;
  const visibleKnowledgeGraph = projectKnowledgeGraph ?? session?.knowledgeGraph ?? null;
  const agentTimeline = useMemo(
    () => buildAgentTimeline({ session, pendingDiffs, appliedDiffs }),
    [appliedDiffs, pendingDiffs, session],
  );

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agentTimeline.length, isRunning, session?.planMarkdown?.filePath]);

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

  const renderTimelineItem = (item: AgentTimelineItem) => {
    if (item.kind === 'user_prompt') {
      const syntheticMessage: CodeSpaceMessage = {
        id: item.messageId,
        role: 'user',
        content: item.content,
        createdAt: item.createdAt,
      };
      return (
        <div key={item.id} className="group">
          <div className="relative max-h-36 min-w-0 max-w-full overflow-hidden break-words rounded-2xl border border-[#343434] bg-[#1b1b1d] px-3 py-2.5 font-sans text-[13px] font-normal leading-5 text-[#dedede] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <MarkdownRenderer
              markdown={item.content}
              className="text-inherit"
              contentClassName="text-[13px] leading-5"
              componentsOverride={{ ...COMPACT_MARKDOWN_COMPONENTS, a: ({ children, href = '' }) => renderMessageLink(children, href) }}
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[#1b1b1d] to-transparent" />
          </div>
          <div className="mt-1.5 flex items-center gap-1 px-1 opacity-70 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={() => void handleCopyPrompt(syntheticMessage)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[#8b949e] hover:bg-[#242424] hover:text-[#d6d6d6]"
              title="Copy prompt"
              aria-label="Copy prompt"
            >
              {copiedMessageId === item.messageId ? <Check size={11} /> : <Copy size={11} />}
              {copiedMessageId === item.messageId ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() => onEditPrompt(item.messageId)}
              disabled={isRunning}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[#8b949e] hover:bg-[#242424] hover:text-[#d6d6d6] disabled:cursor-not-allowed disabled:opacity-40"
              title="Edit prompt and rewind context"
              aria-label="Edit prompt and rewind context"
            >
              <Edit3 size={11} />
              Edit
            </button>
          </div>
        </div>
      );
    }

    if (item.kind === 'assistant_text') {
      return (
        <MarkdownRenderer
          key={item.id}
          markdown={item.content}
          className="min-w-0 max-w-full overflow-hidden text-[#d6d6d6]"
          contentClassName="break-words font-sans text-[13px] font-normal leading-5 [&>*+*]:mt-1.5 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          componentsOverride={{ ...COMPACT_MARKDOWN_COMPONENTS, a: ({ children, href = '' }) => renderMessageLink(children, href) }}
        />
      );
    }

    if (item.kind === 'exploration_summary') {
      return <ExplorationSummary key={item.id} item={item} onOpenFile={onOpenDiffFile} />;
    }

    if (item.kind === 'status_summary') {
      const tone =
        item.status === 'error'
          ? 'text-[#f85149]'
          : item.status === 'warning'
            ? 'text-[#c9a46a]'
            : item.status === 'success'
              ? 'text-[#56d364]'
              : 'text-[#8e8e93]';
      return (
        <div key={item.id} className={`min-w-0 max-w-full break-words font-sans text-[12px] font-medium leading-5 ${tone}`}>
          {item.text}
        </div>
      );
    }

    if (item.kind === 'patch_card') {
      const isPending = item.status === 'pending';
      const isRemovalHeavy = item.removed > item.added;
      return (
        <div key={item.id} className="overflow-hidden rounded-[20px] border border-[#303030] bg-[#141414] shadow-[0_12px_36px_rgba(0,0,0,0.18)]">
          <div className="flex items-center gap-2 border-b border-[#282828] px-4 py-3">
            <FileCode2 size={15} className="shrink-0 text-[#7dd3fc]" />
            <button
              type="button"
              onClick={() => onOpenDiffFile?.(item.filePath)}
              className="min-w-0 truncate text-left font-sans text-[12px] font-medium leading-5 text-[#bfbfbf] hover:text-[#e6e6e6]"
              title={`Open ${item.filePath}`}
            >
              {item.title}
            </button>
            <div className="ml-auto flex shrink-0 items-center gap-1.5 font-sans text-[12px] font-medium">
              {item.added > 0 ? <span className="text-[#2fbf71]">+{item.added}</span> : null}
              {item.removed > 0 ? <span className="text-[#ff5c8a]">-{item.removed}</span> : null}
            </div>
          </div>
          {item.explanation ? <div className="px-4 py-2 text-[12px] leading-5 text-[#8e8e93]">{item.explanation}</div> : null}
          <div className={`max-h-36 overflow-hidden border-l-4 ${isRemovalHeavy ? 'border-[#b7425a]' : 'border-[#2f9f61]'} bg-[#101010] py-2 font-mono text-[11px] leading-5`}>
            {renderDiff(item.diff)}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-[#282828] px-4 py-2 text-[10px] uppercase tracking-[0.16em] text-[#777]">
            <span>
              {item.hunks} hunk{item.hunks === 1 ? '' : 's'} · {item.status}
            </span>
            {isPending && executionPolicy !== 'auto' ? (
              <span className="flex items-center gap-2">
                <button type="button" onClick={() => onRejectDiff(item.diffId)} className="rounded border border-[#3a2a2f] px-2 py-1 text-[#ff7b8a] hover:bg-[#2d1517]">
                  Reject
                </button>
                <button type="button" onClick={() => onAcceptDiff(item.diffId)} className="rounded bg-[#238636] px-2 py-1 text-white hover:bg-[#2ea043]">
                  Accept
                </button>
              </span>
            ) : (
              <span className={executionPolicyMeta.accentClassName}>{item.status === 'applied' ? 'Applied' : executionPolicyMeta.label}</span>
            )}
          </div>
        </div>
      );
    }

    if (item.kind === 'file_group') {
      return (
        <button
          key={item.id}
          type="button"
          onClick={() => item.files[0] && onOpenDiffFile?.(item.files[0])}
          className="inline-flex items-center gap-2 rounded-lg px-1 font-sans text-[12px] font-medium leading-5 text-[#8e8e93] hover:text-[#d6d6d6]"
          title={item.files.join('\n')}
        >
          <ChevronRight size={18} />
          {item.count} Files
        </button>
      );
    }

    if (item.kind === 'review_gate') {
      return (
        <div key={item.id} className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => pendingDiffs[0] && onOpenDiffFile?.(pendingDiffs[0].filePath)}
            className="rounded-lg bg-[#7a7a7a] px-3 py-1.5 font-sans text-[12px] font-medium leading-5 text-white hover:bg-[#8b8b8b]"
          >
            Review
          </button>
        </div>
      );
    }

    if (item.kind === 'validation_summary') {
      const tone = item.status === 'passed' ? 'text-[#56d364]' : item.status === 'failed' ? 'text-[#ff7b8a]' : 'text-[#c9a46a]';
      return (
        <div key={item.id} className="min-w-0 max-w-full overflow-hidden rounded-lg border border-[#303030] bg-[#131313] px-3 py-2">
        <div className={`break-words text-[12px] font-medium leading-3 ${tone}`}>
            {item.status} · {item.command}
          </div>
          {item.output ? <pre className="mt-1 max-h-28 max-w-full overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[#8e8e93]">{item.output}</pre> : null}
        </div>
      );
    }

    return (
      <div key={item.id} className="min-w-0 max-w-full overflow-hidden break-words rounded-lg border border-[#4a242a] bg-[#1f1114] px-3 py-2 text-[13px] leading-5 text-[#ff9aa8]">
        {item.text}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col border-l border-[#30363d] bg-[#0d1117] font-sans text-xs text-[#e6edf3]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#30363d] px-3 py-2">
        <Bot size={14} className="text-[#58a6ff]" />
        <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">Agent</span>
        {activeProjectName ? (
          <span className="rounded-full border border-[#1f6feb66] bg-[#1f6feb22] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-[#79b8ff]">
            {activeProjectName}
          </span>
        ) : null}
        {visibleKnowledgeGraph ? (
          <button
            type="button"
            onClick={onOpenKnowledgeGraph}
            title={`${visibleKnowledgeGraph.nodeCount} files · ${visibleKnowledgeGraph.edgeCount} import edges`}
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

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className={`flex flex-col gap-2 border-b border-[#242424] px-2 py-2 ${
            hasClarifyingQuestions ? 'min-h-0 flex-[3] overflow-hidden' : 'shrink-0'
          }`}
        >
        <div className="shrink-0">
        <SessionListSection
          sessions={sessions}
          activeSessionId={session?.id ?? null}
          activeProjectName={activeProjectName}
          onSelectSession={onSelectSession}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
        />
        </div>
        <div className={hasClarifyingQuestions ? 'min-h-0 flex-1' : undefined}>
        <PlanClarificationPanel
          questions={session?.clarifyingQuestions ?? []}
          answers={session?.clarifyingQuestionAnswers ?? {}}
          onAnswersChange={onClarifyingAnswersChange}
          disabled={isRunning}
          onSubmitAnswers={onSubmitPrompt}
        />
        </div>
          <div className="flex shrink-0 items-center justify-between gap-3 px-1 text-[9px] uppercase tracking-[0.18em] text-[#6e7681]">
            <span className="truncate">{modeContract(agentMode)}</span>
            <span
              className={
                session?.runtimeStatus === 'needs_review'
                  ? 'shrink-0 text-[#f0883e]'
                  : session?.runtimeStatus === 'verified'
                    ? 'shrink-0 text-[#3fb950]'
                    : 'shrink-0 text-[#58a6ff]'
              }
            >
              {formatPhaseLabel(session?.runtimePhase)}
            </span>
          </div>
        </div>

        <div
          className={`min-h-0 overflow-y-auto px-4 py-5 ${
            hasClarifyingQuestions ? 'flex-1 shrink' : 'flex-1'
          }`}
        >
          <MissionBoard runFeed={session?.runFeed} />
          {agentTimeline.length === 0 ? (
            <p className="mt-6 text-center text-[13px] text-[#6e7681]">Describe a task to get started</p>
          ) : (
            <div className="min-w-0 space-y-3">
              {agentTimeline.map(renderTimelineItem)}
              <PlanLink
                filePath={session?.planMarkdown?.filePath}
                disabled={isRunning}
                buildStatus={visiblePlanBuildStatus}
                onView={handleOpenPlanFile}
                onRun={handleBuildFromPlan}
              />
              {isRunning && (
                <div className="flex items-center gap-2 font-sans text-[12px] font-medium leading-5 text-[#8e8e93]">
                  <Loader2 size={18} className="animate-spin" />
                  <span>{getWorkingLabel(agentMode)}</span>
                </div>
              )}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex-shrink-0 border-t border-[#242424] bg-[#0d1117] p-2">
        <div className="rounded-xl border border-[#30363d] bg-[#161b22] px-3 py-2 shadow-[0_-8px_24px_rgba(0,0,0,0.12)]">
          <FileMentionInput value={prompt} mentions={promptMentions} onChange={(nextValue, nextMentions) => { setPrompt(nextValue); setPromptMentions(nextMentions); }} onSubmit={(nextValue, nextMentions) => { const trimmed = nextValue.trim(); if (!trimmed || isRunning) return; onSubmitPrompt(trimmed, nextMentions); setPrompt(''); setPromptMentions([]); }} mentionIndex={effectiveIndex} indexStatus={indexStatus} indexError={indexError} openFiles={openFiles} recentFiles={recentFiles} currentEditorFilePath={currentEditorFilePath} disabled={isRunning} placeholder="Plan, Build, / for skills, @ for context" />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1">
            <div className="flex shrink-0 items-center gap-1">
              <ExecutionPolicySelector policy={executionPolicy} disabled={isRunning} onChange={onExecutionPolicyChange} />
              <AgentModeSelector mode={agentMode} disabled={isRunning} onChange={onAgentModeChange} />
              <ScaleProfileSelector profile={scaleProfile} disabled={isRunning} onChange={onScaleProfileChange} />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <TokenUsageSpinbar />
            <button
              type="button"
              onClick={onGenerateDiagram}
              disabled={!canGenerateDiagram || isRunning}
              title="Generate Diagram"
              aria-label="Generate Diagram"
              className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[#58a6ff] hover:bg-[#21262d] hover:text-[#79b8ff] disabled:cursor-not-allowed disabled:text-[#484f58] disabled:hover:bg-transparent"
            >
              <Layers3 size={11} />
            </button>
            <button
              type="button"
              onClick={onOpenAppPlanner}
              title="App Planner"
              aria-label="App Planner"
              className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[#58a6ff] hover:bg-[#21262d] hover:text-[#79b8ff]"
            >
              <Sparkles size={11} />
            </button>
              <button
                type="button"
                title="Attach context"
                aria-label="Attach context"
                className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]"
              >
                <Paperclip size={11} />
              </button>
              <button
                type="button"
                title="Voice input"
                aria-label="Voice input"
                className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]"
              >
                <Mic size={11} />
              </button>
              {isRunning ? (
                <button type="button" onClick={onCancelRun} className="ml-0.5 rounded-full bg-[#b91c1c] px-1.5 py-1 font-sans text-[8.5px] font-medium leading-none text-white">
                  Stop
                </button>
              ) : (
                <button type="submit" disabled={!prompt.trim()} className="ml-0.5 inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[#238636] text-white hover:bg-[#2ea043] disabled:opacity-40" aria-label="Submit prompt">
                  <Zap size={10} />
                </button>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

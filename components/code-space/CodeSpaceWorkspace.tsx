'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import {
  Archive,
  Bot,
  Box,
  ChevronDown,
  ChevronRight,
  Code2,
  File,
  FileCode2,
  ChevronLeft,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  Layers3,
  PanelLeft,
  PanelRight,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { useDiagramStore } from '@/lib/state/store';
import { writeUiPreference } from '@/lib/state/uiPreferences';
import { configureMonacoForCodeFiles } from '@/components/editor/monacoDefaults';
import {
    createCodeSpaceProject,
  dedupeCodeSpaceProjects,
  detectCodeSpaceLanguage,
  getCodeSpaceProjectDedupKey,
  isCodeSpaceHiddenPath,
  type CodeSpaceAgentSession,
  type CodeSpaceBottomTab,
  type CodeSpaceEditorTab,
  type CodeSpaceMessage,
  type CodeSpaceProject,
  type CodeSpaceTreeNode,
} from '@/lib/code-space/core';
import {
  DEFAULT_CODE_SPACE_AGENT_MODE,
  normalizeCodeSpaceAgentMode,
  type CodeSpaceAgentMode,
} from '@/lib/code-space/agentModes';
import {
  DEFAULT_CODE_SPACE_EXECUTION_POLICY,
  shouldAutoApplyCodeSpaceDiffs,
  type CodeSpaceExecutionPolicy,
} from '@/lib/code-space/executionPolicy';
import { BottomPanel } from '@/components/code-space/BottomPanel';
import { CodeSpaceMarkdownPreview } from '@/components/code-space/CodeSpaceMarkdownPreview';
import { CodeSpaceTabActions } from '@/components/code-space/CodeSpaceTabActions';
import {
    deleteCodeSpaceProject,
    deleteCodeSpaceSession,
    deleteCodeSpaceTab,
  readCodeSpacePreferences,
  readCodeSpaceProjects,
  readCodeSpaceSessions,
  readCodeSpaceTabs,
  saveCodeSpaceProject,
  saveCodeSpaceSession,
  saveCodeSpaceTab,
  writeCodeSpacePreferences,
} from '@/lib/code-space/persistence';
import { registerDslLanguage } from '@/components/editor/dslLanguage';
import { ProviderConfig } from '@/components/agent/ProviderConfig';
import { AgentPanel } from '@/components/code-space/AgentPanel';
import { CodeSpaceWorkspaceEnhancements } from '@/components/code-space/CodeSpaceWorkspaceEnhancements';
import { InlinePatchReview } from '@/components/code-space/InlinePatchReview';
import {
  acceptedHunkIdSet,
  applyAcceptedDiffHunks,
  countDiffLines,
  everyHunkResolved,
  hasAcceptedHunks,
  resolvedContentForHunk,
  splitUnifiedDiffIntoHunks,
  type CodeSpacePendingDiff,
} from '@/components/code-space/diffHunks';
import { SessionRenameDialog } from '@/components/shared/SessionRenameDialog';
import { useAppDialogs } from '@/components/shared/useAppDialogs';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import { nameSessionAsync } from '@/lib/code-space/sessionNaming';
import { useMentionIndex } from '@/lib/code-space/mentions/useMentionIndex';
import type { SelectedMention } from '@/lib/code-space/mentions/types';
import { appendInstructionToPrompt, extractBuildPlanPath, type CodeSpacePromptOptions } from '@/lib/code-space/planBuild';

interface FilePayload {
  path: string;
  content: string;
  hash: string;
  modifiedAt: number;
}

interface FolderBrowserEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

interface FolderBrowserResponse {
  root?: string;
  parent?: string;
  resolved?: string;
  entries?: FolderBrowserEntry[];
  directories?: Array<{ name: string; path: string }>;
  error?: string;
}

interface TreeResponse {
  entries: CodeSpaceTreeNode[];
}

const DEFAULT_SESSION_EXAMPLES = [
  'Explain this repo',
  'Run checks',
  'Fix the failing build',
  'Add a feature',
  'Refactor selected code',
];

function nowId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function buildPendingDiffFromEvent(event: {
  diffId: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  deleted?: boolean;
  explanation?: string;
  unifiedDiff?: string;
}): CodeSpacePendingDiff {
  return {
    diffId: event.diffId,
    filePath: event.filePath,
    oldContent: event.oldContent,
    newContent: event.newContent,
    deleted: event.deleted,
    explanation: event.explanation,
    unifiedDiff: event.unifiedDiff,
    hunks: splitUnifiedDiffIntoHunks(event.unifiedDiff, event.oldContent, event.newContent),
    hunkStatus: {},
  };
}

function extractChangedLineNumbers(unifiedDiff?: string): number[] {
  if (!unifiedDiff) return [];
  const lines = unifiedDiff.split('\n');
  const changed = new Set<number>();
  let newLine = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/\+([0-9]+)(?:,([0-9]+))?/);
      if (!match) continue;
      newLine = Number.parseInt(match[1] ?? '1', 10);
      continue;
    }
    if (!newLine) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      changed.add(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    }
    newLine += 1;
  }
  return Array.from(changed.values()).sort((a, b) => a - b);
}

function getApiKey(providerId: string): string {
  try {
    const stored = localStorage.getItem(`provider_config_${providerId}`);
    if (stored) return (JSON.parse(stored) as { apiKey?: string }).apiKey ?? '';
  } catch {
    // Ignore storage parse errors and fall back to empty string.
  }
  return '';
}

function projectNameFromPath(rootPath: string): string {
  return rootPath.replace(/\/+$/, '').split('/').pop() || rootPath;
}

function dirname(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function basename(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function normalizeToPosix(filePath: string) {
  return filePath.replace(/\\/g, '/');
}

function parentPath(filePath: string) {
  const normalized = normalizeToPosix(filePath).replace(/\/+$/, '');
  const hasLeadingSlash = normalized.startsWith('/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length) {
    return hasLeadingSlash ? '/' : '';
  }
  segments.pop();
  if (!segments.length) {
    return hasLeadingSlash ? '/' : '';
  }
  const joined = segments.join('/');
  return hasLeadingSlash ? `/${joined}` : joined;
}

function joinPathSegments(parent: string, child: string) {
  const normalizedParent = normalizeToPosix(parent).replace(/\/+$/, '');
  const normalizedChild = normalizeToPosix(child).replace(/^\/+/, '');
  if (!normalizedParent || normalizedParent === '.') {
    return normalizedChild;
  }
  if (normalizedParent === '/') {
    return `/${normalizedChild}`;
  }
  return `${normalizedParent}/${normalizedChild}`;
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const existingIds = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of incoming) {
    if (!existingIds.has(item.id)) {
      merged.push(item);
      existingIds.add(item.id);
    }
  }
  return merged;
}

function createSession(projectId: string | null, title = 'New coding session', mode: CodeSpaceAgentSession['mode'] = DEFAULT_CODE_SPACE_AGENT_MODE): CodeSpaceAgentSession {
  const ts = Date.now();
  return {
    id: nowId('session'),
    projectId,
    title,
    status: 'idle',
    mode: mode === 'fresh-start' ? 'fresh-start' : normalizeCodeSpaceAgentMode(mode),
    messages: [],
    toolCalls: [],
    plan: [],
    clarifyingQuestions: [],
    todos: [],
    changesets: [],
    verificationResults: [],
    createdAt: ts,
    updatedAt: ts,
    archived: false,
    localCacheVersion: 1,
    toolBudget: 50,
    toolCallCount: 0,
    filesChanged: [],
    agentChangesets: [],
  };
}

function fileIcon(path: string) {
  const language = detectCodeSpaceLanguage(path);
  if (language === 'typescript' || language === 'javascript') return <FileCode2 size={14} className="text-blue-300" />;
  if (language === 'css' || language === 'scss') return <FileCode2 size={14} className="text-pink-300" />;
  if (language === 'markdown') return <FileCode2 size={14} className="text-sky-300" />;
  if (language === 'json') return <FileCode2 size={14} className="text-yellow-300" />;
  return <File size={14} className="text-ink-400" />;
}

export function CodeSpaceWorkspace() {
  const setMode = useDiagramStore((s) => s.setMode);
  const theme = useDiagramStore((s) => s.theme);
  const provider = useDiagramStore((s) => s.provider);
  // Motivation vs Logic: replaces every `window.prompt`/`window.confirm` flow in this workspace
  // with portal-mounted modals so renames, deletes, and clones share consistent in-app chrome
  // instead of leaking the page origin in the native browser dialog.
  const { prompt: openPromptDialog, confirm: openConfirmDialog, dialogs: appDialogs } = useAppDialogs();
  const [projects, setProjects] = useState<CodeSpaceProject[]>([]);
  const [sessions, setSessions] = useState<CodeSpaceAgentSession[]>([]);
  const [tabs, setTabs] = useState<CodeSpaceEditorTab[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState<CodeSpaceAgentMode>(DEFAULT_CODE_SPACE_AGENT_MODE);
  const [fileContents, setFileContents] = useState<Record<string, FilePayload>>({});
  const [treeChildren, setTreeChildren] = useState<Record<string, CodeSpaceTreeNode[]>>({});

  // Motivation vs Logic: The @ mention picker needs every project file/folder available, not
  // just the ones the user has expanded in the explorer. We keep flatFilePaths as a seed (so the
  // picker has *something* before the server scan returns) and let useMentionIndex hydrate the
  // full project listing from /api/code-space/mention-index. The hook caches per-rootPath and
  // debounces refreshes.
  const flatFilePaths = useMemo(() => {
    const paths: string[] = [];
    function collect(nodes: CodeSpaceTreeNode[]) {
      for (const node of nodes) {
        if (node.type === 'file') paths.push(node.path);
        if (node.children) collect(node.children);
      }
    }
    for (const nodes of Object.values(treeChildren)) {
      collect(nodes);
    }
    return paths;
  }, [treeChildren]);

  const activeProjectRootPath =
    projects.find((project) => project.id === activeProjectId)?.rootPath ?? null;
  const mentionSeedPaths = useMemo(() => flatFilePaths, [flatFilePaths]);
  const mentionIndexHook = useMentionIndex(activeProjectRootPath, {
    seedPaths: mentionSeedPaths,
  });
  // Debounced refresh when the explorer tree grows so newly-loaded files appear in suggestions.
  useEffect(() => {
    if (!activeProjectRootPath) return;
    mentionIndexHook.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectRootPath, flatFilePaths.length]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loadingTree, setLoadingTree] = useState<Record<string, boolean>>({});
  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(true);
  const [leftWidth, setLeftWidth] = useState(304);
  const [rightWidth, setRightWidth] = useState(380);
  const [bottomVisible, setBottomVisible] = useState(true);
  const [bottomActiveTab, setBottomActiveTab] = useState<CodeSpaceBottomTab>('output');
  const [minimapEnabled, setMinimapEnabled] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const [revealHidden, setRevealHidden] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [providerConfigOpen, setProviderConfigOpen] = useState(false);
  const [codeSpaceInstruction, setCodeSpaceInstruction] = useState(() => readCodeSpacePreferences().instruction ?? '');
  const [zipSummary, setZipSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectNameInput, setProjectNameInput] = useState('');
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<CodeSpaceProject | null>(null);
  const [sessionRenameTarget, setSessionRenameTarget] = useState<CodeSpaceAgentSession | null>(null);
  const [sessionRenameInput, setSessionRenameInput] = useState('');
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [folderBrowserRoot, setFolderBrowserRoot] = useState<string>('');
  const [folderBrowserParent, setFolderBrowserParent] = useState<string>('');
  const [folderBrowserEntries, setFolderBrowserEntries] = useState<FolderBrowserEntry[]>([]);
  const [folderBrowserLoading, setFolderBrowserLoading] = useState(false);
  const [folderBrowserError, setFolderBrowserError] = useState<string | null>(null);
  const [folderBrowserManualPath, setFolderBrowserManualPath] = useState('');
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const fileContentsRef = useRef<Record<string, FilePayload>>({});
  const loadingFileIdsRef = useRef<Set<string>>(new Set());
  const projectsRef = useRef<CodeSpaceProject[]>([]);
  const autoDeletingProjectIds = useRef<Set<string>>(new Set());
  // Root Cause vs Logic: Hidden-only roots (e.g. `.git`) look empty in the explorer; only run the empty-folder check once per project so we do not re-trigger loadTree in a loop.
  const emptyAutoDeleteCheckedIds = useRef<Set<string>>(new Set());
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeSession = sessions.find((session) => session.id === activeSessionId && session.projectId === activeProjectId) ?? null;

  // Agent state
  const [agentRunning, setAgentRunning] = useState(false);
  const [pendingDiffs, setPendingDiffs] = useState<CodeSpacePendingDiff[]>([]);
  const [executionPolicy, setExecutionPolicy] = useState<CodeSpaceExecutionPolicy>(DEFAULT_CODE_SPACE_EXECUTION_POLICY);
  const [terminalStream, setTerminalStream] = useState('');
  const [agentChangesets, setAgentChangesets] = useState<Array<{
    filePath: string;
    beforeContent: string;
    afterContent: string;
    deleted?: boolean;
    acceptedAt: number;
  }>>([]);
  const [diffConfirmation, setDiffConfirmation] = useState<{
    sessionId: string;
    runId: string;
    files: Array<{ path: string; deleted: boolean; unifiedDiff: string }>;
    unifiedDiff: string;
    isGit: boolean;
    summary: string;
  } | null>(null);
  const [knowledgeGraphModalOpen, setKnowledgeGraphModalOpen] = useState(false);
  const agentAbortRef = useRef<AbortController | null>(null);
  const runningSessionIdRef = useRef<string | null>(null);
  const applyingDiffIdsRef = useRef<Set<string>>(new Set());
  const executionPolicyRef = useRef<CodeSpaceExecutionPolicy>(executionPolicy);
  const diffDecorationIdsRef = useRef<string[]>([]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    fileContentsRef.current = fileContents;
  }, [fileContents]);

  useEffect(() => {
    executionPolicyRef.current = executionPolicy;
  }, [executionPolicy]);

  useEffect(() => {
    setProjectNameInput(activeProject?.name ?? '');
  }, [activeProject?.name]);

  useEffect(() => {
    if (!activeSession || activeSession.mode === 'fresh-start') return;
    setAgentMode(normalizeCodeSpaceAgentMode(activeSession.mode));
  }, [activeSession]);

  useEffect(() => {
    const preferences = readCodeSpacePreferences();
    setActiveProjectId(preferences.activeProjectId ?? null);
    setActiveSessionId(preferences.activeSessionId ?? null);
    setAgentMode(normalizeCodeSpaceAgentMode(preferences.agentMode));
    setLeftVisible(preferences.leftSidebarVisible ?? true);
    setRightVisible(preferences.rightSidebarVisible ?? true);
    setLeftWidth(preferences.leftWidth ?? 304);
    setRightWidth(preferences.rightWidth ?? 380);
    setBottomVisible(preferences.bottomPanelVisible ?? true);
    setBottomActiveTab(preferences.bottomActiveTab ?? 'output');
    setMinimapEnabled(preferences.minimapEnabled ?? false);
    setWordWrap(preferences.wordWrap ?? true);
    setRevealHidden(preferences.revealHiddenFiles ?? false);
    setExecutionPolicy(preferences.executionPolicy ?? DEFAULT_CODE_SPACE_EXECUTION_POLICY);
    setCodeSpaceInstruction(preferences.instruction ?? '');

    void Promise.all([readCodeSpaceProjects(), readCodeSpaceSessions(), readCodeSpaceTabs()]).then(
      ([storedProjects, storedSessions, storedTabs]) => {
        // Root Cause vs Logic: Slow preference hydration was overwriting new projects/rows before the user saw them, so keep existing entries and only append the stored metadata.
        // Motivation vs Logic: Older storage can hold two rows that resolve to the same folder (different ids generated before path normalization, or duplicates from re-adds). Dedupe after merge and purge the stale rows from IndexedDB so the sidebar matches what we persist.
        setProjects((current) => {
          const merged = mergeById(current, storedProjects);
          const { kept, removed } = dedupeCodeSpaceProjects(merged);
          const keptIds = new Set(kept.map((project) => project.id));
          for (const stale of removed) {
            if (keptIds.has(stale.id)) continue;
            void deleteCodeSpaceProject(stale.id);
          }
          return kept;
        });
        setSessions((current) => mergeById(current, storedSessions));
        setTabs((current) => mergeById(current, storedTabs));
        const firstProject = storedProjects[0];
        if (!preferences.activeProjectId && firstProject) {
          setActiveProjectId((prev) => prev ?? firstProject.id);
        }
        const firstSession = storedSessions[0];
        if (!preferences.activeSessionId && firstSession) {
          setActiveSessionId((prev) => prev ?? firstSession.id);
        }
        const preferredProjectId = preferences.activeProjectId ?? firstProject?.id ?? null;
        const preferredTab =
          (preferences.activeTabId ? storedTabs.find((tab) => tab.id === preferences.activeTabId) : null) ??
          (preferredProjectId ? storedTabs.find((tab) => tab.projectId === preferredProjectId) : null) ??
          storedTabs[0] ??
          null;
        if (preferredTab) {
          setActiveTabId((prev) => prev ?? preferredTab.id);
        }
      },
    );
  }, []);

  useEffect(() => {
    writeCodeSpacePreferences({
      activeProjectId,
      activeSessionId,
      activeTabId,
      agentMode,
      executionPolicy,
      leftSidebarVisible: leftVisible,
      rightSidebarVisible: rightVisible,
      leftWidth,
      rightWidth,
      bottomPanelVisible: bottomVisible,
      bottomActiveTab,
      minimapEnabled,
      instruction: codeSpaceInstruction.trim() ? codeSpaceInstruction : undefined,
      wordWrap,
      revealHiddenFiles: revealHidden,
    });
  }, [
    activeProjectId,
    activeSessionId,
    activeTabId,
    agentMode,
    bottomVisible,
    bottomActiveTab,
    codeSpaceInstruction,
    leftVisible,
    leftWidth,
    minimapEnabled,
    revealHidden,
    rightVisible,
    rightWidth,
    wordWrap,
    executionPolicy,
  ]);

  const updateSession = useCallback((session: CodeSpaceAgentSession) => {
    setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
    void saveCodeSpaceSession(session);
  }, []);

  // Motivation vs Logic: session updates must stay scoped to one persisted record so independent sessions can diverge without sharing history or tool state.
  const patchSession = useCallback((sessionId: string, updater: (session: CodeSpaceAgentSession) => CodeSpaceAgentSession) => {
    let nextSession: CodeSpaceAgentSession | null = null;
    setSessions((current) => {
      const remaining: CodeSpaceAgentSession[] = [];
      for (const session of current) {
        if (session.id !== sessionId) {
          remaining.push(session);
          continue;
        }
        nextSession = updater(session);
      }
      return nextSession ? [nextSession, ...remaining] : current;
    });
    if (nextSession) {
      void saveCodeSpaceSession(nextSession);
    }
  }, []);

  const appendSessionMessage = useCallback(
    (sessionId: string, message: { id: string; role: CodeSpaceMessage['role']; content: string; createdAt: number }) => {
      patchSession(sessionId, (session) => ({
        ...session,
        messages: [...session.messages, message],
        updatedAt: Date.now(),
      }));
    },
    [patchSession],
  );

  const updateSessionMessage = useCallback(
    (sessionId: string, messageId: string, updater: (message: CodeSpaceAgentSession['messages'][number]) => CodeSpaceAgentSession['messages'][number]) => {
      patchSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) => (message.id === messageId ? updater(message) : message)),
        updatedAt: Date.now(),
      }));
    },
    [patchSession],
  );

  const upsertSessionToolCall = useCallback(
    (sessionId: string, toolCall: Partial<CodeSpaceAgentSession['toolCalls'][number]> & { id: string; name: string }) => {
      patchSession(sessionId, (session) => {
        const existingIndex = session.toolCalls.findIndex((entry) => entry.id === toolCall.id);
        const existing = existingIndex >= 0 ? session.toolCalls[existingIndex] : null;
        const merged = {
          id: toolCall.id,
          name: toolCall.name,
          status: toolCall.status ?? existing?.status ?? 'running',
          summary: toolCall.summary ?? existing?.summary ?? '',
          input: toolCall.input ?? existing?.input,
          output: toolCall.output ?? existing?.output,
          error: toolCall.error ?? existing?.error,
          durationMs: toolCall.durationMs ?? existing?.durationMs,
          createdAt: toolCall.createdAt ?? existing?.createdAt ?? Date.now(),
          updatedAt: toolCall.updatedAt ?? Date.now(),
        };
        const nextToolCalls = [...session.toolCalls];
        if (existingIndex >= 0) nextToolCalls[existingIndex] = merged;
        else nextToolCalls.push(merged);
        return { ...session, toolCalls: nextToolCalls, updatedAt: Date.now() };
      });
    },
    [patchSession],
  );

  const ensureSession = useCallback(() => {
    if (activeSession && activeSession.projectId === activeProjectId) return activeSession;
    const session = createSession(activeProjectId);
    setActiveSessionId(session.id);
    updateSession(session);
    return session;
  }, [activeProjectId, activeSession, updateSession]);

  // Motivation vs Logic: Keep renaming in the session sidebar, but route the actual edit through a modal so the flow is visible, recoverable, and keyboard-friendly.
  const renameSession = useCallback(
    (session: CodeSpaceAgentSession) => {
      setSessionRenameTarget(session);
      setSessionRenameInput(session.title);
    },
    [],
  );

  const closeSessionRenameDialog = useCallback(() => {
    setSessionRenameTarget(null);
    setSessionRenameInput('');
  }, []);

  useEffect(() => {
    if (!sessionRenameTarget) return;
    const stillExists = sessions.some((session) => session.id === sessionRenameTarget.id);
    if (!stillExists) closeSessionRenameDialog();
  }, [closeSessionRenameDialog, sessionRenameTarget, sessions]);

  const handleSessionRenameSave = useCallback(() => {
    if (!sessionRenameTarget) return;
    const nextTitle = sessionRenameInput.trim();
    if (!nextTitle || nextTitle === sessionRenameTarget.title) {
      closeSessionRenameDialog();
      return;
    }
    updateSession({ ...sessionRenameTarget, title: nextTitle, updatedAt: Date.now() });
    closeSessionRenameDialog();
  }, [closeSessionRenameDialog, sessionRenameInput, sessionRenameTarget, updateSession]);

  const handleSessionRenameCancel = useCallback(() => {
    closeSessionRenameDialog();
  }, [closeSessionRenameDialog]);

  // Root Cause vs Logic: the previous implementation called `window.confirm` inline, which
  // forced `SessionListSection` to shadow `window.confirm` to avoid a double prompt. The flow
  // is now split: `removeSessionRecord` performs the destructive work, and `deleteSession`
  // wraps it with the shared modal so every entry point gets the same in-app confirmation.
  const removeSessionRecord = useCallback(
    async (session: CodeSpaceAgentSession) => {
      setSessions((current) => {
        const next = current.filter((item) => item.id !== session.id);
        setActiveSessionId((activeId) => {
          if (activeId === session.id) {
            return next[0]?.id ?? null;
          }
          return activeId;
        });
        return next;
      });
      try {
        await deleteCodeSpaceSession(session.id);
      } catch {
        // Persistence errors are non-critical; the UI already dropped the session.
      }
    },
    [deleteCodeSpaceSession, setActiveSessionId, setSessions],
  );

  const deleteSession = useCallback(
    async (session: CodeSpaceAgentSession) => {
      const accepted = await openConfirmDialog({
        title: 'Delete session',
        message: `Delete session "${session.title}"? This cannot be undone.`,
        confirmLabel: 'Delete session',
      });
      if (!accepted) return;
      await removeSessionRecord(session);
    },
    [openConfirmDialog, removeSessionRecord],
  );

  type SessionRowProps = {
    session: CodeSpaceAgentSession;
    selectable?: boolean;
  };
  const SessionRow = ({ session, selectable = false }: SessionRowProps) => {
    const isActive = selectable && activeSessionId === session.id;
    const handleSelect = () => {
      if (!selectable) return;
      setActiveSessionId(session.id);
    };
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (!selectable) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setActiveSessionId(session.id);
      }
    };
    const statusText = session.archived ? 'archived' : session.status;
    const formattedAt = new Date(session.updatedAt).toLocaleString();
    const interactionProps = selectable
      ? {
          role: 'button' as const,
          tabIndex: 0,
          onClick: handleSelect,
          onKeyDown: handleKeyDown,
        }
      : {};
    return (
      <div
        {...interactionProps}
        className={`mb-1 flex items-start justify-between rounded border px-2 py-2 text-[12px] ${isActive ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:border-[#2a2a2a] hover:bg-[#252526]'} group`}
      >
        <div className="flex-1">
          <div className="flex items-center gap-2">
            {session.archived && <Archive size={12} className="text-[#8b8b8b]" />}
            <div className="truncate font-medium">{session.title}</div>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-[#8b8b8b]">
            <History size={11} />
            <span>{statusText}</span>
            <span>·</span>
            <span>{formattedAt}</span>
          </div>
        </div>
        <div className="ml-3 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              renameSession(session);
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
              void deleteSession(session);
            }}
            className="rounded border border-transparent px-1.5 text-[#8b8b8b] hover:border-[#3a3a3a] hover:text-[#d4d4d4]"
            title="Delete session"
            aria-label="Delete session"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    );
  };

  const refreshGitStatus = useCallback(async (project: CodeSpaceProject) => {
    if (!project.rootPath) return;
    try {
      const res = await fetch('/api/code-space/git-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: project.rootPath }),
      });
      const git = await res.json();
      const next = { ...project, git, branch: git.branch ?? project.branch, updatedAt: Date.now() };
      setProjects((current) => current.map((item) => (item.id === next.id ? next : item)));
      await saveCodeSpaceProject(next);
    } catch {
      // Git status is opportunistic; non-git folders still work as editable projects.
    }
  }, []);

  const loadFilePayload = useCallback(async (project: CodeSpaceProject, filePath: string): Promise<FilePayload> => {
    if (!project.rootPath) {
      throw new Error('Unable to open a file without a project root');
    }
    const res = await fetch('/api/code-space/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read', rootPath: project.rootPath, path: filePath }),
    });
    const data = (await res.json()) as FilePayload & { error?: string };
    if (!res.ok) throw new Error(data.error ?? 'Could not open file');
    return data;
  }, []);

  const ensureFileContent = useCallback(
    async (project: CodeSpaceProject, tab: CodeSpaceEditorTab) => {
      if (!project.rootPath) return null;
      const cached = fileContentsRef.current[tab.id];
      if (cached) return cached;
      if (loadingFileIdsRef.current.has(tab.id)) return null;
      loadingFileIdsRef.current.add(tab.id);
      try {
        const data = await loadFilePayload(project, tab.path);
        setFileContents((current) => (current[tab.id] ? current : { ...current, [tab.id]: data }));
        return data;
      } finally {
        loadingFileIdsRef.current.delete(tab.id);
      }
    },
    [loadFilePayload],
  );

  const finalizeProjectRemoval = useCallback((projectId: string) => {
    emptyAutoDeleteCheckedIds.current.delete(projectId);
    let remainingProjects: CodeSpaceProject[] = [];
    setProjects((current) => {
      remainingProjects = current.filter((item) => item.id !== projectId);
      return remainingProjects;
    });
    setSessions((current) => {
      const next = current.filter((session) => session.projectId !== projectId);
      setActiveSessionId((activeId) => {
        if (activeId && !next.some((session) => session.id === activeId)) {
          return next[0]?.id ?? null;
        }
        return activeId;
      });
      return next;
    });
    const removedTabIds: string[] = [];
    // Root Cause vs Logic: dropping a project left its tabs in IndexedDB, so they reappeared after reload; delete the persisted rows when the project is gone.
    setTabs((current) => {
      const next = current.filter((tab) => {
        if (tab.projectId === projectId) {
          removedTabIds.push(tab.id);
          return false;
        }
        return true;
      });
      setActiveTabId((activeId) => {
        if (activeId && !next.some((tab) => tab.id === activeId)) {
          return null;
        }
        return activeId;
      });
      return next;
    });
    for (const tabId of removedTabIds) {
      void deleteCodeSpaceTab(tabId);
    }
    setActiveProjectId((activeId) => {
      if (activeId !== projectId) return activeId;
      setLocalPath('');
      return remainingProjects[0]?.id ?? null;
    });
  }, []);

  // Root Cause vs Logic: Helpers used in multiple callbacks must exist before those closures run; define this before `verifyAndDeleteEmptyProject` so the TDZ never fires.
  const deleteProjectDirectory = useCallback(async (project: CodeSpaceProject) => {
    if (!project.rootPath) throw new Error('Unable to delete a project without a root path');
    const parent = parentPath(project.rootPath);
    if (!parent) throw new Error('Unable to delete the root folder');
    const targetFolder = basename(project.rootPath);
    const res = await fetch('/api/code-space/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', rootPath: parent, path: targetFolder }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Delete failed');
    return data;
  }, []);

  // Root Cause vs Logic: `loadTree` depends on this helper via its dependency array, so declare it before `loadTree` to avoid the temporal dead zone that caused the ReferenceError.
  // Motivation vs Logic: A sidebar entry that resolves to an empty directory (or to a path that no
  // longer exists on disk) is dead weight—e.g. a half-finished `git clone` that produced just a
  // bare folder. We confirm the directory is genuinely empty by listing it with revealHidden=true
  // and only then drop it from the sidebar and IndexedDB. We intentionally do NOT remove the
  // directory on disk: the user explicitly added that path and may want to populate it later.
  const verifyAndDeleteEmptyProject = useCallback(
    async (project: CodeSpaceProject) => {
      if (!project.rootPath) return;
      if (autoDeletingProjectIds.current.has(project.id)) return;
      autoDeletingProjectIds.current.add(project.id);
      try {
        const params = new URLSearchParams({ rootPath: project.rootPath, path: '', revealHidden: 'true' });
        const res = await fetch(`/api/code-space/files?${params.toString()}`);
        const data = await res.json();
        const missingOnDisk = !res.ok && /ENOENT|no such file|not found/i.test(data.error ?? '');
        if (!res.ok && !missingOnDisk) {
          throw new Error(data.error ?? 'Unable to verify folder contents');
        }
        const hasEntries = res.ok && Array.isArray(data.entries) && data.entries.length > 0;
        if (hasEntries) return;
        finalizeProjectRemoval(project.id);
        await deleteCodeSpaceProject(project.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        autoDeletingProjectIds.current.delete(project.id);
      }
    },
    [finalizeProjectRemoval],
  );

  const loadTree = useCallback(
    async (project: CodeSpaceProject, folderPath = '') => {
      if (!project.rootPath) return;
      if (autoDeletingProjectIds.current.has(project.id)) return;
      const key = `${project.id}:${folderPath}`;
      setLoadingTree((current) => ({ ...current, [key]: true }));
      setError(null);
      try {
        const params = new URLSearchParams({
          rootPath: project.rootPath,
          path: folderPath,
          revealHidden: revealHidden ? 'true' : 'false',
        });
        const res = await fetch(`/api/code-space/files?${params.toString()}`);
        const data = (await res.json()) as TreeResponse & { error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Could not load folder');
        setTreeChildren((current) => ({ ...current, [key]: data.entries ?? [] }));
        if (
          !folderPath &&
          (!data.entries || data.entries.length === 0) &&
          !emptyAutoDeleteCheckedIds.current.has(project.id)
        ) {
          emptyAutoDeleteCheckedIds.current.add(project.id);
          void verifyAndDeleteEmptyProject(project);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingTree((current) => ({ ...current, [key]: false }));
      }
    },
    [revealHidden, verifyAndDeleteEmptyProject],
  );

  const loadTreeRef = useRef(loadTree);
  const refreshGitStatusRef = useRef(refreshGitStatus);
  const verifyAndDeleteEmptyProjectRef = useRef(verifyAndDeleteEmptyProject);
  loadTreeRef.current = loadTree;
  refreshGitStatusRef.current = refreshGitStatus;
  verifyAndDeleteEmptyProjectRef.current = verifyAndDeleteEmptyProject;

  // Root Cause vs Logic: Depending on `loadTree` in this effect re-ran whenever project state changed, causing a refresh loop; only react to active project / reveal-hidden changes.
  useEffect(() => {
    const project = projectsRef.current.find((item) => item.id === activeProjectId);
    if (!project) return;
    void loadTreeRef.current(project, '');
    void refreshGitStatusRef.current(project);
  }, [activeProjectId, revealHidden]);

  // Motivation vs Logic: `loadTree` only sweeps the active project, so a non-active dead row (for
  // example, a half-finished `git clone` that produced an empty folder named "triage") would sit
  // in the sidebar until the user clicked it. Whenever the project list changes, check any
  // projects we have not yet verified once in the background so empty entries fall off on their
  // own. `emptyAutoDeleteCheckedIds` prevents duplicate checks per project per session.
  useEffect(() => {
    if (!projects.length) return;
    const pending = projects.filter(
      (project) =>
        project.rootPath &&
        !emptyAutoDeleteCheckedIds.current.has(project.id) &&
        !autoDeletingProjectIds.current.has(project.id),
    );
    if (!pending.length) return;
    for (const project of pending) {
      emptyAutoDeleteCheckedIds.current.add(project.id);
      void verifyAndDeleteEmptyProjectRef.current(project);
    }
  }, [projects]);

  const addProject = useCallback(
    async (project: CodeSpaceProject) => {
      const nextProject = { ...project, active: true };
      // Motivation vs Logic: If the user re-opens a folder (or re-pastes the same GitHub URL) we
      // want to refresh the existing sidebar row instead of stacking a second duplicate. Dedup by
      // the normalized rootPath/repoUrl so two rows pointing at the same project collapse into
      // one, and purge any stale IndexedDB rows whose ids differ from the surviving entry.
      const nextDedupKey = getCodeSpaceProjectDedupKey(nextProject);
      let staleIdsToDelete: string[] = [];
      setProjects((current) => {
        const merged = [nextProject, ...current.map((item) => ({ ...item, active: false }))];
        const { kept, removed } = dedupeCodeSpaceProjects(merged);
        staleIdsToDelete = removed
          .filter((item) => item.id !== nextProject.id && getCodeSpaceProjectDedupKey(item) === nextDedupKey)
          .map((item) => item.id);
        return kept;
      });
      for (const staleId of staleIdsToDelete) {
        void deleteCodeSpaceProject(staleId);
      }
      setActiveProjectId(nextProject.id);
      await saveCodeSpaceProject(nextProject);
      void loadTree(nextProject, '');
      void refreshGitStatus(nextProject);
    },
    [loadTree, refreshGitStatus],
  );

  const openLocalProject = useCallback(
    async (pathOverride?: string) => {
      const candidate = (pathOverride ?? localPath).trim();
      if (!candidate) return;
      const project = createCodeSpaceProject({
        name: projectNameFromPath(candidate),
        sourceType: 'local',
        rootPath: candidate,
        source: { sourceType: 'local', repoPath: candidate, authMode: 'none' },
      });
      setLocalPath(candidate);
      await addProject(project);
    },
    [addProject, localPath],
  );

  const cloneGithubProject = useCallback(
    async (urlOverride?: string) => {
      const candidate = (urlOverride ?? repoUrl).trim();
      if (!candidate) return;
      setError(null);
      setRepoUrl(candidate);
      try {
        const res = await fetch('/api/repo/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { sourceType: 'github', repoPath: '', repoUrl: candidate, authMode: 'none' },
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Clone failed');
        const project = createCodeSpaceProject({
          name: projectNameFromPath(data.resolved),
          sourceType: 'github',
          rootPath: data.resolved,
          repoRef: data.clonedFrom,
          source: { sourceType: 'github', repoPath: data.resolved, repoUrl: candidate, authMode: 'none' },
        });
        await addProject(project);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [addProject, repoUrl],
  );

  const promptToCloneGithub = useCallback(async () => {
    const selection = await openPromptDialog({
      title: 'Clone GitHub repository',
      description: 'Paste an HTTPS or SSH URL. Codoptic clones the repo and adds it as a new project.',
      label: 'Repository URL',
      placeholder: 'https://github.com/owner/repo.git',
      confirmLabel: 'Clone repository',
      helperText: 'Press Enter to clone or Escape to cancel.',
      selectOnOpen: false,
    });
    if (!selection) return;
    await cloneGithubProject(selection);
  }, [cloneGithubProject, openPromptDialog]);

  // Motivation vs Logic: Browsers can't hand the Code Space backend an absolute folder path
  // (the `<input webkitdirectory>` API hides `file.path` outside Electron), so we delegate
  // folder picking to the existing server-side `/api/repo/directories` endpoint. It already
  // walks the host filesystem with the same path guard and returns absolute paths, which lets
  // us create projects automatically without the browser's "trust this site" upload prompt.
  const loadFolderBrowserEntries = useCallback(
    async (root: string, parent = '') => {
      setFolderBrowserLoading(true);
      setFolderBrowserError(null);
      try {
        const res = await fetch('/api/repo/directories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rootPath: root || undefined, parent }),
        });
        const data = (await res.json()) as FolderBrowserResponse;
        if (!res.ok) {
          setFolderBrowserError(data.error ?? 'Could not list folder');
          setFolderBrowserEntries([]);
          return;
        }
        const nextRoot = data.root ?? root;
        const nextEntries: FolderBrowserEntry[] = Array.isArray(data.entries)
          ? data.entries
          : Array.isArray(data.directories)
            ? data.directories.map((entry) => ({ ...entry, type: 'dir' as const }))
            : [];
        setFolderBrowserRoot(nextRoot);
        setFolderBrowserParent(data.parent ?? parent ?? '');
        setFolderBrowserEntries(nextEntries);
        if (!folderBrowserManualPath || folderBrowserManualPath === root) {
          setFolderBrowserManualPath(nextRoot);
        }
      } catch (err) {
        setFolderBrowserError(err instanceof Error ? err.message : String(err));
        setFolderBrowserEntries([]);
      } finally {
        setFolderBrowserLoading(false);
      }
    },
    [folderBrowserManualPath],
  );

  const openFolderBrowser = useCallback(() => {
    setError(null);
    setFolderBrowserOpen(true);
    const initialRoot = localPath.trim() || folderBrowserRoot || '';
    setFolderBrowserManualPath(initialRoot);
    void loadFolderBrowserEntries(initialRoot, '');
  }, [folderBrowserRoot, loadFolderBrowserEntries, localPath]);

  const closeFolderBrowser = useCallback(() => {
    setFolderBrowserOpen(false);
  }, []);

  const handleFolderBrowserSelect = useCallback(
    async (absolutePath: string) => {
      const candidate = absolutePath.trim();
      if (!candidate) return;
      closeFolderBrowser();
      await openLocalProject(candidate);
    },
    [closeFolderBrowser, openLocalProject],
  );

  const handleManualOpen = useCallback(() => {
    if (!localPath.trim()) {
      openFolderBrowser();
      return;
    }
    void openLocalProject();
  }, [localPath, openFolderBrowser, openLocalProject]);

  // Motivation vs Logic: Allow project icons to trigger the same rename endpoint so the stored path and labels stay in sync.
  const renameProjectInternal = useCallback(
    async (project: CodeSpaceProject, nextName: string) => {
      if (!project.rootPath) {
        setError('Unable to rename project without a root path');
        return;
      }
      const parent = parentPath(project.rootPath);
      if (!parent) {
        setError('Unable to rename the root folder');
        if (project.id === activeProjectId) {
          setProjectNameInput(project.name);
        }
        return;
      }
      const currentFolder = basename(project.rootPath);
      setRenamingProjectId(project.id);
      setError(null);
      try {
        const res = await fetch('/api/code-space/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rename', rootPath: parent, path: currentFolder, nextPath: nextName }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Rename failed');
        const nextRootPath = joinPathSegments(parent, nextName);
        const nextProject = {
          ...project,
          name: nextName,
          rootPath: nextRootPath,
          source: project.source ? { ...project.source, repoPath: nextRootPath } : undefined,
          updatedAt: Date.now(),
        };
        setProjects((current) => current.map((item) => (item.id === nextProject.id ? nextProject : item)));
        await saveCodeSpaceProject(nextProject);
        if (project.id === activeProjectId) {
          setLocalPath(nextRootPath);
          setProjectNameInput(nextName);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        if (project.id === activeProjectId) {
          setProjectNameInput(project.name);
        }
      } finally {
        setRenamingProjectId(null);
      }
    },
    [activeProjectId, saveCodeSpaceProject],
  );

  const commitProjectRename = useCallback(async () => {
    if (!activeProject) return;
    const nextName = projectNameInput.trim();
    if (!nextName || nextName === activeProject.name) {
      setProjectNameInput(activeProject.name);
      return;
    }
    await renameProjectInternal(activeProject, nextName);
  }, [activeProject, projectNameInput, renameProjectInternal]);

  const promptProjectRename = useCallback(
    async (project: CodeSpaceProject) => {
      const candidate = await openPromptDialog({
        title: 'Rename project',
        description: `Renames the project folder for ${project.name}.`,
        label: 'Project name',
        defaultValue: project.name,
        confirmLabel: 'Rename project',
        validate: (value) => (value.includes('/') || value.includes('\\')
          ? 'Project names cannot contain slashes.'
          : null),
        selectOnOpen: true,
      });
      if (!candidate || candidate === project.name) return;
      void renameProjectInternal(project, candidate);
    },
    [openPromptDialog, renameProjectInternal],
  );

  const confirmProjectDeletion = useCallback(async () => {
    if (!projectToDelete) return;
    setIsDeletingProject(true);
    setError(null);
    try {
      await deleteProjectDirectory(projectToDelete);
      finalizeProjectRemoval(projectToDelete.id);
      await deleteCodeSpaceProject(projectToDelete.id);
      setProjectToDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDeletingProject(false);
    }
  }, [deleteProjectDirectory, finalizeProjectRemoval, projectToDelete]);

  // Motivation vs Logic: markdown preview is a tab-level state, not a one-off render choice, so the opener restores preview by default for new markdown tabs and preserves an explicit user override when reopening an existing tab.
  const openFile = useCallback(
    async (project: CodeSpaceProject, filePath: string, options?: { preview?: boolean }) => {
      if (!project.rootPath) return;
      const existing = tabs.find((tab) => tab.projectId === project.id && tab.path === filePath);
      if (existing) {
        if (typeof options?.preview === 'boolean' && existing.preview !== options.preview) {
          const nextTab = { ...existing, preview: options.preview };
          setTabs((current) => current.map((tab) => (tab.id === nextTab.id ? nextTab : tab)));
          void saveCodeSpaceTab(nextTab);
        }
        setActiveTabId(existing.id);
        void ensureFileContent(project, existing);
        return;
      }
      setError(null);
      try {
        const data = await loadFilePayload(project, filePath);
        const tab: CodeSpaceEditorTab = {
          id: nowId('tab'),
          projectId: project.id,
          path: filePath,
          language: detectCodeSpaceLanguage(filePath),
          contentHash: data.hash,
          dirty: false,
          pinned: true,
          preview: detectCodeSpaceLanguage(filePath) === 'markdown',
          lastOpenedAt: Date.now(),
        };
        setFileContents((current) => ({ ...current, [tab.id]: data }));
        setTabs((current) => [tab, ...current]);
        setActiveTabId(tab.id);
        await saveCodeSpaceTab(tab);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [ensureFileContent, loadFilePayload, saveCodeSpaceTab, tabs],
  );

  const openPlanFile = useCallback(
    async (filePath: string) => {
      if (!activeProject) return;
      await openFile(activeProject, filePath);
    },
    [activeProject, openFile],
  );

  useEffect(() => {
    // Root Cause vs Logic: the plan card already falls back to dispatching a custom event when no direct callback is supplied,
    // but the workspace never subscribed to that event, so "View plan..." was a dead click. Reuse the normal file opener here
    // so plan artifacts open in the editor tab just like files from the tree, and keep the custom-event bridge for compatibility.
    const onOpenPlanFile = (event: Event) => {
      const customEvent = event as CustomEvent<{ filePath?: string }>;
      const filePath = customEvent.detail?.filePath;
      if (!filePath) return;
      void openPlanFile(filePath);
    };

    window.addEventListener('code-space:open-plan-file', onOpenPlanFile as EventListener);
    return () => window.removeEventListener('code-space:open-plan-file', onOpenPlanFile as EventListener);
  }, [openPlanFile]);

  const saveActiveFile = useCallback(async () => {
    if (!activeProject?.rootPath || !activeTab) return;
    const payload = fileContents[activeTab.id];
    if (!payload) return;
    setError(null);
    try {
      const res = await fetch('/api/code-space/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'write',
          rootPath: activeProject.rootPath,
          path: activeTab.path,
          content: payload.content,
          expectedHash: activeTab.contentHash,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      const nextTab = { ...activeTab, contentHash: data.hash, dirty: false, lastOpenedAt: Date.now() };
      setTabs((current) => current.map((tab) => (tab.id === nextTab.id ? nextTab : tab)));
      setFileContents((current) => ({ ...current, [activeTab.id]: { ...payload, hash: data.hash } }));
      await saveCodeSpaceTab(nextTab);
      void refreshGitStatus(activeProject);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeProject, activeTab, fileContents, refreshGitStatus]);

  const runFileAction = useCallback(
    async (body: Record<string, unknown>) => {
      if (!activeProject?.rootPath) return;
      setError(null);
      try {
        const res = await fetch('/api/code-space/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rootPath: activeProject.rootPath, ...body }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'File operation failed');
        const folder = typeof body.path === 'string' ? dirname(body.path) : '';
        await loadTree(activeProject, folder);
        await loadTree(activeProject, '');
        void refreshGitStatus(activeProject);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeProject, loadTree, refreshGitStatus],
  );

  // Motivation vs Logic: the toolbar file actions used to call `window.prompt`/`window.confirm`
  // directly, which broke focus, leaked the page origin, and looked alien next to the editor
  // chrome. They now route through the shared dialog hook so the experience matches every other
  // mutation in Code Space.
  const createFile = useCallback(async () => {
    const target = await openPromptDialog({
      title: 'Create file',
      description: 'Provide a path relative to the project root (e.g. src/components/Button.tsx).',
      label: 'File path',
      placeholder: 'path/to/file.ts',
      confirmLabel: 'Create file',
      selectOnOpen: false,
    });
    if (!target) return;
    void runFileAction({ action: 'write', path: target, content: '' });
  }, [openPromptDialog, runFileAction]);

  const createFolder = useCallback(async () => {
    const target = await openPromptDialog({
      title: 'Create folder',
      description: 'Provide a path relative to the project root (e.g. src/components/widgets).',
      label: 'Folder path',
      placeholder: 'path/to/folder',
      confirmLabel: 'Create folder',
      selectOnOpen: false,
    });
    if (!target) return;
    void runFileAction({ action: 'mkdir', path: target });
  }, [openPromptDialog, runFileAction]);

  const renameActiveFile = useCallback(async () => {
    if (!activeTab) return;
    const target = await openPromptDialog({
      title: 'Rename file',
      description: 'Provide the new project-relative path. Existing folders along the path will be reused.',
      label: 'New file path',
      defaultValue: activeTab.path,
      confirmLabel: 'Rename file',
      selectOnOpen: true,
    });
    if (!target || target === activeTab.path) return;
    void runFileAction({ action: 'rename', path: activeTab.path, nextPath: target });
    const nextLanguage = detectCodeSpaceLanguage(target);
    const nextTab = {
      ...activeTab,
      path: target,
      language: nextLanguage,
      preview:
        nextLanguage === 'markdown'
          ? activeTab.language === 'markdown'
            ? activeTab.preview
            : true
          : false,
    };
    setTabs((current) => current.map((tab) => (tab.id === activeTab.id ? nextTab : tab)));
    void saveCodeSpaceTab(nextTab);
  }, [activeTab, openPromptDialog, runFileAction, saveCodeSpaceTab]);

  const duplicateActiveFile = useCallback(async () => {
    if (!activeTab) return;
    const target = await openPromptDialog({
      title: 'Duplicate file',
      description: `Copy ${activeTab.path} to a new project-relative path.`,
      label: 'New file path',
      defaultValue: `${activeTab.path}.copy`,
      confirmLabel: 'Duplicate file',
      selectOnOpen: true,
    });
    if (!target) return;
    void runFileAction({ action: 'duplicate', path: activeTab.path, nextPath: target });
  }, [activeTab, openPromptDialog, runFileAction]);

  const deleteActiveFile = useCallback(async () => {
    if (!activeTab) return;
    const accepted = await openConfirmDialog({
      title: 'Delete file',
      message: `Delete ${activeTab.path}? This cannot be undone here.`,
      confirmLabel: 'Delete file',
    });
    if (!accepted) return;
    const tabIdToRemove = activeTab.id;
    void runFileAction({ action: 'delete', path: activeTab.path });
    setTabs((current) => current.filter((tab) => tab.id !== tabIdToRemove));
    setActiveTabId(null);
    // Root Cause vs Logic: file deletions previously kept their tab rows in IndexedDB, so they popped back after refresh; delete the persisted entry too.
    void deleteCodeSpaceTab(tabIdToRemove);
  }, [activeTab, openConfirmDialog, runFileAction]);

  const toggleActiveTabPreview = useCallback(() => {
    if (!activeTab || activeTab.language !== 'markdown') return;
    const nextTab = { ...activeTab, preview: !activeTab.preview };
    setTabs((current) => current.map((tab) => (tab.id === nextTab.id ? nextTab : tab)));
    void saveCodeSpaceTab(nextTab);
  }, [activeTab, saveCodeSpaceTab]);

  // Root Cause vs Logic: auto mode only changed how diffs were labeled; the workspace still held them in a manual review queue. Reuse the existing apply path so auto mode can commit the patch immediately and manual mode can keep the same confirmation flow.
  const finalizePendingDiff = useCallback(
    (diff: CodeSpacePendingDiff) => {
      const session = activeSession ?? ensureSession();
      const acceptedAt = Date.now();
      const afterContent = diff.deleted ? '' : applyAcceptedDiffHunks(diff.oldContent, diff.hunks, acceptedHunkIdSet(diff.hunkStatus));
      if (hasAcceptedHunks(diff.hunkStatus)) {
        setAgentChangesets((current) => [
          ...current.filter((item) => item.filePath !== diff.filePath),
          {
            filePath: diff.filePath,
            beforeContent: diff.oldContent,
            afterContent,
            deleted: diff.deleted && afterContent === '',
            acceptedAt,
          },
        ]);
        patchSession(session.id, (current) => ({
          ...current,
          filesChanged: Array.from(new Set([...current.filesChanged, diff.filePath])),
          agentChangesets: [
            ...current.agentChangesets.filter((item) => item.filePath !== diff.filePath),
            {
              filePath: diff.filePath,
              beforeContent: diff.oldContent,
              afterContent,
              deleted: diff.deleted && afterContent === '',
              acceptedAt,
            },
          ],
          updatedAt: Date.now(),
        }));
      }
      setPendingDiffs((current) => current.filter((item) => item.diffId !== diff.diffId));
      if (activeProject) void refreshGitStatus(activeProject);
    },
    [activeProject, activeSession, ensureSession, patchSession, refreshGitStatus],
  );

  const applyPendingDiff = useCallback(
    async (diff: CodeSpacePendingDiff, options?: { removeOnFailure?: boolean }) => {
      if (applyingDiffIdsRef.current.has(diff.diffId) || !activeProject?.rootPath) return;
      applyingDiffIdsRef.current.add(diff.diffId);
      const session = activeSession ?? ensureSession();
      try {
        const response = await fetch('/api/code-space/patches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'apply',
            rootPath: activeProject.rootPath,
            projectId: activeProject.id,
            runId: session.id,
            patchId: diff.diffId,
            files: [
              {
                path: diff.filePath,
                beforeContent: diff.oldContent,
                afterContent: diff.newContent,
                deleted: diff.deleted,
              },
            ],
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Patch apply failed');
        finalizePendingDiff({
          ...diff,
          hunkStatus: Object.fromEntries(diff.hunks.map((hunk) => [hunk.id, 'accepted' as const])),
        });
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        if (options?.removeOnFailure) {
          setPendingDiffs((current) => current.filter((item) => item.diffId !== diff.diffId));
        }
      } finally {
        applyingDiffIdsRef.current.delete(diff.diffId);
      }
    },
    [activeProject, activeSession, ensureSession, finalizePendingDiff],
  );

  const updatePendingDiff = useCallback((diffId: string, updater: (current: CodeSpacePendingDiff) => CodeSpacePendingDiff) => {
    setPendingDiffs((current) => current.map((item) => (item.diffId === diffId ? updater(item) : item)));
  }, []);

  const acceptPendingHunk = useCallback(
    async (diffId: string, hunkId: string) => {
      const diff = pendingDiffs.find((item) => item.diffId === diffId);
      if (!diff || !activeProject?.rootPath) return;
      const hunk = diff.hunks.find((item) => item.id === hunkId);
      if (!hunk || diff.hunkStatus[hunkId]) return;

      updatePendingDiff(diffId, (current) => ({ ...current, applyingHunkId: hunkId, error: undefined }));
      const beforeContent = resolvedContentForHunk(diff);
      const afterContent = resolvedContentForHunk(diff, hunkId);

      try {
        const session = activeSession ?? ensureSession();
        const response = await fetch('/api/code-space/patches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'apply',
            rootPath: activeProject.rootPath,
            projectId: activeProject.id,
            runId: session.id,
            patchId: `${diff.diffId}:${hunkId}`,
            files: [
              {
                path: diff.filePath,
                beforeContent,
                afterContent,
                deleted: diff.deleted && afterContent === '',
              },
            ],
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Patch apply failed');

        const updatedDiff: CodeSpacePendingDiff = {
          ...diff,
          applyingHunkId: undefined,
          hunkStatus: { ...diff.hunkStatus, [hunkId]: 'accepted' as const },
          error: undefined,
        };
        updatePendingDiff(diffId, () => updatedDiff);
        if (everyHunkResolved(updatedDiff.hunks, updatedDiff.hunkStatus)) {
          finalizePendingDiff(updatedDiff);
        } else if (activeProject) {
          void refreshGitStatus(activeProject);
        }
      } catch (error) {
        updatePendingDiff(diffId, (current) => ({
          ...current,
          applyingHunkId: undefined,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [activeProject, activeSession, ensureSession, finalizePendingDiff, pendingDiffs, refreshGitStatus, updatePendingDiff],
  );

  const rejectPendingHunk = useCallback(
    (diffId: string, hunkId: string) => {
      const diff = pendingDiffs.find((item) => item.diffId === diffId);
      if (!diff) return;
      const updatedDiff: CodeSpacePendingDiff = {
        ...diff,
        hunkStatus: { ...diff.hunkStatus, [hunkId]: 'rejected' as const },
        error: undefined,
      };
      updatePendingDiff(diffId, () => updatedDiff);
      if (everyHunkResolved(updatedDiff.hunks, updatedDiff.hunkStatus)) {
        finalizePendingDiff(updatedDiff);
      }
    },
    [finalizePendingDiff, pendingDiffs, updatePendingDiff],
  );

  const acceptAllPendingHunks = useCallback(
    async (diffId: string) => {
      const diff = pendingDiffs.find((item) => item.diffId === diffId);
      if (!diff || !activeProject?.rootPath) return;
      updatePendingDiff(diffId, (current) => ({ ...current, applyingAll: true, error: undefined }));

      try {
        const session = activeSession ?? ensureSession();
        const beforeContent = resolvedContentForHunk(diff);
        const afterContent = diff.deleted ? '' : diff.newContent;
        const response = await fetch('/api/code-space/patches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'apply',
            rootPath: activeProject.rootPath,
            projectId: activeProject.id,
            runId: session.id,
            patchId: `${diff.diffId}:all`,
            files: [
              {
                path: diff.filePath,
                beforeContent,
                afterContent,
                deleted: diff.deleted,
              },
            ],
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Patch apply failed');
        finalizePendingDiff({
          ...diff,
          hunkStatus: Object.fromEntries(diff.hunks.map((hunk) => [hunk.id, 'accepted' as const])),
        });
      } catch (error) {
        updatePendingDiff(diffId, (current) => ({
          ...current,
          applyingAll: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [activeProject, activeSession, ensureSession, finalizePendingDiff, pendingDiffs, updatePendingDiff],
  );

  const rejectAllPendingHunks = useCallback(
    (diffId: string) => {
      const diff = pendingDiffs.find((item) => item.diffId === diffId);
      if (!diff) return;
      finalizePendingDiff({
        ...diff,
        hunkStatus: Object.fromEntries(diff.hunks.map((hunk) => [hunk.id, 'rejected' as const])),
      });
    },
    [finalizePendingDiff, pendingDiffs],
  );

  const handleRunAgent = useCallback(async (userPrompt: string, attachments: SelectedMention[] = [], options: CodeSpacePromptOptions = {}) => {
    // Motivation vs Logic: the left sidebar owns project selection, so every agent run should resolve against the
    // same active project snapshot instead of re-deriving a potentially stale root during async hydration.
    const project = activeProject;
    if (!project || !project.rootPath) return;
    const requestedMode = options.modeOverride ?? agentMode;
    const buildPlanPath = options.buildPlanPath ?? extractBuildPlanPath(userPrompt);


    const session = ensureSession();
    const now = Date.now();
    const userMessage: CodeSpaceMessage = {
      id: nowId('msg'),
      role: 'user',
      content: userPrompt,
      createdAt: now,
    };
    const sessionWithPrompt: CodeSpaceAgentSession = {
      ...session,
      title: session.messages.length ? session.title : userPrompt.slice(0, 56),
      status: 'running',
      mode: requestedMode,
      messages: [...session.messages, userMessage],
      toolCallCount: 0,
      clarifyingQuestions: [],
      planMarkdown:
        buildPlanPath && session.planMarkdown?.filePath === buildPlanPath
          ? { ...session.planMarkdown, buildStatus: 'running' }
          : session.planMarkdown,
      updatedAt: now,
    };

    updateSession(sessionWithPrompt);
    setActiveSessionId(sessionWithPrompt.id);
    runningSessionIdRef.current = sessionWithPrompt.id;

    const abortCtrl = new AbortController();
    agentAbortRef.current = abortCtrl;
    setAgentRunning(true);
    setTerminalStream('');
    setPendingDiffs([]);

    // Root Cause vs Logic: the plan card used to keep its Build affordance forever because build completion was never
    // persisted on the session; track the build lifecycle here so the right sidebar can hide the action when done.
    let buildValidationFailed = false;
    const setPlanBuildStatus = (buildStatus: 'available' | 'running' | 'completed' | 'failed') => {
      if (!buildPlanPath) return;
      patchSession(sessionWithPrompt.id, (current) => {
        if (!current.planMarkdown || current.planMarkdown.filePath !== buildPlanPath) return current;
        return {
          ...current,
          planMarkdown: {
            ...current.planMarkdown,
            buildStatus,
          },
          updatedAt: Date.now(),
        };
      });
    };

    const openTabs = tabs.map((tab) => tab.path).filter((path): path is string => Boolean(path));
    const usesCustomModel =
      provider.provider === 'foundry' || provider.provider === 'deepseek' || provider.provider === 'nvidia';
    const model =
      usesCustomModel
        ? (provider.customModel ?? provider.model)
        : provider.provider === 'local'
          ? (provider.localModelName ?? '')
          : provider.model;
    const apiKey =
      provider.provider === 'local'
        ? (provider.localApiKey ?? '')
        : (provider.apiKey || getApiKey(provider.provider));
    const enableThinking = provider.provider === 'anthropic';
    const agentPromptContent = options.agentPrompt ?? userPrompt;
    // Root Cause vs Logic: instructions were leaking into the chat feed, so stored user messages stay concise and
    // we only merge the customization text while preparing the agent payload. The optional `agentPrompt` override
    // lets us deliver plan guidance without exposing it in the UI.
    const latestHistory = sessionWithPrompt.messages.map((message) => {
      if (message.role !== 'user') return message;
      const contentForAgent = message.id === userMessage.id ? agentPromptContent : message.content;
      return { ...message, content: appendInstructionToPrompt(contentForAgent, codeSpaceInstruction) };
    });
    let liveAssistantMessageId: string | null = null;
    let liveReasoningMessageId: string | null = null;
    const liveToolMessageIds = new Map<string, string>();

    // Fire-and-forget: auto-name the session on the first message, in parallel with the agent run.
    if (session.messages.length === 0 && session.title === 'New coding session') {
      void nameSessionAsync(
        session.id,
        userPrompt.slice(0, 100),
        {
          providerId: provider.provider,
          model,
          apiKey,
          endpoint: provider.provider === 'local' ? (provider.localBaseUrl ?? undefined) : provider.endpoint,
        },
        (id, title) => {
          // Re-check at patch time to avoid overwriting a manual rename that arrived
          // between submit and the LLM naming response.
          patchSession(id, (s) =>
            s.title === 'New coding session' || s.title === userPrompt.slice(0, 56)
              ? { ...s, title, updatedAt: Date.now() }
              : s,
          );
        },
        'code-space',
      );
    }

    const stringifyPreview = (value: unknown) => {
      try {
        const serialized = JSON.stringify(value, null, 1);
        return serialized.length > 240 ? `${serialized.slice(0, 240)}…` : serialized;
      } catch {
        return String(value);
      }
    };

    try {
      const response = await fetch('/api/code-space/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionWithPrompt.id,
          projectRoot: project.rootPath,
          projectName: project.name,
          messages: latestHistory,
          model,
          providerId: provider.provider,
          apiKey,
          endpoint: provider.provider === 'local' ? provider.localBaseUrl : provider.endpoint,
          localTemperature: provider.provider === 'local' ? provider.localTemperature : undefined,
          localContextLength: provider.provider === 'local' ? provider.localContextLength : undefined,
          openTabs,
          mode: requestedMode,
          toolBudget: sessionWithPrompt.toolBudget,
          // Confirm mode must always surface the accept/reject diff panel and never write to disk on
          // its own, so it runs the loop in suggest_only autonomy (edits become pending diff_proposed
          // events). Auto mode applies edits during the loop with checkpoints.
          autonomy: executionPolicyRef.current === 'auto' ? 'auto_safe_tools' : 'suggest_only',
          enableThinking,
          attachments: attachments.map((mention) => ({
            kind: mention.type,
            relativePath: mention.relativePath,
            displayName: mention.displayName,
          })),
        }),
        signal: abortCtrl.signal,
      });

      if (!response.body) {
        setAgentRunning(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event: AgentSSEEvent = JSON.parse(line.slice(6));
            if (event.type === 'diff_proposed') {
              const diff = buildPendingDiffFromEvent({
                diffId: event.diffId,
                filePath: event.filePath,
                oldContent: event.oldContent,
                newContent: event.newContent,
                deleted: event.deleted,
                explanation: event.explanation,
                unifiedDiff: event.unifiedDiff,
              });
              if (shouldAutoApplyCodeSpaceDiffs(executionPolicyRef.current, event.autoApplied)) {
                void applyPendingDiff(diff, { removeOnFailure: true });
              } else {
                // Upsert by stable diffId: a re-proposal for the same file carries the cumulative
                // original→latest diff, so replace the prior card instead of stacking stale baselines.
                setPendingDiffs((prev) => [...prev.filter((item) => item.diffId !== diff.diffId), diff]);
              }
            } else if (event.type === 'file_applied') {
              // The agent already wrote this file to disk during its loop. Do NOT re-apply;
              // just record it into the change ledger for the "Code changes" card + revert, and refresh git.
              const appliedAt = Date.now();
              setAgentChangesets((current) => [
                ...current.filter((item) => item.filePath !== event.filePath),
                {
                  filePath: event.filePath,
                  beforeContent: event.beforeContent,
                  afterContent: event.afterContent,
                  deleted: event.deleted,
                  acceptedAt: appliedAt,
                },
              ]);
              patchSession(sessionWithPrompt.id, (current) => ({
                ...current,
                filesChanged: Array.from(new Set([...current.filesChanged, event.filePath])),
                agentChangesets: [
                  ...current.agentChangesets.filter((item) => item.filePath !== event.filePath),
                  {
                    filePath: event.filePath,
                    beforeContent: event.beforeContent,
                    afterContent: event.afterContent,
                    deleted: event.deleted,
                    acceptedAt: appliedAt,
                  },
                ],
                updatedAt: Date.now(),
              }));
              if (activeProject) void refreshGitStatus(activeProject);
            } else if (event.type === 'agent_reasoning_delta') {
              if (!liveReasoningMessageId) {
                liveReasoningMessageId = nowId('msg');
                appendSessionMessage(sessionWithPrompt.id, {
                  id: liveReasoningMessageId,
                  role: 'reasoning',
                  content: event.delta,
                  createdAt: Date.now(),
                });
              } else {
                updateSessionMessage(sessionWithPrompt.id, liveReasoningMessageId, (message) => ({
                  ...message,
                  content: `${message.content}${event.delta}`,
                }));
              }
            } else if (event.type === 'tool_budget_warning') {
              appendSessionMessage(sessionWithPrompt.id, {
                id: nowId('msg'),
                role: 'system',
                content: `⚠ Approaching tool budget (${event.used}/${event.max}). The agent will try to converge.`,
                createdAt: Date.now(),
              });
            } else if (event.type === 'plan_markdown_created') {
              patchSession(sessionWithPrompt.id, (current) => ({
                ...current,
                planMarkdown: {
                  filePath: event.filePath,
                  content: event.content,
                  createdAt: Date.now(),
                },
                updatedAt: Date.now(),
              }));
            } else if (event.type === 'clarifying_questions_created') {
              patchSession(sessionWithPrompt.id, (current) => ({
                ...current,
                clarifyingQuestions: event.questions,
                updatedAt: Date.now(),
              }));
            } else if (event.type === 'diff_confirmation_required') {
              // Pre-validation diff gate: surface the full change set and pause until the user
              // confirms (run validation) or cancels (revert). Resolved via /api/code-space/runs/validate.
              setDiffConfirmation({
                sessionId: sessionWithPrompt.id,
                runId: event.runId,
                files: event.files,
                unifiedDiff: event.unifiedDiff,
                isGit: event.isGit,
                summary: event.summary,
              });
            } else if (event.type === 'knowledge_graph_ready') {
              patchSession(sessionWithPrompt.id, (current) => ({
                ...current,
                knowledgeGraph: {
                  projectId: event.projectId,
                  nodeCount: event.nodeCount,
                  edgeCount: event.edgeCount,
                  viewUrl: event.viewUrl,
                  reportPath: event.reportPath,
                  createdAt: Date.now(),
                },
                updatedAt: Date.now(),
              }));
            } else if (event.type === 'terminal_chunk') {
              setTerminalStream((prev) => prev + event.chunk);
            } else if (event.type === 'plan_created') {
              patchSession(sessionWithPrompt.id, (current) => ({
                ...current,
                plan: event.items,
                updatedAt: Date.now(),
              }));
            } else if (event.type === 'todo_created') {
              patchSession(sessionWithPrompt.id, (current) => ({
                ...current,
                todos: current.todos.some((todo) => todo.id === event.todo.id)
                  ? current.todos
                  : [...current.todos, event.todo],
                updatedAt: Date.now(),
              }));
            } else if (event.type === 'todo_updated') {
              patchSession(sessionWithPrompt.id, (current) => ({
                ...current,
                todos: current.todos.map((todo) => (todo.id === event.todoId ? { ...todo, done: event.done } : todo)),
                updatedAt: Date.now(),
              }));
            } else if (event.type === 'validation_result') {
              patchSession(sessionWithPrompt.id, (current) => ({
                ...current,
                verificationResults: [
                  ...current.verificationResults.filter((result) => result.id !== event.id),
                  {
                    id: event.id,
                    command: event.command,
                    status: event.status,
                    output: event.output,
                  },
                ],
                updatedAt: Date.now(),
              }));
              if (buildPlanPath) {
                if (event.status === 'failed') {
                  buildValidationFailed = true;
                  setPlanBuildStatus('failed');
                } else if (event.status === 'passed' || event.status === 'skipped') {
                  setPlanBuildStatus('completed');
                }
              }
            } else if (event.type === 'structured_event') {
              if (event.event.type === 'plan.updated') {
                const payload = event.event.payload as { phase?: string; state?: { status?: CodeSpaceAgentSession['runtimeStatus'] } };
                patchSession(sessionWithPrompt.id, (current) => ({
                  ...current,
                  runtimePhase: payload.phase ?? current.runtimePhase,
                  runtimeStatus: payload.state?.status ?? current.runtimeStatus,
                  status:
                    payload.phase === 'awaiting_patch_review'
                      ? 'waiting_review'
                      : payload.phase === 'validating'
                        ? 'checking'
                        : payload.phase === 'needs_review'
                          ? 'needs_review'
                          : payload.phase === 'verified'
                            ? 'verified'
                            : current.status,
                  updatedAt: Date.now(),
                }));
              } else if (event.event.type === 'run.completed') {
                const payload = event.event.payload as { status?: string; phase?: string };
                patchSession(sessionWithPrompt.id, (current) => ({
                  ...current,
                  runtimePhase: payload.phase ?? current.runtimePhase,
                  runtimeStatus:
                    payload.status === 'verified' || payload.status === 'needs_review' || payload.status === 'failed' || payload.status === 'cancelled'
                      ? payload.status
                      : current.runtimeStatus,
                  status: payload.status === 'verified' ? 'verified' : payload.status === 'needs_review' ? 'needs_review' : current.status,
                  updatedAt: Date.now(),
                }));
              }
            } else if (event.type === 'tool_start') {
              const toolMessageId = nowId('msg');
              liveToolMessageIds.set(event.toolCallId, toolMessageId);
              appendSessionMessage(sessionWithPrompt.id, {
                id: toolMessageId,
                role: 'tool',
                content: `Started ${event.tool}: ${stringifyPreview(event.input)}`,
                createdAt: Date.now(),
              });
              upsertSessionToolCall(sessionWithPrompt.id, {
                id: event.toolCallId,
                name: event.tool,
                status: 'running',
                summary: 'Running…',
                input: event.input,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              patchSession(sessionWithPrompt.id, (current) => ({
                ...current,
                toolCallCount: current.toolCallCount + 1,
                updatedAt: Date.now(),
              }));
            } else if (event.type === 'tool_result') {
              const existingMessageId = liveToolMessageIds.get(event.toolCallId);
              const toolContent = event.error
                ? `Error in ${event.tool}: ${event.error}`
                : `Finished ${event.tool}: ${stringifyPreview(event.output)}`;
              if (existingMessageId) {
                updateSessionMessage(sessionWithPrompt.id, existingMessageId, (message) => ({
                  ...message,
                  content: `${message.content}\n${toolContent}`,
                }));
              } else {
                appendSessionMessage(sessionWithPrompt.id, {
                  id: nowId('msg'),
                  role: 'tool',
                  content: toolContent,
                  createdAt: Date.now(),
                });
              }
              upsertSessionToolCall(sessionWithPrompt.id, {
                id: event.toolCallId,
                name: event.tool,
                status: event.error ? 'error' : 'success',
                summary: event.error ? event.error : `Completed in ${event.durationMs}ms`,
                output: event.error ? { error: event.error } : event.output,
                error: event.error,
                durationMs: event.durationMs,
              });
            } else if (event.type === 'text_delta') {
              if (!liveAssistantMessageId) {
                liveAssistantMessageId = nowId('msg');
                appendSessionMessage(sessionWithPrompt.id, {
                  id: liveAssistantMessageId,
                  role: 'assistant',
                  content: event.delta,
                  createdAt: Date.now(),
                });
              } else {
                updateSessionMessage(sessionWithPrompt.id, liveAssistantMessageId, (message) => ({
                  ...message,
                  content: `${message.content}${event.delta}`,
                }));
              }
            } else if (event.type === 'agent_done') {
              const summary = event.summary.trim();
              if (summary) {
                if (!liveAssistantMessageId) {
                  appendSessionMessage(sessionWithPrompt.id, {
                    id: nowId('msg'),
                    role: 'assistant',
                    content: summary,
                    createdAt: Date.now(),
                  });
                } else {
                  updateSessionMessage(sessionWithPrompt.id, liveAssistantMessageId, (message) => ({
                    ...message,
                    content: summary,
                  }));
                }
              }
              patchSession(sessionWithPrompt.id, (current) => ({
                ...current,
                status: 'finalized',
                updatedAt: Date.now(),
              }));
              if (buildPlanPath && !buildValidationFailed) {
                setPlanBuildStatus('completed');
              }
            } else if (event.type === 'agent_error') {
              appendSessionMessage(sessionWithPrompt.id, {
                id: nowId('msg'),
                role: 'system',
                content: `⚠ ${event.message}`,
                createdAt: Date.now(),
              });
              patchSession(sessionWithPrompt.id, (current) => ({
                ...current,
                status: 'blocked',
                updatedAt: Date.now(),
              }));
              setPlanBuildStatus('available');
            }
          } catch {
            // Ignore malformed SSE chunks.
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        appendSessionMessage(sessionWithPrompt.id, {
          id: nowId('msg'),
          role: 'system',
          content: `⚠ ${err.message}`,
          createdAt: Date.now(),
        });
        patchSession(sessionWithPrompt.id, (current) => ({
          ...current,
          status: 'blocked',
          updatedAt: Date.now(),
        }));
        setPlanBuildStatus('available');
      }
    } finally {
      setAgentRunning(false);
      agentAbortRef.current = null;
      runningSessionIdRef.current = null;
    }
  }, [
    activeProject,
    agentMode,
    appendSessionMessage,
    codeSpaceInstruction,
    ensureSession,
    openFile,
    patchSession,
    provider.apiKey,
    provider.customModel,
    provider.endpoint,
    provider.localApiKey,
    provider.localBaseUrl,
    provider.localContextLength,
    provider.localModelName,
    provider.localTemperature,
    provider.model,
    provider.provider,
    tabs,
    applyPendingDiff,
    updateSession,
    updateSessionMessage,
    upsertSessionToolCall,
  ]);

  // Resolve the pre-validation diff gate: confirm → run the detected validation/repair phase on the
  // applied workspace; cancel → revert every applied change. Streams the same SSE protocol as the run.
  const handleDiffDecision = useCallback(async (decision: 'confirm' | 'cancel') => {
    const gate = diffConfirmation;
    const project = activeProject;
    if (!gate || !project) {
      setDiffConfirmation(null);
      return;
    }
    const usesCustomModel = provider.provider === 'foundry' || provider.provider === 'deepseek' || provider.provider === 'nvidia';
    const model = usesCustomModel
      ? (provider.customModel ?? provider.model)
      : provider.provider === 'local'
        ? (provider.localModelName ?? '')
        : provider.model;
    const apiKey = provider.provider === 'local' ? (provider.localApiKey ?? '') : (provider.apiKey || getApiKey(provider.provider));
    const endpoint = provider.provider === 'local' ? provider.localBaseUrl : provider.endpoint;

    setDiffConfirmation(null);
    setAgentRunning(true);
    const abortCtrl = new AbortController();
    agentAbortRef.current = abortCtrl;
    runningSessionIdRef.current = gate.sessionId;
    patchSession(gate.sessionId, (current) => ({ ...current, status: decision === 'cancel' ? 'reviewing' : 'checking', updatedAt: Date.now() }));

    let liveAssistantMessageId: string | null = null;
    try {
      const response = await fetch('/api/code-space/runs/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: gate.runId,
          projectRoot: project.rootPath,
          projectName: project.name,
          model,
          providerId: provider.provider,
          apiKey,
          endpoint,
          decision,
        }),
        signal: abortCtrl.signal,
      });
      if (!response.body) {
        setAgentRunning(false);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event: AgentSSEEvent = JSON.parse(line.slice(6));
            if (event.type === 'validation_result') {
              patchSession(gate.sessionId, (current) => ({
                ...current,
                verificationResults: [
                  ...current.verificationResults.filter((result) => result.id !== event.id),
                  { id: event.id, command: event.command, status: event.status, output: event.output },
                ],
                updatedAt: Date.now(),
              }));
            } else if (event.type === 'file_applied') {
              const appliedAt = Date.now();
              setAgentChangesets((cur) => [
                ...cur.filter((item) => item.filePath !== event.filePath),
                { filePath: event.filePath, beforeContent: event.beforeContent, afterContent: event.afterContent, deleted: event.deleted, acceptedAt: appliedAt },
              ]);
              patchSession(gate.sessionId, (current) => ({
                ...current,
                filesChanged: Array.from(new Set([...current.filesChanged, event.filePath])),
                updatedAt: Date.now(),
              }));
              if (activeProject) void refreshGitStatus(activeProject);
            } else if (event.type === 'supervisor_verdict') {
              patchSession(gate.sessionId, (current) => ({ ...current, status: event.status === 'verified' ? 'verified' : 'needs_review', updatedAt: Date.now() }));
            } else if (event.type === 'structured_event') {
              if (event.event.type === 'plan.updated') {
                const payload = event.event.payload as { phase?: string };
                patchSession(gate.sessionId, (current) => ({ ...current, runtimePhase: payload.phase ?? current.runtimePhase, updatedAt: Date.now() }));
              } else if (event.event.type === 'run.completed') {
                const payload = event.event.payload as { status?: string; phase?: string };
                patchSession(gate.sessionId, (current) => ({
                  ...current,
                  runtimePhase: payload.phase ?? current.runtimePhase,
                  runtimeStatus:
                    payload.status === 'verified' || payload.status === 'needs_review' || payload.status === 'failed' || payload.status === 'cancelled'
                      ? payload.status
                      : current.runtimeStatus,
                  status: payload.status === 'verified' ? 'verified' : payload.status === 'needs_review' ? 'needs_review' : current.status,
                  updatedAt: Date.now(),
                }));
              } else if (event.event.type === 'file.reverted') {
                const payload = event.event.payload as { path?: string };
                if (payload.path) {
                  const reverted = payload.path;
                  setAgentChangesets((cur) => cur.filter((item) => item.filePath !== reverted));
                }
                if (activeProject) void refreshGitStatus(activeProject);
              }
            } else if (event.type === 'text_delta') {
              if (!liveAssistantMessageId) {
                liveAssistantMessageId = nowId('msg');
                appendSessionMessage(gate.sessionId, { id: liveAssistantMessageId, role: 'assistant', content: event.delta, createdAt: Date.now() });
              } else {
                updateSessionMessage(gate.sessionId, liveAssistantMessageId, (message) => ({ ...message, content: `${message.content}${event.delta}` }));
              }
            } else if (event.type === 'agent_done') {
              const summary = event.summary.trim();
              if (summary) {
                if (!liveAssistantMessageId) {
                  appendSessionMessage(gate.sessionId, { id: nowId('msg'), role: 'assistant', content: summary, createdAt: Date.now() });
                } else {
                  updateSessionMessage(gate.sessionId, liveAssistantMessageId, (message) => ({ ...message, content: summary }));
                }
              }
              patchSession(gate.sessionId, (current) => ({ ...current, status: 'finalized', updatedAt: Date.now() }));
              if (activeProject) void refreshGitStatus(activeProject);
            } else if (event.type === 'agent_error') {
              appendSessionMessage(gate.sessionId, { id: nowId('msg'), role: 'system', content: `⚠ ${event.message}`, createdAt: Date.now() });
              patchSession(gate.sessionId, (current) => ({ ...current, status: 'blocked', updatedAt: Date.now() }));
            }
          } catch {
            // Ignore malformed SSE chunks.
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        appendSessionMessage(gate.sessionId, { id: nowId('msg'), role: 'system', content: `⚠ ${err.message}`, createdAt: Date.now() });
      }
    } finally {
      setAgentRunning(false);
      agentAbortRef.current = null;
      runningSessionIdRef.current = null;
    }
  }, [
    activeProject,
    appendSessionMessage,
    diffConfirmation,
    patchSession,
    provider.apiKey,
    provider.customModel,
    provider.endpoint,
    provider.localApiKey,
    provider.localBaseUrl,
    provider.localModelName,
    provider.model,
    provider.provider,
    refreshGitStatus,
    updateSessionMessage,
  ]);

  useEffect(() => {
    if (executionPolicy !== 'auto' || pendingDiffs.length === 0) return;
    for (const diff of pendingDiffs) {
      void applyPendingDiff(diff, { removeOnFailure: true });
    }
  }, [applyPendingDiff, executionPolicy, pendingDiffs]);

  const handleCancelRun = useCallback(() => {
    agentAbortRef.current?.abort();
    setAgentRunning(false);
    if (runningSessionIdRef.current) {
      patchSession(runningSessionIdRef.current, (session) => ({
        ...session,
        status: 'blocked',
        updatedAt: Date.now(),
      }));
    }
  }, [patchSession]);

  const handleAgentModeChange = useCallback(
    (nextMode: CodeSpaceAgentMode) => {
      setAgentMode(nextMode);
      if (!activeSession) return;
      patchSession(activeSession.id, (session) => ({
        ...session,
        mode: nextMode,
        updatedAt: Date.now(),
      }));
    },
    [activeSession, patchSession],
  );

  // Root Cause vs Logic: The selector assumed the workspace would own execution policy state, so provide the missing handler so onChange is never undefined.
  const handleExecutionPolicyChange = useCallback((nextPolicy: CodeSpaceExecutionPolicy) => {
    setExecutionPolicy(nextPolicy);
  }, []);

  const acceptPendingDiff = useCallback(
    async (diffId: string) => {
      await acceptAllPendingHunks(diffId);
    },
    [acceptAllPendingHunks],
  );

  const rejectPendingDiff = useCallback(
    (diffId: string) => {
      rejectAllPendingHunks(diffId);
    },
    [rejectAllPendingHunks],
  );

  const openDiffFile = useCallback((filePath: string) => {
    if (!activeProject) return;
    void openFile(activeProject, filePath);
  }, [activeProject, openFile]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) {
        if (event.key === 'Escape') setModalOpen(false);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'b') {
        event.preventDefault();
        setLeftVisible((value) => !value);
      } else if (key === 'i') {
        event.preventDefault();
        setRightVisible((value) => !value);
      } else if (key === 's') {
        event.preventDefault();
        void saveActiveFile();
      } else if (key === '\\') {
        event.preventDefault();
        setBottomVisible((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [saveActiveFile]);

  const onEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor as Monaco.editor.IStandaloneCodeEditor;
    monacoRef.current = monaco;
    configureMonacoForCodeFiles(monaco);
    registerDslLanguage(monaco);
    monaco.editor.setTheme(theme === 'light' ? 'codoptic-light' : 'codoptic-dark');
  };

  const onEditorChange = (value?: string) => {
    if (!activeTab) return;
    const content = value ?? '';
    setFileContents((current) => ({
      ...current,
      [activeTab.id]: {
        ...(current[activeTab.id] ?? { path: activeTab.path, hash: activeTab.contentHash, modifiedAt: Date.now() }),
        content,
      },
    }));
    setTabs((current) => current.map((tab) => (tab.id === activeTab.id ? { ...tab, dirty: content !== fileContents[activeTab.id]?.content || tab.dirty } : tab)));
  };

  const routeToSystemDiagram = () => {
    if (!activeProject?.rootPath) return;
    writeUiPreference('repoPath', activeProject.rootPath);
    writeUiPreference('repoSourceType', activeProject.sourceType === 'github' ? 'github' : 'local');
    setMode('multi-layer');
  };

  const uploadPlanningZip = async (file: File) => {
    setZipSummary(null);
    setError(null);
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/code-space/plan-zip', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Planning zip validation failed');
        return;
      }
      const project = createCodeSpaceProject({
        name: file.name.replace(/\.zip$/i, ''),
        sourceType: 'zip',
        repoRef: file.name,
      });
      await addProject(project);
      const session = createSession(project.id, `Fresh start: ${project.name}`, 'fresh-start');
      const contextList = data.contextFiles?.map((entry: { path: string }) => `- ${entry.path}`).join('\n') ?? '';
      session.messages = [
        {
          id: nowId('msg'),
          role: 'system',
          content: `Fresh Start upload loaded ${data.planningFiles.length} planning file(s) and ${data.dslOrCodeFiles.length} DSL/code file(s).\n${contextList}`,
          createdAt: Date.now(),
        },
      ];
    session.plan = [
      'Read planning markdown first and extract acceptance criteria.',
      'Map DSL/code files to implementation tasks.',
      'Create scaffolding, components, routes, APIs, styling, tests, and docs required by the plan.',
      'Validate each TODO against the uploaded plan before marking it complete.',
    ];
    session.todos = session.plan.map((text, index) => ({ id: `fresh:${index}`, text, done: false }));
    updateSession(session);
    setActiveSessionId(session.id);
    setZipSummary(`Loaded ${data.planningFiles.length} planning file(s), ${data.dslOrCodeFiles.length} DSL/code file(s).`);
  };

  const renderTree = (project: CodeSpaceProject, folderPath = '', depth = 0) => {
    const key = `${project.id}:${folderPath}`;
    const nodes = treeChildren[key] ?? [];
    if (loadingTree[key]) {
      return <div className="px-3 py-1.5 text-[12px] text-ink-500">Loading folder…</div>;
    }
    return nodes
      .filter((node) => revealHidden || !isCodeSpaceHiddenPath(node.path))
      .filter((node) => !projectSearch || node.path.toLowerCase().includes(projectSearch.toLowerCase()))
      .map((node) => {
        const nodeKey = `${project.id}:${node.path}`;
        const isOpen = expanded[nodeKey];
        const isActive = activeTab?.projectId === project.id && activeTab.path === node.path;
        return (
          <div key={nodeKey}>
            <button
              type="button"
              aria-current={isActive ? 'true' : undefined}
              aria-expanded={node.type === 'dir' ? isOpen : undefined}
              onClick={() => {
                if (node.type === 'dir') {
                  setExpanded((current) => ({ ...current, [nodeKey]: !current[nodeKey] }));
                  if (!isOpen) void loadTree(project, node.path);
                } else {
                  void openFile(project, node.path);
                }
              }}
              className={`group flex h-6 w-full items-center gap-1 rounded-sm pr-2 text-left text-[12px] ${
                isActive ? 'bg-[#37373d] text-[#d4d4d4]' : 'text-[#b9b9b9] hover:bg-[#2a2d2e]'
              }`}
              style={{ paddingLeft: 8 + depth * 14 }}
              title={node.path}
            >
              {node.type === 'dir' ? (
                isOpen ? <ChevronDown size={13} className="text-ink-500" /> : <ChevronRight size={13} className="text-ink-500" />
              ) : (
                <span className="w-[13px]" />
              )}
              {node.type === 'dir' ? (
                isOpen ? <FolderOpen size={14} className="text-accent-warm" /> : <Folder size={14} className="text-accent-warm/80" />
              ) : (
                fileIcon(node.path)
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {node.hidden && <span className="rounded bg-ink-800 px-1 text-[9px] text-ink-500">hidden</span>}
            </button>
            {node.type === 'dir' && isOpen && renderTree(project, node.path, depth + 1)}
          </div>
        );
      });
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !monacoRef.current || !activeTab) return;
    const diff = pendingDiffs.find((item) => item.filePath === activeTab.path);
    const changedLines = extractChangedLineNumbers(diff?.unifiedDiff);
    const decorations = changedLines.map((line) => ({
      range: new monacoRef.current!.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: 'code-space-diff-added-line',
        glyphMarginClassName: 'code-space-diff-glyph',
      },
    }));
    diffDecorationIdsRef.current = editor.deltaDecorations(diffDecorationIdsRef.current, decorations);
    return () => {
      diffDecorationIdsRef.current = editor.deltaDecorations(diffDecorationIdsRef.current, []);
    };
  }, [activeTab, pendingDiffs]);

  const activeContent = activeTab ? fileContents[activeTab.id]?.content ?? '' : '';
  const activeTabProject = activeTab ? projects.find((project) => project.id === activeTab.projectId) ?? activeProject : null;
  const activeTabPayload = activeTab ? fileContents[activeTab.id] : null;
  const activeTabIsLoading = activeTab ? loadingFileIdsRef.current.has(activeTab.id) : false;
  const activePendingDiff = activeTab ? pendingDiffs.find((item) => item.filePath === activeTab.path) ?? null : null;
  const activePendingDiffCounts = activePendingDiff ? countDiffLines(activePendingDiff.unifiedDiff, activePendingDiff.hunks) : null;
  const breadcrumbs = activeProject && activeTab ? [activeProject.name, ...activeTab.path.split('/').filter(Boolean)] : [];
  // Motivation vs Logic: showing a quick snapshot of the root entries keeps the preview actionable before any file is opened.
  const activeProjectPreviewKey = activeProject ? `${activeProject.id}:` : '';
  const activeProjectPreviewNodes = activeProjectPreviewKey ? treeChildren[activeProjectPreviewKey] ?? [] : [];
  const activeProjectPreviewLoading = activeProjectPreviewKey ? Boolean(loadingTree[activeProjectPreviewKey]) : false;
  const activeProjectPreviewSnapshot = activeProjectPreviewNodes.slice(0, 5);

  // Root Cause vs Logic: after a refresh, the tab list can rehydrate before its file payload does, which left Monaco mounted against an empty string until the user reselected the file. We restore the file payload as soon as the active tab is known so the editor always comes back with the real content instead of a blank surface.
  useEffect(() => {
    if (!activeTab || !activeTabProject?.rootPath) return;
    if (fileContentsRef.current[activeTab.id]) return;
    void ensureFileContent(activeTabProject, activeTab);
  }, [activeTab, activeTabProject, ensureFileContent]);

  return (
    <main className="code-space-workbench flex min-h-0 flex-1 overflow-hidden bg-[#181818] text-[#d4d4d4]">
      {leftVisible && (
        <aside className="flex min-h-0 shrink-0 border-r border-[#2a2a2a] bg-[#151515]" style={{ width: leftWidth }}>
          <div className="flex w-11 flex-col items-center gap-2 border-r border-[#2a2a2a] bg-[#181818] py-3">
            <button className="rounded-md bg-[#37373d] p-2 text-[#d4d4d4]" type="button" title="Explorer">
              <Folder size={17} />
            </button>
            <button className="rounded-md p-2 text-[#8b8b8b] hover:bg-[#2a2d2e]" type="button" title="Search">
              <Search size={17} />
            </button>
            <button className="rounded-md p-2 text-[#8b8b8b] hover:bg-[#2a2d2e]" type="button" title="Source Control">
              <GitBranch size={17} />
            </button>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-9 items-center justify-between border-b border-[#2a2a2a] px-3 text-[11px] font-semibold uppercase tracking-wider text-[#cccccc]">
              Explorer
              <div className="flex items-center gap-1">
                <button type="button" title="Create file" onClick={createFile} disabled={!activeProject} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e] disabled:opacity-40">
                  <File size={13} />
                </button>
                <button type="button" title="Create folder" onClick={createFolder} disabled={!activeProject} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e] disabled:opacity-40">
                  <Folder size={13} />
                </button>
                <button type="button" title="Refresh tree" onClick={() => activeProject && void loadTree(activeProject, '')} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]">
                  <RefreshCw size={13} />
                </button>
                <button type="button" title="Collapse all" onClick={() => setExpanded({})} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]">
                  <X size={13} />
                </button>
              </div>
            </div>
            <div className="space-y-3 border-b border-[#2a2a2a] p-3">
              <input value={projectSearch} onChange={(e) => setProjectSearch(e.target.value)} placeholder="Search in project" className="h-8 w-full rounded border border-[#2a2a2a] bg-[#1e1e1e] px-2 text-[12px] outline-none focus:border-accent/70" />
              <div className="space-y-3">
                <div className="space-y-1 text-[11px] text-[#8b8b8b]">
                  <div className="uppercase tracking-wider">Enter path manually</div>
                  <input value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="/path/to/repo" className="h-8 w-full rounded border border-[#2a2a2a] bg-[#1e1e1e] px-2 font-mono text-[11px]" />
                  <button type="button" onClick={() => void handleManualOpen()} className="w-full rounded border border-[#2a2a2a] bg-[#252526] px-2 py-1.5 text-[11px] hover:bg-[#2a2d2e]">Open Path</button>
                </div>
                <div className="space-y-1 text-[11px] text-[#8b8b8b]">
                  <div className="uppercase tracking-wider">Clone GitHub</div>
                  <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/repo" className="h-8 w-full rounded border border-[#2a2a2a] bg-[#1e1e1e] px-2 font-mono text-[11px]" />
                  <button type="button" onClick={() => void cloneGithubProject()} className="w-full rounded border border-accent/40 bg-accent/15 px-2 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent/25">Clone GitHub</button>
                </div>
              </div>
              <label className="flex items-center gap-2 text-[11px] text-[#8b8b8b]">
                <input type="checkbox" checked={revealHidden} onChange={(e) => setRevealHidden(e.target.checked)} />
                Reveal hidden/generated folders
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1">
              {projects.length === 0 ? (
                <div className="m-3 rounded border border-dashed border-[#37373d] p-4 text-[12px] text-[#8b8b8b]">
                  Open a local path or clone GitHub to start.
                </div>
              ) : (
                projects.map((project) => {
                  const isActiveProject = project.id === activeProjectId;
                  const isOpen = expanded[project.id] ?? isActiveProject;
                  return (
                <div key={project.id} className="mb-1">
                  <div className="relative group">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => {
                        setActiveProjectId(project.id);
                        setExpanded((current) => ({ ...current, [project.id]: !isOpen }));
                      }}
                      className={`flex h-8 w-full items-center gap-1 rounded px-2 pr-16 text-left text-[12px] ${isActiveProject ? 'bg-[#37373d] text-[#d4d4d4]' : 'text-[#cccccc] hover:bg-[#2a2d2e]'}`}
                    >
                      {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <Box size={14} className={project.sourceType === 'github' ? 'text-accent-cool' : 'text-accent-warm'} />
                      <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
                      <span className="rounded bg-[#252526] px-1.5 py-0.5 text-[9px] uppercase text-[#8b8b8b]">{project.sourceType}</span>
                    </button>
                    <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 pointer-events-none">
                      <button
                        type="button"
                        title="Rename project"
                        onClick={(event) => {
                          event.stopPropagation();
                          void promptProjectRename(project);
                        }}
                        className="pointer-events-auto rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        title="Delete project"
                        onClick={(event) => {
                          event.stopPropagation();
                          setProjectToDelete(project);
                        }}
                        className="pointer-events-auto rounded p-1 text-red-400 hover:bg-red-500/10"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <>
                      <div className="ml-7 flex gap-2 py-1 text-[10px] text-[#8b8b8b]">
                        <span>{project.git?.branch ?? project.branch ?? 'no branch'}</span>
                        <span>{project.git?.changedFiles ?? 0} changed</span>
                      </div>
                      {renderTree(project)}
                    </>
                  )}
                </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>
      )}

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[35px] items-center border-b border-[#2a2a2a] bg-[#1e1e1e]">
          <button type="button" onClick={() => setLeftVisible((value) => !value)} className="mx-1 rounded p-1.5 text-[#8b8b8b] hover:bg-[#2a2d2e]" title="Toggle explorer (Cmd/Ctrl+B)">
            <PanelLeft size={15} />
          </button>
          <div className="flex min-w-0 flex-1 overflow-x-auto">
            {tabs.map((tab) => (
              <button key={tab.id} type="button" onClick={() => setActiveTabId(tab.id)} className={`group flex h-[35px] max-w-52 items-center gap-2 border-r border-[#2a2a2a] px-3 text-[12px] ${activeTabId === tab.id ? 'bg-[#1e1e1e] text-[#d4d4d4]' : 'bg-[#181818] text-[#8b8b8b] hover:bg-[#2a2d2e]'}`}>
                {fileIcon(tab.path)}
                <span className="truncate">{basename(tab.path)}</span>
                {tab.dirty && <span className="h-2 w-2 rounded-full bg-accent" />}
                <span
                  onClick={(event) => {
                    event.stopPropagation();
                    setTabs((current) => current.filter((item) => item.id !== tab.id));
                    if (activeTabId === tab.id) setActiveTabId(null);
                    void deleteCodeSpaceTab(tab.id);
                  }}
                  className="rounded p-0.5 opacity-0 hover:bg-[#37373d] group-hover:opacity-100"
                >
                  <X size={12} />
                </span>
              </button>
            ))}
          </div>
          <CodeSpaceTabActions
            activeTab={activeTab}
            onSave={saveActiveFile}
            onRename={renameActiveFile}
            onDuplicate={duplicateActiveFile}
            onDelete={deleteActiveFile}
            onTogglePreview={toggleActiveTabPreview}
          />
          <button type="button" onClick={() => setRightVisible((value) => !value)} className="mx-1 rounded p-1.5 text-[#8b8b8b] hover:bg-[#2a2d2e]" title="Toggle agent (Cmd/Ctrl+I)">
            <PanelRight size={15} />
          </button>
        </div>

        <div className="flex h-7 items-center gap-1 border-b border-[#2a2a2a] bg-[#181818] px-3 text-[11px] text-[#8b8b8b]">
          {breadcrumbs.length ? breadcrumbs.map((crumb, index) => (
            <span key={`${crumb}-${index}`} className={index === breadcrumbs.length - 1 ? 'text-[#cccccc]' : ''}>
              {index > 0 && <span className="mx-1 text-[#555]">/</span>}
              {crumb}
            </span>
          )) : <span>No file selected</span>}
          {activePendingDiff && activePendingDiffCounts ? (
            <span className="ml-auto inline-flex items-center gap-2 text-[10px]">
              <span className="text-[#3fb950]">+{activePendingDiffCounts.added}</span>
              <span className="text-[#f85149]">-{activePendingDiffCounts.removed}</span>
              <span className="rounded border border-[#30363d] px-1.5 py-0.5 uppercase tracking-wider text-[#79c0ff]">
                {activePendingDiff.hunks.length} patch{activePendingDiff.hunks.length === 1 ? '' : 'es'}
              </span>
            </span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 bg-[#1e1e1e]">
          {activeTab ? (
            activeTabPayload ? (
              activePendingDiff ? (
                <InlinePatchReview
                  filePath={activeTab.path}
                  language={activeTab.language}
                  theme={theme === 'light' ? 'codoptic-light' : 'codoptic-dark'}
                  diff={activePendingDiff}
                  minimapEnabled={minimapEnabled}
                  wordWrap={wordWrap}
                  onAcceptHunk={(hunkId) => void acceptPendingHunk(activePendingDiff.diffId, hunkId)}
                  onRejectHunk={(hunkId) => rejectPendingHunk(activePendingDiff.diffId, hunkId)}
                  onAcceptAll={() => void acceptAllPendingHunks(activePendingDiff.diffId)}
                  onRejectAll={() => rejectAllPendingHunks(activePendingDiff.diffId)}
                  onEditorMount={(_, monaco) => {
                    monacoRef.current = monaco;
                  }}
                />
              ) : activeTab.language === 'markdown' && activeTab.preview ? (
                activeTabProject ? (
                  <CodeSpaceMarkdownPreview
                    project={activeTabProject}
                    filePath={activeTab.path}
                    markdown={activeContent}
                    theme={theme}
                    onOpenFile={(filePath, options) => {
                      if (!activeTabProject) return;
                      void openFile(activeTabProject, filePath, options);
                    }}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-[#8b8b8b]">
                    {activeTabIsLoading ? 'Loading file…' : 'Restoring file…'}
                  </div>
                )
              ) : (
                <Editor
                  height="100%"
                  theme={theme === 'light' ? 'codoptic-light' : 'codoptic-dark'}
                  language={activeTab.language}
                  path={`${activeTab.projectId}/${activeTab.path}`}
                  value={activeContent}
                  onChange={onEditorChange}
                  onMount={onEditorMount}
                  options={{
                    readOnly: activeTab.path.includes('/generated/'),
                    minimap: { enabled: minimapEnabled },
                    wordWrap: wordWrap ? 'on' : 'off',
                    fontSize: 13,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    lineNumbers: 'on',
                    folding: true,
                    bracketPairColorization: { enabled: true },
                    guides: { indentation: true, bracketPairs: true },
                    renderWhitespace: 'selection',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                  }}
                />
              )
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[#8b8b8b]">
                {activeTabIsLoading ? 'Loading file…' : 'Restoring file…'}
              </div>
            )
          ) : activeProject ? (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-3xl rounded-xl border border-[#2a2a2a] bg-[#181818] p-6 shadow-2xl">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Code2 className="text-accent" size={30} />
                    <h2 className="text-lg font-semibold text-[#d4d4d4]">Project Preview</h2>
                    <p className="text-sm text-[#8b8b8b]">Preview the root folder before opening files or running tasks.</p>
                  </div>
                  <div className="text-xs uppercase tracking-wider text-[#6b6b6b]">{basename(activeProject.rootPath ?? activeProject.name)}</div>
                </div>
                <div className="mt-4 space-y-4 text-left">
                  <div className="space-y-1">
                    <label className="text-[12px] font-semibold text-[#bfbfbf]">Root folder name</label>
                    <input
                      value={projectNameInput}
                      onChange={(e) => setProjectNameInput(e.target.value)}
                      onBlur={() => void commitProjectRename()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void commitProjectRename();
                        }
                      }}
                    disabled={renamingProjectId === activeProject?.id}
                      className="w-full rounded border border-[#2a2a2a] bg-[#121212] px-3 py-2 text-sm outline-none transition focus:border-accent/60"
                    />
                    <p className="text-[11px] text-[#6b6b6b]">Press Enter or leave the field to rename the folder on disk.</p>
                  </div>
                  <div className="space-y-2">
                    <div className="text-[11px] uppercase tracking-wider text-[#8b8b8b]">Preview</div>
                    {activeProjectPreviewLoading ? (
                      <div className="text-[12px] text-[#8b8b8b]">Loading preview…</div>
                    ) : activeProjectPreviewSnapshot.length ? (
                      <div className="space-y-1">
                        {activeProjectPreviewSnapshot.map((node) => (
                          <div key={node.path} className="flex items-center gap-2 rounded border border-[#2a2a2a] bg-[#1e1e1e] px-3 py-1 text-[12px] text-[#d4d4d4]">
                            {node.type === 'dir' ? <Folder size={14} className="text-accent-warm" /> : <File size={14} className="text-ink-400" />}
                            <span className="flex-1 truncate">{node.name}</span>
                            <span className="text-[10px] text-[#6d6d6d]">{node.type}</span>
                          </div>
                        ))}
                        {activeProjectPreviewNodes.length > activeProjectPreviewSnapshot.length && (
                          <div className="text-[11px] text-[#8b8b8b]">And {activeProjectPreviewNodes.length - activeProjectPreviewSnapshot.length} more item(s)…</div>
                        )}
                      </div>
                    ) : (
                      <div className="text-[11px] text-[#8b8b8b]">The folder looks empty—add files to see them here.</div>
                    )}
                  </div>
                  <div className="text-[11px] text-[#8b8b8b]">
                    Root path: <span className="font-mono text-[11px] text-[#d4d4d4]">{activeProject.rootPath ?? 'Unknown'}</span>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {/* Commented buttons hide the quick actions from the preview. */}
                    {/*
                    <button type="button" onClick={() => setLeftVisible(true)} className="rounded border border-[#2a2a2a] bg-[#252526] px-3 py-1.5 text-[11px] text-[#d4d4d4]">Show Explorer</button>
                    <button type="button" onClick={() => activeProject && void loadTree(activeProject, '')} className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent/25">Refresh Preview</button>
                    */}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-2xl rounded-xl border border-[#2a2a2a] bg-[#181818] p-7 text-center">
                <Wand2 className="mx-auto mb-3 text-accent" size={34} />
                <h2 className="text-xl font-semibold">Open a project to enter Code Space</h2>
                <p className="mt-2 text-sm text-[#8b8b8b]">Use Explorer to open a local folder, clone from GitHub, or start from Fresh Start.</p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <button type="button" onClick={() => setModalOpen(true)} className="rounded border border-accent/40 bg-accent/15 px-4 py-2 text-sm font-semibold text-accent">Fresh Start</button>
                  <button type="button" onClick={openFolderBrowser} className="rounded border border-[#2a2a2a] bg-[#252526] px-4 py-2 text-sm">Open Path</button>
                  <button type="button" onClick={() => void promptToCloneGithub()} className="rounded border border-[#2a2a2a] bg-[#252526] px-4 py-2 text-sm">Clone GitHub</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {bottomVisible && (
          <BottomPanel
            activeSession={activeSession}
            bottomActiveTab={bottomActiveTab}
            error={error}
            minimapEnabled={minimapEnabled}
            onToggleMinimap={() => setMinimapEnabled((value) => !value)}
            wordWrap={wordWrap}
            onToggleWordWrap={() => setWordWrap((value) => !value)}
            onTabChange={(tab) => setBottomActiveTab(tab)}
            onHide={() => setBottomVisible(false)}
            projectName={activeProject?.name ?? 'No project'}
            projectRoot={activeProject?.rootPath ?? undefined}
          />
        )}
      </section>

      {rightVisible && (
        <aside className="flex min-h-0 shrink-0 flex-col border-l border-[#2a2a2a] bg-[#181818]" style={{ width: rightWidth }}>
          <AgentPanel
            session={activeSession}
            sessions={sessions.filter((session) => !session.projectId || session.projectId === activeProjectId)}
            activeProjectName={activeProject?.name}
            isRunning={agentRunning}
            toolBudget={activeSession?.toolBudget ?? 50}
            pendingDiffs={pendingDiffs}
            appliedDiffs={agentChangesets}
            providerSummary={`${provider.provider}/${
              provider.provider === 'foundry' || provider.provider === 'deepseek' || provider.provider === 'nvidia'
                ? provider.customModel ?? provider.model
                : provider.model
            }`}
            agentMode={agentMode}
            executionPolicy={executionPolicy}
            onExecutionPolicyChange={handleExecutionPolicyChange}
            onOpenModelConfig={() => setProviderConfigOpen(true)}
            onGenerateDiagram={routeToSystemDiagram}
            onOpenAppPlanner={() => setMode('custom-prompt')}
            onAgentModeChange={handleAgentModeChange}
            canGenerateDiagram={!!activeProject}
            onOpenPlanFile={openPlanFile}
            onOpenKnowledgeGraph={() => setKnowledgeGraphModalOpen(true)}
            onSelectSession={(sessionId) => setActiveSessionId((current) => (current === sessionId ? null : sessionId))}
            onRenameSession={renameSession}
            onDeleteSession={(session) => removeSessionRecord(session)}
            onSubmitPrompt={handleRunAgent}
            onCancelRun={handleCancelRun}
            onAcceptDiff={(diffId) => void acceptPendingDiff(diffId)}
            onRejectDiff={rejectPendingDiff}
            onOpenDiffFile={openDiffFile}
            mentionIndex={mentionIndexHook.index}
            indexStatus={mentionIndexHook.status}
            indexError={mentionIndexHook.error}
            openFiles={tabs.map((tab) => tab.path).filter(Boolean)}
            currentEditorFilePath={activeTab?.path}
            filePaths={flatFilePaths}
          />
          </aside>
      )}

      {diffConfirmation && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-[#2a2a2a] bg-[#181818] shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-[#2a2a2a] p-5">
              <div>
                <h2 className="text-lg font-semibold">Review changes before validation</h2>
                <p className="mt-1 text-[12px] text-[#8b8b8b]">
                  {diffConfirmation.files.length} file(s) changed · diff source:{' '}
                  {diffConfirmation.isGit ? 'git' : 'in-memory change ledger (no git repo)'}. Confirm to run the project&apos;s
                  detected validation, or cancel to revert every change.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleDiffDecision('cancel')}
                className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]"
                aria-label="Cancel and revert"
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-5">
              <ul className="mb-3 flex flex-wrap gap-2">
                {diffConfirmation.files.map((file) => (
                  <li
                    key={file.path}
                    className="rounded border border-[#2a2a2a] bg-[#202020] px-2 py-1 text-[11px] text-[#d4d4d4]"
                  >
                    {file.deleted ? '🗑 ' : ''}
                    {file.path}
                  </li>
                ))}
              </ul>
              <pre className="overflow-auto rounded-lg border border-[#2a2a2a] bg-[#0f0f0f] p-3 text-[11px] leading-relaxed text-[#cccccc]">
                {(diffConfirmation.unifiedDiff || '(no textual diff available)')
                  .split('\n')
                  .map((line, index) => (
                    <span
                      key={index}
                      className={
                        line.startsWith('+') && !line.startsWith('+++')
                          ? 'block text-[#6ccf6c]'
                          : line.startsWith('-') && !line.startsWith('---')
                            ? 'block text-[#e06c6c]'
                            : line.startsWith('@@')
                              ? 'block text-[#6c9ce0]'
                              : 'block'
                      }
                    >
                      {line || ' '}
                    </span>
                  ))}
              </pre>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[#2a2a2a] p-4">
              <button
                type="button"
                onClick={() => void handleDiffDecision('cancel')}
                className="rounded border border-[#2a2a2a] bg-[#252526] px-3 py-1.5 text-[13px] text-[#d4d4d4] hover:bg-[#2a2d2e]"
              >
                Cancel &amp; revert
              </button>
              <button
                type="button"
                onClick={() => void handleDiffDecision('confirm')}
                className="rounded bg-[#2d6cdf] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[#3a78e8]"
              >
                Confirm &amp; validate
              </button>
            </div>
          </div>
        </div>
      )}

      {knowledgeGraphModalOpen && activeSession?.knowledgeGraph && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setKnowledgeGraphModalOpen(false);
          }}
        >
          <div className="flex h-[88vh] w-full max-w-6xl flex-col rounded-xl border border-[#2a2a2a] bg-[#181818] shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-[#2a2a2a] p-4">
              <div>
                <h2 className="text-lg font-semibold">Knowledge graph</h2>
                <p className="mt-1 text-[12px] text-[#8b8b8b]">
                  {activeSession.knowledgeGraph.nodeCount} files · {activeSession.knowledgeGraph.edgeCount} import edges · interactive
                  Graphify map of this project. Red-bordered nodes are central modules.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setKnowledgeGraphModalOpen(false)}
                className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]"
              >
                <X size={16} />
              </button>
            </div>
            <iframe
              title="Knowledge graph"
              src={activeSession.knowledgeGraph.viewUrl}
              className="min-h-0 flex-1 rounded-b-xl border-0 bg-[#0f1115]"
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        </div>
      )}

      {folderBrowserOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeFolderBrowser();
          }}
        >
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-[#2a2a2a] bg-[#181818] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Open local folder</h2>
                <p className="mt-1 text-[12px] text-[#8b8b8b]">
                  Browse your machine&apos;s filesystem and pick a project root. The selected absolute path is used directly—no upload prompt required.
                </p>
              </div>
              <button type="button" onClick={closeFolderBrowser} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]">
                <X size={16} />
              </button>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                title="Up one level"
                onClick={() => {
                  const next = folderBrowserParent.split('/').slice(0, -1).filter(Boolean).join('/');
                  void loadFolderBrowserEntries(folderBrowserRoot, next);
                }}
                disabled={folderBrowserLoading || !folderBrowserParent}
                className="rounded border border-[#2a2a2a] bg-[#252526] p-1.5 text-[#d4d4d4] hover:bg-[#2a2d2e] disabled:opacity-40"
              >
                <ChevronLeft size={14} />
              </button>
              <input
                value={folderBrowserManualPath}
                onChange={(event) => setFolderBrowserManualPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    const next = folderBrowserManualPath.trim();
                    if (!next) return;
                    void loadFolderBrowserEntries(next, '');
                  }
                }}
                placeholder="/absolute/path/to/folder"
                className="h-8 w-full rounded border border-[#2a2a2a] bg-[#1e1e1e] px-2 font-mono text-[11px] outline-none focus:border-accent/70"
              />
              <button
                type="button"
                onClick={() => {
                  const next = folderBrowserManualPath.trim();
                  if (!next) return;
                  void loadFolderBrowserEntries(next, '');
                }}
                className="rounded border border-[#2a2a2a] bg-[#252526] px-3 py-1.5 text-[11px] hover:bg-[#2a2d2e]"
              >
                Go
              </button>
            </div>
            <div className="mt-2 flex items-center gap-1 text-[11px] text-[#8b8b8b]">
              <span className="uppercase tracking-wider">Root</span>
              <span className="font-mono text-[11px] text-[#d4d4d4]">{folderBrowserRoot || '—'}</span>
              {folderBrowserParent && (
                <>
                  <span className="text-[#555]">/</span>
                  <span className="font-mono text-[11px] text-[#d4d4d4]">{folderBrowserParent}</span>
                </>
              )}
            </div>
            <div className="mt-3 min-h-[200px] flex-1 overflow-y-auto rounded border border-[#2a2a2a] bg-[#0f0f0f]">
              {folderBrowserLoading ? (
                <div className="p-4 text-[12px] text-[#8b8b8b]">Loading…</div>
              ) : folderBrowserError ? (
                <div className="p-4 text-[12px] text-red-300">{folderBrowserError}</div>
              ) : folderBrowserEntries.length === 0 ? (
                <div className="p-4 text-[12px] text-[#8b8b8b]">This folder is empty.</div>
              ) : (
                <ul className="divide-y divide-[#1f1f1f]">
                  {folderBrowserEntries.map((entry) => (
                    <li key={`${entry.type}:${entry.path}`}>
                      <button
                        type="button"
                        onClick={() => {
                          if (entry.type !== 'dir') return;
                          void loadFolderBrowserEntries(folderBrowserRoot, entry.path);
                        }}
                        disabled={entry.type !== 'dir'}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-[#1a1a1a] ${entry.type === 'dir' ? 'text-[#d4d4d4]' : 'cursor-default text-[#8b8b8b]'}`}
                      >
                        {entry.type === 'dir' ? (
                          <Folder size={14} className="text-accent-warm" />
                        ) : (
                          <File size={14} className="text-ink-400" />
                        )}
                        <span className="flex-1 truncate">{entry.name}</span>
                        <span className="text-[10px] uppercase tracking-wider text-[#6d6d6d]">{entry.type}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <span className="mr-auto text-[11px] text-[#8b8b8b]">
                Opens the folder currently shown above as a Code Space project.
              </span>
              <button
                type="button"
                onClick={closeFolderBrowser}
                className="rounded border border-[#2a2a2a] bg-[#252526] px-3 py-1.5 text-[12px] hover:bg-[#2a2d2e]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const root = folderBrowserRoot;
                  const parent = folderBrowserParent;
                  const absolute = parent ? `${root.replace(/\/+$/, '')}/${parent}` : root;
                  void handleFolderBrowserSelect(absolute);
                }}
                disabled={folderBrowserLoading || (!folderBrowserRoot && !folderBrowserParent)}
                className="rounded border border-accent/40 bg-accent/20 px-3 py-1.5 text-[12px] font-semibold text-accent hover:bg-accent/30 disabled:opacity-40"
              >
                Open this folder
              </button>
            </div>
          </div>
        </div>
      )}
      {modalOpen && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setModalOpen(false); }}>
          <div className="w-full max-w-lg rounded-xl border border-[#2a2a2a] bg-[#181818] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Fresh Start</h2>
                <p className="mt-1 text-sm text-[#8b8b8b]">Upload the planning zip generated from Custom App, or brainstorm a new app there first.</p>
              </div>
              <button type="button" onClick={() => setModalOpen(false)} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]"><X size={16} /></button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="cursor-pointer rounded-lg border border-accent/40 bg-accent/10 p-4 hover:bg-accent/20">
                <Upload className="mb-2 text-accent" size={22} />
                <div className="font-semibold">Upload Zip</div>
                <div className="mt-1 text-xs text-[#8b8b8b]">Validates planning/instruction markdown plus DSL/code files and starts a fresh-build session.</div>
                <input type="file" accept=".zip" className="hidden" onChange={(e) => e.target.files?.[0] && void uploadPlanningZip(e.target.files[0])} />
              </label>
              <button type="button" onClick={() => { setModalOpen(false); setMode('custom-prompt'); }} className="rounded-lg border border-[#2a2a2a] bg-[#252526] p-4 text-left hover:bg-[#2a2d2e]">
                <Sparkles className="mb-2 text-accent-warm" size={22} />
                <div className="font-semibold">Brainstorm App</div>
                <div className="mt-1 text-xs text-[#8b8b8b]">Go to Custom App and choose instruction/planning mode so the generated zip includes an app-planning .md file plus all DSL code files.</div>
              </button>
            </div>
            {zipSummary && <div className="mt-4 rounded border border-green-400/40 bg-green-400/10 p-3 text-sm text-green-200">{zipSummary}</div>}
            {error && <details className="mt-4 rounded border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-200"><summary>Upload or workspace error</summary><div className="mt-2 whitespace-pre-wrap font-mono text-xs">{error}</div></details>}
          </div>
        </div>
      )}
      {projectToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setProjectToDelete(null);
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-[#2a2a2a] bg-[#181818] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Delete project</h2>
                <p className="mt-1 text-sm text-[#8b8b8b]">
                  This removes <span className="font-semibold text-[#d4d4d4]">{projectToDelete.name}</span> from disk permanently.
                </p>
              </div>
              <button type="button" onClick={() => setProjectToDelete(null)} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]">
                <X size={16} />
              </button>
            </div>
            <div className="mt-4 text-[11px] text-[#8b8b8b]">
              <div>Project root:</div>
              <div className="font-mono text-[11px] text-[#d4d4d4]">{projectToDelete.rootPath ?? 'Unknown'}</div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setProjectToDelete(null)} className="rounded border border-[#2a2a2a] bg-[#252526] px-4 py-2 text-sm hover:bg-[#2a2d2e]">
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmProjectDeletion}
                disabled={isDeletingProject}
                className="rounded bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {isDeletingProject ? 'Deleting…' : 'Delete project'}
              </button>
            </div>
          </div>
        </div>
      )}
      <CodeSpaceWorkspaceEnhancements />
      <SessionRenameDialog
        open={!!sessionRenameTarget}
        currentName={sessionRenameInput}
        onChange={setSessionRenameInput}
        onSave={handleSessionRenameSave}
        onCancel={handleSessionRenameCancel}
      />
      {appDialogs}
      {providerConfigOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setProviderConfigOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-[#2a2a2a] bg-[#181818] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Model Configs</h2>
                <p className="mt-1 text-sm text-[#8b8b8b]">Choose or validate the AI provider you want this session to use.</p>
              </div>
              <button type="button" onClick={() => setProviderConfigOpen(false)} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]"><X size={16} /></button>
            </div>
            <div className="mt-4">
              <ProviderConfig />
            </div>
            <div className="mt-4 rounded-xl border border-[#2a2a2a] bg-[#111111] p-3">
              <label htmlFor="code-space-instruction" className="block text-[10px] uppercase tracking-widest text-[#8b8b8b]">
                Instruction
              </label>
              <textarea
                id="code-space-instruction"
                value={codeSpaceInstruction}
                onChange={(event) => setCodeSpaceInstruction(event.target.value)}
                placeholder="Add your coding preferences, constraints, or style notes here."
                rows={4}
                className="mt-2 w-full rounded-md border border-[#2a2a2a] bg-[#181818] px-3 py-1 text-sm text-[#d4d4d4] outline-none transition-colors placeholder:text-[#5f5f5f] focus:border-accent/60 focus:bg-[#1c1c1c]"
              />
              <p className="mt-2 text-[11px] leading-4 text-[#8b8b8b]">
                Your custom instructions for the agent to follow.
              </p>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

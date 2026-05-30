'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeSpaceProject } from '@/lib/code-space/core';
import { readCodeSpacePreferences, readCodeSpaceProjects } from '@/lib/code-space/persistence';
import {
  acceptedHunkIdSet,
  applyAcceptedDiffHunks,
  everyHunkResolved,
  splitUnifiedDiffIntoHunks,
  type DiffHunk,
  type DiffHunkStatus,
} from '@/components/code-space/diffHunks';
import { useAppDialogs } from '@/components/shared/useAppDialogs';

type ExplorerNodeType = 'file' | 'dir';

interface ExplorerTarget {
  projectId: string;
  rootPath: string;
  path: string;
  name: string;
  type: ExplorerNodeType;
  directoryPath: string;
}

interface ExplorerMenuState {
  x: number;
  y: number;
  target: ExplorerTarget;
}

interface AgentDiffEvent {
  type: 'diff_proposed';
  diffId: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  deleted?: boolean;
  explanation?: string;
  unifiedDiff?: string;
}

interface ReviewDiff {
  diffId: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  deleted?: boolean;
  explanation?: string;
  unifiedDiff?: string;
  rootPath: string;
  projectId: string;
  runId?: string;
  hunks: DiffHunk[];
  hunkStatus: DiffHunkStatus;
  applyingHunkId?: string;
  applyingAll?: boolean;
  error?: string;
  createdAt: number;
}

interface AgentRequestContext {
  rootPath: string;
  runId?: string;
  projectIdPromise: Promise<string>;
}

interface EditorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const NON_PATH_TITLES = new Set([
  'Explorer',
  'Search',
  'Source Control',
  'Create file',
  'Create folder',
  'Refresh tree',
  'Collapse all',
  'Rename project',
  'Delete project',
  'Toggle explorer (Cmd/Ctrl+B)',
  'Toggle agent (Cmd/Ctrl+I)',
  'Save active file (Cmd/Ctrl+S)',
]);

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function dirname(filePath: string): string {
  const parts = normalizeRelativePath(filePath).split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function basename(filePath: string): string {
  const normalized = normalizeRelativePath(filePath);
  return normalized.split('/').filter(Boolean).pop() ?? normalized;
}

function joinRelative(parent: string, child: string): string {
  const normalizedParent = normalizeRelativePath(parent);
  const normalizedChild = normalizeRelativePath(child);
  return normalizedParent ? `${normalizedParent}/${normalizedChild}` : normalizedChild;
}

function isLikelyExplorerNodeButton(button: HTMLButtonElement): boolean {
  const workbench = button.closest('.code-space-workbench');
  if (!workbench) return false;
  const title = button.getAttribute('title')?.trim();
  if (!title || NON_PATH_TITLES.has(title)) return false;
  if (title.startsWith('Toggle ') || title.startsWith('Save ')) return false;
  return Boolean(button.hasAttribute('aria-expanded') || button.hasAttribute('aria-current') || title.includes('/') || title.includes('.'));
}

function findExplorerNodeButton(eventTarget: EventTarget | null): HTMLButtonElement | null {
  if (!(eventTarget instanceof Element)) return null;
  const button = eventTarget.closest('button[title]');
  if (!(button instanceof HTMLButtonElement)) return null;
  return isLikelyExplorerNodeButton(button) ? button : null;
}

export function isClickInsideExplorerMenu(eventTarget: EventTarget | null): boolean {
  return eventTarget instanceof Element && Boolean(eventTarget.closest('[data-code-space-explorer-menu="true"]'));
}

function isClickInsideInlinePatchReview(eventTarget: EventTarget | null): boolean {
  return eventTarget instanceof Element && Boolean(eventTarget.closest('[data-code-space-inline-patch-review="true"]'));
}

function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

async function getActiveProject(): Promise<CodeSpaceProject | null> {
  const preferences = readCodeSpacePreferences();
  const projects = await readCodeSpaceProjects();
  return (
    projects.find((project) => project.id === preferences.activeProjectId) ??
    projects.find((project) => Boolean(project.rootPath)) ??
    null
  );
}

async function resolveProjectIdForRoot(rootPath: string): Promise<string> {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const preferences = readCodeSpacePreferences();
  const projects = await readCodeSpaceProjects();
  const project =
    projects.find((item) => item.rootPath?.replace(/\\/g, '/').replace(/\/+$/, '') === normalizedRoot) ??
    projects.find((item) => item.id === preferences.activeProjectId) ??
    projects.find((item) => Boolean(item.rootPath));
  return project?.id ?? preferences.activeProjectId ?? 'code-space-project';
}

async function resolveTargetFromButton(button: HTMLButtonElement): Promise<ExplorerTarget | null> {
  const project = await getActiveProject();
  if (!project?.rootPath) return null;
  const path = normalizeRelativePath(button.getAttribute('title') ?? '');
  if (!path) return null;
  const type: ExplorerNodeType = button.hasAttribute('aria-expanded') ? 'dir' : 'file';
  return {
    projectId: project.id,
    rootPath: project.rootPath,
    path,
    name: basename(path),
    type,
    directoryPath: type === 'dir' ? path : dirname(path),
  };
}

function findButtonByPath(path: string): HTMLButtonElement | null {
  const normalized = normalizeRelativePath(path);
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.code-space-workbench button[title]'));
  return buttons.find((button) => normalizeRelativePath(button.getAttribute('title') ?? '') === normalized) ?? null;
}

function refreshExplorerPath(folderPath: string): void {
  const refreshButton = document.querySelector<HTMLButtonElement>('.code-space-workbench button[title="Refresh tree"]');
  refreshButton?.click();

  const normalizedFolder = normalizeRelativePath(folderPath);
  if (!normalizedFolder) return;

  window.setTimeout(() => {
    const folderButton = findButtonByPath(normalizedFolder);
    if (!folderButton || folderButton.getAttribute('aria-expanded') !== 'true') return;
    folderButton.click();
    window.setTimeout(() => {
      const reopenedFolderButton = findButtonByPath(normalizedFolder);
      reopenedFolderButton?.click();
    }, 80);
  }, 80);
}

// Motivation vs Logic: `onError` lets callers surface failures through the in-app modal stack
// (see `useAppDialogs`) instead of the browser's native `window.alert`. Without it, the
// function stays silent on failure so the test harness can keep its fetch-only assertions.
export async function postFileAction(
  target: ExplorerTarget,
  body: Record<string, unknown>,
  refreshPath: string,
  options?: { onError?: (message: string) => void },
): Promise<boolean> {
  const response = await fetch('/api/code-space/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: target.rootPath, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error === 'string' && data.error ? data.error : 'File operation failed';
    options?.onError?.(message);
    return false;
  }
  refreshExplorerPath(refreshPath);
  return true;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function requestBodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (input instanceof Request) return input.clone().text();
  return '';
}

async function parseAgentDiffStream(
  stream: ReadableStream<Uint8Array>,
  context: AgentRequestContext,
  onDiff: (event: AgentDiffEvent, context: AgentRequestContext, projectId: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const projectId = await context.projectIdPromise;
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
        const event = JSON.parse(line.slice(6)) as { type?: string };
        if (event.type === 'diff_proposed') {
          onDiff(event as AgentDiffEvent, context, projectId);
        }
      } catch {
        // Ignore malformed Server-Sent Event fragments; the workspace consumes its own copy.
      }
    }
  }
}

function renderDiffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'bg-[#12351f] text-[#3fb950]';
  if (line.startsWith('-') && !line.startsWith('---')) return 'bg-[#3a1618] text-[#f85149]';
  if (line.startsWith('@@')) return 'text-[#79c0ff]';
  return 'text-[#c9d1d9]';
}

function resolvedContentForHunk(reviewDiff: ReviewDiff, extraAcceptedHunkId?: string): string {
  const acceptedIds = acceptedHunkIdSet(reviewDiff.hunkStatus, extraAcceptedHunkId);
  if (reviewDiff.deleted) return acceptedIds.size > 0 ? '' : reviewDiff.oldContent;
  return applyAcceptedDiffHunks(reviewDiff.oldContent, reviewDiff.hunks, acceptedIds);
}

function hasAcceptedHunks(reviewDiff: ReviewDiff): boolean {
  return Object.values(reviewDiff.hunkStatus).some((status) => status === 'accepted');
}

function findSidebarReviewButton(filePath: string, label: 'Accept' | 'Reject'): HTMLButtonElement | null {
  const normalized = normalizeRelativePath(filePath);
  const openButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button[title]')).find((button) => {
    const title = button.getAttribute('title') ?? '';
    return title.startsWith('Open ') && normalizeRelativePath(title.replace(/^Open\s+/, '')) === normalized;
  });
  const card = openButton?.closest('div.rounded.border');
  if (!card) return null;
  return Array.from(card.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === label) ?? null;
}

function clearWorkspacePendingDiff(filePath: string): void {
  let attempts = 0;
  const tryClear = () => {
    attempts += 1;
    const rejectButton = findSidebarReviewButton(filePath, 'Reject');
    if (rejectButton) {
      rejectButton.click();
      return true;
    }
    return attempts >= 40;
  };

  if (tryClear()) return;
  const intervalId = window.setInterval(() => {
    if (tryClear()) window.clearInterval(intervalId);
  }, 120);
}

function useCodeEditorRect(): EditorRect | null {
  const [rect, setRect] = useState<EditorRect | null>(null);

  useEffect(() => {
    const update = () => {
      const editorRegion = document.querySelector<HTMLElement>('.code-space-workbench > section');
      if (!editorRegion) {
        setRect(null);
        return;
      }
      const next = editorRegion.getBoundingClientRect();
      setRect({ left: next.left, top: next.top, width: next.width, height: next.height });
    };

    update();
    const intervalId = window.setInterval(update, 400);
    window.addEventListener('resize', update);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('resize', update);
    };
  }, []);

  return rect;
}

function useActiveCodeSpaceFilePath(): string | null {
  const [filePath, setFilePath] = useState<string | null>(null);

  useEffect(() => {
    const update = () => {
      const activeExplorerButton = document.querySelector<HTMLButtonElement>('.code-space-workbench button[aria-current="true"][title]');
      const activePath = activeExplorerButton?.getAttribute('title');
      setFilePath(activePath ? normalizeRelativePath(activePath) : null);
    };

    update();
    const intervalId = window.setInterval(update, 300);
    document.addEventListener('click', update, true);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('click', update, true);
    };
  }, []);

  return filePath;
}

export function CodeSpaceWorkspaceEnhancements() {
  const [selectedTarget, setSelectedTarget] = useState<ExplorerTarget | null>(null);
  const [menu, setMenu] = useState<ExplorerMenuState | null>(null);
  const [reviewDiffs, setReviewDiffs] = useState<ReviewDiff[]>([]);
  const mountedRef = useRef(true);
  const editorRect = useCodeEditorRect();
  const activeFilePath = useActiveCodeSpaceFilePath();
  // Motivation vs Logic: every explorer mutation used to reach for `window.prompt`/`alert`/`confirm`,
  // which leaked the page origin and looked alien next to the workspace chrome. The dialog hook
  // gives us promise-based prompts/confirms/alerts backed by portal-mounted modals so the same
  // imperative flow can stay readable while rendering in-app UI.
  const { prompt, confirm, alert, dialogs } = useAppDialogs();

  const reportFileActionError = useCallback(
    (message: string) => {
      void alert({
        title: 'File operation failed',
        message,
        variant: 'error',
      });
    },
    [alert],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenuForButton = useCallback(async (button: HTMLButtonElement, x: number, y: number) => {
    const target = await resolveTargetFromButton(button);
    if (!target) return;
    setSelectedTarget(target);
    setMenu({ x, y, target });
  }, []);

  const validateBareName = useCallback((value: string): string | null => {
    if (value.includes('/') || value.includes('\\')) {
      return 'Enter a name only. Use create file/folder for nested paths.';
    }
    return null;
  }, []);

  const renameTarget = useCallback(async (target: ExplorerTarget) => {
    closeMenu();
    const kindLabel = target.type === 'dir' ? 'folder' : 'file';
    const nextName = await prompt({
      title: `Rename ${kindLabel}`,
      description: `Renames ${target.path} in place. Names cannot contain slashes.`,
      label: `New ${kindLabel} name`,
      defaultValue: target.name,
      confirmLabel: 'Rename',
      validate: validateBareName,
      selectOnOpen: true,
    });
    if (!nextName || nextName === target.name) return;
    const parent = dirname(target.path);
    const nextPath = joinRelative(parent, nextName);
    const ok = await postFileAction(
      target,
      { action: 'rename', path: target.path, nextPath },
      parent,
      { onError: reportFileActionError },
    );
    if (ok) {
      setSelectedTarget({ ...target, path: nextPath, name: nextName, directoryPath: target.type === 'dir' ? nextPath : parent });
    }
  }, [closeMenu, prompt, reportFileActionError, validateBareName]);

  const createFileInDirectory = useCallback(async (target: ExplorerTarget) => {
    closeMenu();
    const directory = target.type === 'dir' ? target.path : target.directoryPath;
    const candidate = await prompt({
      title: 'Create file',
      description: directory ? `Creates a new file inside ${directory}.` : 'Creates a new file at the project root.',
      label: 'File name',
      defaultValue: 'untitled.txt',
      confirmLabel: 'Create file',
      validate: validateBareName,
      selectOnOpen: true,
    });
    if (!candidate) return;
    const path = joinRelative(directory, candidate);
    await postFileAction(target, { action: 'write', path, content: '' }, directory, { onError: reportFileActionError });
  }, [closeMenu, prompt, reportFileActionError, validateBareName]);

  const createFolderInDirectory = useCallback(async (target: ExplorerTarget) => {
    closeMenu();
    const directory = target.type === 'dir' ? target.path : target.directoryPath;
    const candidate = await prompt({
      title: 'Create folder',
      description: directory ? `Creates a new folder inside ${directory}.` : 'Creates a new folder at the project root.',
      label: 'Folder name',
      defaultValue: 'new-folder',
      confirmLabel: 'Create folder',
      validate: validateBareName,
      selectOnOpen: true,
    });
    if (!candidate) return;
    const path = joinRelative(directory, candidate);
    await postFileAction(target, { action: 'mkdir', path }, directory, { onError: reportFileActionError });
  }, [closeMenu, prompt, reportFileActionError, validateBareName]);

  const duplicateTarget = useCallback(async (target: ExplorerTarget) => {
    closeMenu();
    const parent = dirname(target.path);
    const defaultName = `${target.name}.copy`;
    const kindLabel = target.type === 'dir' ? 'folder' : 'file';
    const candidate = await prompt({
      title: `Duplicate ${kindLabel}`,
      description: `Copies ${target.path} inside ${parent || 'the project root'}.`,
      label: `New ${kindLabel} name`,
      defaultValue: defaultName,
      confirmLabel: 'Duplicate',
      validate: validateBareName,
      selectOnOpen: true,
    });
    if (!candidate) return;
    const nextPath = joinRelative(parent, candidate);
    await postFileAction(target, { action: 'duplicate', path: target.path, nextPath }, parent, { onError: reportFileActionError });
  }, [closeMenu, prompt, reportFileActionError, validateBareName]);

  const deleteTarget = useCallback(async (target: ExplorerTarget) => {
    closeMenu();
    const accepted = await confirm({
      title: `Delete ${target.type === 'dir' ? 'folder' : 'file'}`,
      message: `Delete ${target.path}? This cannot be undone here.`,
      confirmLabel: 'Delete',
    });
    if (!accepted) return;
    await postFileAction(target, { action: 'delete', path: target.path }, dirname(target.path), { onError: reportFileActionError });
  }, [closeMenu, confirm, reportFileActionError]);

  const removeReviewDiff = useCallback((diffId: string) => {
    setReviewDiffs((current) => current.filter((item) => item.diffId !== diffId));
  }, []);

  const updateReviewDiff = useCallback((diffId: string, updater: (current: ReviewDiff) => ReviewDiff) => {
    setReviewDiffs((current) => current.map((item) => (item.diffId === diffId ? updater(item) : item)));
  }, []);

  const markDiffResolved = useCallback((reviewDiff: ReviewDiff) => {
    removeReviewDiff(reviewDiff.diffId);
    clearWorkspacePendingDiff(reviewDiff.filePath);
  }, [removeReviewDiff]);

  const rejectHunk = useCallback((reviewDiff: ReviewDiff, hunk: DiffHunk) => {
    updateReviewDiff(reviewDiff.diffId, (current) => {
      const next = {
        ...current,
        hunkStatus: { ...current.hunkStatus, [hunk.id]: 'rejected' as const },
        error: undefined,
      };
      if (everyHunkResolved(next.hunks, next.hunkStatus)) {
        window.setTimeout(() => markDiffResolved(next), 0);
      }
      return next;
    });
  }, [markDiffResolved, updateReviewDiff]);

  const acceptHunk = useCallback(async (reviewDiff: ReviewDiff, hunk: DiffHunk) => {
    updateReviewDiff(reviewDiff.diffId, (current) => ({ ...current, applyingHunkId: hunk.id, error: undefined }));

    const beforeContent = resolvedContentForHunk(reviewDiff);
    const afterContent = resolvedContentForHunk(reviewDiff, hunk.id);

    try {
      const response = await fetch('/api/code-space/patches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'apply',
          rootPath: reviewDiff.rootPath,
          projectId: reviewDiff.projectId,
          runId: reviewDiff.runId,
          patchId: `${reviewDiff.diffId}:${hunk.id}`,
          files: [
            {
              path: reviewDiff.filePath,
              beforeContent,
              afterContent,
              deleted: reviewDiff.deleted && afterContent === '',
            },
          ],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? 'Patch apply failed');

      updateReviewDiff(reviewDiff.diffId, (current) => {
        const next = {
          ...current,
          applyingHunkId: undefined,
          hunkStatus: { ...current.hunkStatus, [hunk.id]: 'accepted' as const },
          error: undefined,
        };
        if (everyHunkResolved(next.hunks, next.hunkStatus)) {
          window.setTimeout(() => markDiffResolved(next), 0);
        }
        return next;
      });
      document.querySelector<HTMLButtonElement>('.code-space-workbench button[title="Refresh tree"]')?.click();
    } catch (error) {
      updateReviewDiff(reviewDiff.diffId, (current) => ({
        ...current,
        applyingHunkId: undefined,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [markDiffResolved, updateReviewDiff]);

  const acceptAllForDiff = useCallback(async (reviewDiff: ReviewDiff) => {
    updateReviewDiff(reviewDiff.diffId, (current) => ({ ...current, applyingAll: true, error: undefined }));
    const beforeContent = resolvedContentForHunk(reviewDiff);
    const afterContent = reviewDiff.deleted ? '' : reviewDiff.newContent;

    try {
      const response = await fetch('/api/code-space/patches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'apply',
          rootPath: reviewDiff.rootPath,
          projectId: reviewDiff.projectId,
          runId: reviewDiff.runId,
          patchId: `${reviewDiff.diffId}:all`,
          files: [
            {
              path: reviewDiff.filePath,
              beforeContent,
              afterContent,
              deleted: reviewDiff.deleted,
            },
          ],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? 'Patch apply failed');
      markDiffResolved(reviewDiff);
      document.querySelector<HTMLButtonElement>('.code-space-workbench button[title="Refresh tree"]')?.click();
    } catch (error) {
      updateReviewDiff(reviewDiff.diffId, (current) => ({
        ...current,
        applyingAll: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [markDiffResolved, updateReviewDiff]);

  const rejectAllForDiff = useCallback((reviewDiff: ReviewDiff) => {
    markDiffResolved(reviewDiff);
  }, [markDiffResolved]);

  useEffect(() => {
    mountedRef.current = true;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      let context: AgentRequestContext | null = null;

      if (url.includes('/api/code-space/agent')) {
        const bodyText = await requestBodyText(input, init).catch(() => '');
        try {
          const parsed = JSON.parse(bodyText) as { projectRoot?: string; sessionId?: string };
          if (parsed.projectRoot) {
            context = {
              rootPath: parsed.projectRoot,
              runId: parsed.sessionId,
              projectIdPromise: resolveProjectIdForRoot(parsed.projectRoot),
            };
          }
        } catch {
          context = null;
        }
      }

      const response = await originalFetch(input, init);
      if (!context || !response.body) return response;

      const [workspaceBody, reviewBody] = response.body.tee();
      void parseAgentDiffStream(reviewBody, context, (event, streamContext, projectId) => {
        if (!mountedRef.current) return;
        const hunks = splitUnifiedDiffIntoHunks(event.unifiedDiff, event.oldContent, event.newContent);
        const nextReviewDiff: ReviewDiff = {
          diffId: event.diffId,
          filePath: event.filePath,
          oldContent: event.oldContent,
          newContent: event.newContent,
          deleted: event.deleted,
          explanation: event.explanation,
          unifiedDiff: event.unifiedDiff,
          rootPath: streamContext.rootPath,
          projectId,
          runId: streamContext.runId,
          hunks,
          hunkStatus: {},
          createdAt: Date.now(),
        };
        setReviewDiffs((current) => [...current.filter((item) => item.diffId !== event.diffId), nextReviewDiff]);
      }).catch(() => undefined);

      return new Response(workspaceBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };

    return () => {
      mountedRef.current = false;
      window.fetch = originalFetch;
    };
  }, []);

  useEffect(() => {
    const handleClickCapture = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      const createFileButton = element?.closest('button[title="Create file"]');
      const createFolderButton = element?.closest('button[title="Create folder"]');
      if ((createFileButton || createFolderButton) && selectedTarget) {
        event.preventDefault();
        event.stopPropagation();
        if (createFileButton) void createFileInDirectory(selectedTarget);
        else void createFolderInDirectory(selectedTarget);
        return;
      }

      if (isClickInsideExplorerMenu(event.target) || isClickInsideInlinePatchReview(event.target)) return;

      const button = findExplorerNodeButton(event.target);
      if (!button) {
        closeMenu();
        return;
      }
      void resolveTargetFromButton(button).then((target) => {
        if (target) setSelectedTarget(target);
      });
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (isClickInsideInlinePatchReview(event.target)) return;
      const button = findExplorerNodeButton(event.target);
      if (!button) return;
      event.preventDefault();
      void openMenuForButton(button, event.clientX, event.clientY);
    };

    const handleDoubleClick = (event: MouseEvent) => {
      if (!isMacLike()) return;
      const button = findExplorerNodeButton(event.target);
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      void openMenuForButton(button, event.clientX, event.clientY);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const button = findExplorerNodeButton(document.activeElement);
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      void resolveTargetFromButton(button).then((target) => {
        if (target) void renameTarget(target);
      });
    };

    document.addEventListener('click', handleClickCapture, true);
    document.addEventListener('contextmenu', handleContextMenu, true);
    document.addEventListener('dblclick', handleDoubleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('click', handleClickCapture, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('dblclick', handleDoubleClick, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [closeMenu, createFileInDirectory, createFolderInDirectory, openMenuForButton, renameTarget, selectedTarget]);

  useEffect(() => {
    let attempts = 0;
    const intervalId = window.setInterval(() => {
      attempts += 1;
      const workbench = document.querySelector('.code-space-workbench');
      const refreshButton = document.querySelector<HTMLButtonElement>('.code-space-workbench button[title="Refresh tree"]');
      if (workbench && refreshButton) {
        const hasExplorerNode = Boolean(workbench.querySelector('button[title][aria-expanded], button[title][aria-current]'));
        if (!hasExplorerNode) refreshButton.click();
      }
      if (attempts >= 20) window.clearInterval(intervalId);
    }, 250);
    return () => window.clearInterval(intervalId);
  }, []);

  const unresolvedReviewDiffs = useMemo(
    () => reviewDiffs.filter((item) => !everyHunkResolved(item.hunks, item.hunkStatus)).sort((a, b) => a.createdAt - b.createdAt),
    [reviewDiffs],
  );
  const visibleReviewDiffs = useMemo(() => {
    if (!activeFilePath) return unresolvedReviewDiffs;
    const scoped = unresolvedReviewDiffs.filter((item) => normalizeRelativePath(item.filePath) === activeFilePath);
    return scoped.length ? scoped : unresolvedReviewDiffs;
  }, [activeFilePath, unresolvedReviewDiffs]);

  const hasVisibleBusyDiff = visibleReviewDiffs.some((item) => item.applyingAll || Boolean(item.applyingHunkId));
  const reviewStyle = editorRect
    ? {
        left: `${editorRect.left}px`,
        top: `${editorRect.top + 36}px`,
        width: `${editorRect.width}px`,
        height: `${Math.max(220, editorRect.height - 36)}px`,
      }
    : undefined;

  const acceptAllVisible = useCallback(() => {
    for (const reviewDiff of visibleReviewDiffs) {
      void acceptAllForDiff(reviewDiff);
    }
  }, [acceptAllForDiff, visibleReviewDiffs]);

  const rejectAllVisible = useCallback(() => {
    for (const reviewDiff of visibleReviewDiffs) {
      rejectAllForDiff(reviewDiff);
    }
  }, [rejectAllForDiff, visibleReviewDiffs]);

  const target = menu?.target;
  const directoryLabel = target ? (target.type === 'dir' ? target.path : target.directoryPath || 'project root') : '';

  return (
    <>
      {editorRect && reviewStyle && visibleReviewDiffs.length > 0 ? (
        <div data-code-space-inline-patch-review="true" className="fixed z-[900] font-mono text-xs text-[#e6edf3]" style={reviewStyle}>
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#1e1e1ef2] via-[#1e1e1ed9] to-[#1e1e1ef2]" />
          <div className="pointer-events-auto absolute right-4 top-2 z-10 flex items-center gap-2 rounded-md border border-[#30363d] bg-[#161b22e6] px-2 py-1 shadow-lg backdrop-blur">
            <span className="px-1 text-[10px] text-[#8b949e]">{visibleReviewDiffs.length} file{visibleReviewDiffs.length === 1 ? '' : 's'}</span>
            <button type="button" disabled={hasVisibleBusyDiff} onClick={rejectAllVisible} className="rounded border border-[#30363d] px-2 py-1 text-[10px] text-[#f85149] hover:bg-[#2d1517] disabled:cursor-not-allowed disabled:opacity-40">
              Reject All
            </button>
            <button type="button" disabled={hasVisibleBusyDiff} onClick={acceptAllVisible} className="rounded bg-[#238636] px-2 py-1 text-[10px] text-white hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-40">
              Accept All
            </button>
          </div>
          <div className="pointer-events-auto absolute inset-0 overflow-auto px-10 pb-8 pt-14">
            <div className="mx-auto max-w-6xl space-y-4">
              {visibleReviewDiffs.map((reviewDiff) => (
                <div key={reviewDiff.diffId} className="rounded-md border border-[#30363d] bg-[#0d1117f2] shadow-xl">
                  <div className="flex flex-wrap items-center gap-2 border-b border-[#1f242d] px-3 py-2">
                    <span className="truncate text-[12px] text-[#58a6ff]">{reviewDiff.filePath}</span>
                    <span className="rounded border border-[#30363d] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[#8b949e]">
                      {reviewDiff.deleted ? 'delete' : `${reviewDiff.hunks.length} patch${reviewDiff.hunks.length === 1 ? '' : 'es'}`}
                    </span>
                    {hasAcceptedHunks(reviewDiff) ? <span className="rounded border border-[#3fb95055] px-1.5 py-0.5 text-[9px] uppercase text-[#3fb950]">partial applied</span> : null}
                  </div>
                  {reviewDiff.explanation ? <p className="px-3 pt-2 text-[10px] leading-4 text-[#8b949e]">{reviewDiff.explanation}</p> : null}
                  {reviewDiff.error ? <p className="mx-3 mt-2 rounded border border-[#f8514944] bg-[#2d1517] px-2 py-1 text-[10px] text-[#f85149]">{reviewDiff.error}</p> : null}
                  <div className="space-y-3 p-3">
                    {reviewDiff.hunks.map((hunk) => {
                      const status = reviewDiff.hunkStatus[hunk.id];
                      const isBusy = reviewDiff.applyingHunkId === hunk.id || reviewDiff.applyingAll;
                      const isResolved = status === 'accepted' || status === 'rejected';
                      return (
                        <div key={hunk.id} className="overflow-hidden rounded border border-[#242a32] bg-[#0b0f14]">
                          <div className="border-b border-[#1f242d] bg-[#111827] px-3 py-1.5 text-[9px] uppercase tracking-wider text-[#79c0ff]">
                            Patch {hunk.index + 1} <span className="ml-2 normal-case tracking-normal text-[#6e7681]">{hunk.header}</span>
                          </div>
                          <div className="overflow-auto py-1 text-[11px] leading-5">
                            {[hunk.header, ...hunk.lines].map((line, index) => (
                              <div key={`${hunk.id}:${index}:${line.slice(0, 20)}`} className={`whitespace-pre-wrap break-all px-3 ${renderDiffLineClass(line)}`}>
                                {line || ' '}
                              </div>
                            ))}
                          </div>
                          <div className="flex items-center justify-end gap-2 border-t border-[#1f242d] bg-[#0f1114] px-3 py-2">
                            {status ? <span className={status === 'accepted' ? 'mr-auto text-[9px] uppercase text-[#3fb950]' : 'mr-auto text-[9px] uppercase text-[#f85149]'}>{status}</span> : null}
                            <button type="button" disabled={isBusy || isResolved} onClick={() => rejectHunk(reviewDiff, hunk)} className="rounded border border-[#30363d] px-2 py-1 text-[10px] text-[#f85149] hover:bg-[#2d1517] disabled:cursor-not-allowed disabled:opacity-40">
                              Reject patch
                            </button>
                            <button type="button" disabled={isBusy || isResolved} onClick={() => void acceptHunk(reviewDiff, hunk)} className="rounded bg-[#238636] px-2 py-1 text-[10px] text-white hover:bg-[#2ea043] disabled:cursor-not-allowed disabled:opacity-40">
                              {isBusy ? 'Applying…' : 'Accept patch'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {menu && target ? (
        <div
          data-code-space-explorer-menu="true"
          className="fixed z-[1000] min-w-48 rounded-md border border-[#3a3a3a] bg-[#1f1f1f] py-1 text-[12px] text-[#d4d4d4] shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[#2a2d2e]" onClick={() => void renameTarget(target)} role="menuitem">
            Edit name
          </button>
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[#2a2d2e]" onClick={() => void createFileInDirectory(target)} role="menuitem">
            Create file
          </button>
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[#2a2d2e]" onClick={() => void createFolderInDirectory(target)} role="menuitem">
            Create folder
          </button>
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-[#2a2d2e]" onClick={() => void duplicateTarget(target)} role="menuitem">
            Duplicate
          </button>
          <div className="my-1 border-t border-[#333]" />
          <button type="button" className="block w-full px-3 py-1.5 text-left text-red-300 hover:bg-red-500/10" onClick={() => void deleteTarget(target)} role="menuitem">
            Delete
          </button>
          <div className="border-t border-[#333] px-3 py-1 text-[10px] text-[#8b8b8b]">
            Target: {directoryLabel}
          </div>
        </div>
      ) : null}

      {dialogs}
    </>
  );
}

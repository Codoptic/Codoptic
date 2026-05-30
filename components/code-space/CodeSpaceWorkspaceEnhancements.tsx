'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodeSpaceProject } from '@/lib/code-space/core';
import { readCodeSpacePreferences, readCodeSpaceProjects } from '@/lib/code-space/persistence';
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

export function CodeSpaceWorkspaceEnhancements() {
  const [selectedTarget, setSelectedTarget] = useState<ExplorerTarget | null>(null);
  const [menu, setMenu] = useState<ExplorerMenuState | null>(null);
  const mountedRef = useRef(true);
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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

  const target = menu?.target;
  const directoryLabel = target ? (target.type === 'dir' ? target.path : target.directoryPath || 'project root') : '';

  return (
    <>
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

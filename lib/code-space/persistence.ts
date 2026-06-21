'use client';

import type { CodeSpaceAgentSession, CodeSpaceBottomTab, CodeSpaceEditorTab, CodeSpaceProject } from './core';
import { detectCodeSpaceLanguage } from './core';
import { normalizeCodeSpaceAgentMode, type CodeSpaceAgentMode } from './agentModes';
import type { CodeSpaceExecutionPolicy } from './executionPolicy';

const DB_NAME = 'codoptic-code-space';
const DB_VERSION = 1;
const PROJECT_STORE = 'projects';
const SESSION_STORE = 'sessions';
const TAB_STORE = 'tabs';
const PREFERENCES_KEY = 'codoptic:code-space:preferences:v1';

export interface CodeSpaceLayoutPreferences {
  activeProjectId?: string | null;
  activeSessionId?: string | null;
  activeTabId?: string | null;
  agentMode?: CodeSpaceAgentMode;
  instruction?: string;
  leftSidebarVisible?: boolean;
  rightSidebarVisible?: boolean;
  leftWidth?: number;
  rightWidth?: number;
  bottomPanelVisible?: boolean;
  minimapEnabled?: boolean;
  wordWrap?: boolean;
  revealHiddenFiles?: boolean;
  bottomActiveTab?: CodeSpaceBottomTab;
  executionPolicy?: CodeSpaceExecutionPolicy;
}

function canUseIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openCodeSpaceDb(): Promise<IDBDatabase> {
  if (!canUseIndexedDb()) return Promise.reject(new Error('IndexedDB is unavailable'));

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        const store = db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(TAB_STORE)) {
        const store = db.createObjectStore(TAB_STORE, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  try {
    const db = await openCodeSpaceDb();
    return await new Promise<T[]>((resolve, reject) => {
      const request = db.transaction([storeName], 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as T[]);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

async function putInStore<T>(storeName: string, value: T): Promise<void> {
  const db = await openCodeSpaceDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction([storeName], 'readwrite').objectStore(storeName).put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const sessionSaveQueues = new Map<string, Promise<void>>();

/** Prefer the newest session snapshot when hydrating from IndexedDB. */
export function mergeCodeSpaceSessions(
  current: CodeSpaceAgentSession[],
  incoming: CodeSpaceAgentSession[],
): CodeSpaceAgentSession[] {
  const byId = new Map<string, CodeSpaceAgentSession>();
  for (const session of [...current, ...incoming]) {
    const existing = byId.get(session.id);
    if (!existing || session.updatedAt >= existing.updatedAt) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function flushCodeSpaceSessionWrites(): Promise<void> {
  await Promise.all([...sessionSaveQueues.values()]);
}

export function readCodeSpacePreferences(): CodeSpaceLayoutPreferences {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CodeSpaceLayoutPreferences;
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function writeCodeSpacePreferences(next: CodeSpaceLayoutPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ ...readCodeSpacePreferences(), ...next }));
  } catch {
    // Local preferences are non-critical; keep the workbench usable if storage is full.
  }
}

export async function readCodeSpaceProjects(): Promise<CodeSpaceProject[]> {
  return getAllFromStore<CodeSpaceProject>(PROJECT_STORE);
}

export async function saveCodeSpaceProject(project: CodeSpaceProject): Promise<void> {
  await putInStore(PROJECT_STORE, project);
}

export async function deleteCodeSpaceProject(projectId: string): Promise<void> {
  const db = await openCodeSpaceDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([PROJECT_STORE], 'readwrite');
    const request = tx.objectStore(PROJECT_STORE).delete(projectId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function readCodeSpaceSessions(): Promise<CodeSpaceAgentSession[]> {
  const sessions = await getAllFromStore<CodeSpaceAgentSession>(SESSION_STORE);
  return sessions
    .map((session): CodeSpaceAgentSession => ({
      ...session,
      mode: session.mode === 'fresh-start' ? 'fresh-start' : normalizeCodeSpaceAgentMode(session.mode),
      clarifyingQuestions: session.clarifyingQuestions ?? [],
      clarifyingQuestionAnswers: session.clarifyingQuestionAnswers ?? {},
      pendingPanelDiffs: session.pendingPanelDiffs ?? [],
      runFeed: session.runFeed ?? [],
      patchHistory: session.patchHistory ?? [],
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveCodeSpaceSession(session: CodeSpaceAgentSession): Promise<void> {
  const previous = sessionSaveQueues.get(session.id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => putInStore(SESSION_STORE, session));
  sessionSaveQueues.set(session.id, next);
  await next;
}

export async function deleteCodeSpaceSession(sessionId: string): Promise<void> {
  const db = await openCodeSpaceDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([SESSION_STORE], 'readwrite');
    const request = tx.objectStore(SESSION_STORE).delete(sessionId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function readCodeSpaceTabs(): Promise<CodeSpaceEditorTab[]> {
  const tabs = await getAllFromStore<CodeSpaceEditorTab>(TAB_STORE);
  return tabs
    .map((tab) => ({
      ...tab,
      preview:
        typeof tab.preview === 'boolean'
          ? tab.preview
          : detectCodeSpaceLanguage(tab.path) === 'markdown',
    }))
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function saveCodeSpaceTab(tab: CodeSpaceEditorTab): Promise<void> {
  await putInStore(TAB_STORE, tab);
}

export async function deleteCodeSpaceTab(tabId: string): Promise<void> {
  const db = await openCodeSpaceDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([TAB_STORE], 'readwrite');
    const request = tx.objectStore(TAB_STORE).delete(tabId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

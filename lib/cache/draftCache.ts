/**
 * IndexedDB Draft Cache for Editor State
 *
 * Persists the editor's working content — DSL text and layout overrides —
 * so changes survive page refreshes even when localStorage runs out of quota.
 *
 * Each draft is keyed by the active project ID, or "scratch" when no
 * project tab is open. Writes are coalesced by the store so rapid keystrokes
 * and drag events collapse into the latest IndexedDB snapshot.
 *
 * This is intentionally a separate database from `diagram-cache` (layout
 * results) so the two caches can be cleared independently and a schema
 * upgrade in one does not affect the other.
 */

import type { Overrides, Viewport } from '../state/store';
import type { MultiLayerOutput, StoredProject } from '../state/projectStorage';

const DB_NAME = 'diagram-drafts';
const DB_VERSION = 1;
const DRAFTS_STORE = 'drafts';

export interface EditorDraft {
  /** Active project ID, or 'scratch' when no project tab is open. */
  key: string;
  dslText: string;
  overrides: Overrides;
  /** Active project tab when the snapshot was taken, if any. */
  activeProjectId: string | null;
  /** All open project tabs so a refresh can recover the current working set. */
  generatedProjects: StoredProject[];
  /** Active multi-layer bundle for the current project, if present. */
  multiLayer: MultiLayerOutput | null;
  /** Currently selected tab within a multi-layer project. */
  activeLayer: string;
  /** Persisted instruction guide tied to the active project. */
  instructionMarkdown: string;
  /** Viewport so a refresh can restore the visible diagram region. */
  viewport: Viewport;
  /** Unix milliseconds — used to detect which source is more recent. */
  updatedAt: number;
}

// Singleton connection — reused across all calls in a page session.
let _dbConn: IDBDatabase | null = null;
let _dbOpenPromise: Promise<IDBDatabase> | null = null;

function canUseIndexedDB(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function draftShadowKey(key: string): string {
  return `codoptic:draft-shadow:v1:${key}`;
}

function validateDraft(value: unknown): EditorDraft | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Partial<EditorDraft>).key !== 'string' ||
    typeof (value as Partial<EditorDraft>).dslText !== 'string' ||
    typeof (value as Partial<EditorDraft>).updatedAt !== 'number'
  ) {
    return null;
  }

  const candidate = value as Partial<EditorDraft>;
  if (
    typeof candidate.overrides !== 'object' ||
    candidate.overrides === null ||
    typeof candidate.activeProjectId !== 'string' && candidate.activeProjectId !== null ||
    !Array.isArray(candidate.generatedProjects) ||
    typeof candidate.activeLayer !== 'string' ||
    typeof candidate.instructionMarkdown !== 'string' ||
    typeof candidate.viewport !== 'object' ||
    candidate.viewport === null
  ) {
    return null;
  }

  return candidate as EditorDraft;
}

export function writeDraftShadow(draft: Omit<EditorDraft, 'updatedAt'>): void {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(
      draftShadowKey(draft.key),
      JSON.stringify({ ...draft, updatedAt: Date.now() }),
    );
  } catch (err) {
    console.warn('[DraftCache] Failed to write draft shadow:', err);
  }
}

export function readDraftShadow(key: string): EditorDraft | null {
  if (!canUseLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(draftShadowKey(key));
    if (!raw) return null;
    const parsed = validateDraft(JSON.parse(raw));
    if (!parsed || parsed.key !== key) return null;
    return parsed;
  } catch (err) {
    console.warn('[DraftCache] Failed to read draft shadow:', err);
    return null;
  }
}

function openDB(): Promise<IDBDatabase> {
  if (!canUseIndexedDB()) {
    return Promise.reject(new Error('[DraftCache] IndexedDB not available'));
  }
  if (_dbConn) return Promise.resolve(_dbConn);
  if (_dbOpenPromise) return _dbOpenPromise;

  _dbOpenPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DRAFTS_STORE)) {
        db.createObjectStore(DRAFTS_STORE, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => {
      _dbConn = req.result;
      _dbOpenPromise = null;

      // Reset singleton if the connection is unexpectedly closed (e.g. version bump).
      _dbConn.onclose = () => {
        _dbConn = null;
      };

      resolve(_dbConn);
    };

    req.onerror = () => {
      _dbOpenPromise = null;
      reject(req.error);
    };

    req.onblocked = () => {
      console.warn('[DraftCache] IndexedDB open blocked — another tab may hold an older version.');
    };
  });

  return _dbOpenPromise;
}

/**
 * Persist the current editor draft for a given key.
 *
 * @param key  Active project ID, or 'scratch'.
 * @param dslText  Current DSL editor content.
 * @param overrides  Node/group/edge position overrides from drag operations.
 */
export async function saveDraft(draft: Omit<EditorDraft, 'updatedAt'>): Promise<void> {
  try {
    writeDraftShadow(draft);
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([DRAFTS_STORE], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(DRAFTS_STORE).put({ ...draft, updatedAt: Date.now() });
    });
  } catch (err) {
    // Silently swallow — caching is an optimisation, not critical path.
    console.warn('[DraftCache] Failed to save draft:', err);
  }
}

/**
 * Load the persisted draft for a given key.
 * Returns null if no draft exists or if IndexedDB is unavailable.
 */
export async function loadDraft(key: string): Promise<EditorDraft | null> {
  try {
    const shadowDraft = readDraftShadow(key);
    const db = await openDB();
    const indexedDraft = await new Promise<EditorDraft | null>((resolve, reject) => {
      const tx = db.transaction([DRAFTS_STORE], 'readonly');
      const req = tx.objectStore(DRAFTS_STORE).get(key);
      req.onsuccess = () => resolve((req.result as EditorDraft) ?? null);
      req.onerror = () => reject(req.error);
    });

    if (!indexedDraft) return shadowDraft;
    if (!shadowDraft) return indexedDraft;
    return shadowDraft.updatedAt > indexedDraft.updatedAt ? shadowDraft : indexedDraft;
  } catch (err) {
    console.warn('[DraftCache] Failed to load draft:', err);
    return readDraftShadow(key);
  }
}

/**
 * Delete the persisted draft for a given key.
 * Called when a project is removed so stale overrides are not mistakenly
 * applied to a future project that re-uses the same ID.
 */
export async function deleteDraft(key: string): Promise<void> {
  try {
    if (canUseLocalStorage()) {
      window.localStorage.removeItem(draftShadowKey(key));
    }
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([DRAFTS_STORE], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(DRAFTS_STORE).delete(key);
    });
  } catch (err) {
    console.warn('[DraftCache] Failed to delete draft:', err);
  }
}

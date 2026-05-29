'use client';

import type { Overrides, Viewport } from './store';

const DB_NAME = 'codoptic';
const STORE = 'projects';
const VERSION = 1;

export interface ProjectFile {
  format: 'codoptic-project-v1';
  name: string;
  dsl: string;
  overrides: Overrides;
  viewport: Viewport;
  diagramType: string;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveProject(file: ProjectFile): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(file);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listProjects(): Promise<ProjectFile[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as ProjectFile[]);
    req.onerror = () => reject(req.error);
  });
}

export async function loadProject(name: string): Promise<ProjectFile | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(name);
    req.onsuccess = () => resolve((req.result as ProjectFile | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export function downloadProject(file: ProjectFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${file.name || 'diagram'}.diagram.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

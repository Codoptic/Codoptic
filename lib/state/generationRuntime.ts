'use client';

import { useSyncExternalStore } from 'react';
import type { GenerationKind, GenerationRunRecord } from '../cache/draftCache';
import type { MultiLayerOutput } from './projectStorage';
import { useDiagramStore } from './store';

export type { GenerationKind, GenerationStatus } from '../cache/draftCache';
export type GenerationRun = GenerationRunRecord;

const listeners = new Set<(run: GenerationRun | null) => void>();
let current: GenerationRun | null = null;
let controller: AbortController | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  for (const listener of listeners) listener(current);
  schedulePersist();
}

function schedulePersist(): void {
  if (!current || typeof window === 'undefined') return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = current;
    if (!snapshot) return;
    void import('../cache/draftCache')
      .then((mod) => mod.saveGenerationRun(snapshot))
      .catch(() => undefined);
  }, 0);
}

async function persistNow(run: GenerationRun): Promise<void> {
  const { saveGenerationRun } = await import('../cache/draftCache');
  await saveGenerationRun(run);
}

export function getGenerationRun(): GenerationRun | null {
  return current;
}

export function subscribeGenerationRun(listener: (run: GenerationRun | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function beginGenerationRun(input: {
  id: string;
  kind: GenerationKind;
  projectName: string;
}): AbortController {
  controller?.abort();
  controller = new AbortController();
  current = {
    id: input.id,
    kind: input.kind,
    status: 'running',
    projectName: input.projectName,
    stage: null,
    counters: {},
    logs: [],
    retryNotice: null,
    terminalState: null,
    updatedAt: Date.now(),
  };
  emit();
  return controller;
}

export function patchGenerationRun(patch: Partial<GenerationRun>): void {
  if (!current) return;
  current = { ...current, ...patch, updatedAt: Date.now() };
  emit();
}

export function abortGenerationRun(): void {
  controller?.abort();
}

export async function commitGenerationResult(input: {
  name: string;
  dsl: string;
  multiLayer?: MultiLayerOutput;
  instructionMarkdown?: string;
}): Promise<string> {
  patchGenerationRun({
    status: 'completed',
    projectName: input.name,
    result: {
      dsl: input.dsl,
      ...(input.multiLayer ? { multiLayer: input.multiLayer } : {}),
      ...(input.instructionMarkdown ? { instructionMarkdown: input.instructionMarkdown } : {}),
    },
    terminalState: null,
  });
  if (current) await persistNow(current);

  const projectId = await useDiagramStore
    .getState()
    .addGeneratedProject(input.name, input.dsl, input.multiLayer, input.instructionMarkdown);

  patchGenerationRun({ committedProjectId: projectId });
  if (current) await persistNow(current);
  return projectId;
}

export async function recoverCompletedGeneration(): Promise<string | null> {
  const { loadUncommittedCompletedRun } = await import('../cache/draftCache');
  const pending = await loadUncommittedCompletedRun();
  if (!pending?.result?.dsl) return null;

  const state = useDiagramStore.getState();
  if (state.generatedProjects.some((project) => project.dsl === pending.result?.dsl && project.name === pending.projectName)) {
    patchGenerationRun({ ...pending, committedProjectId: state.activeProjectId ?? undefined, status: 'completed' });
    return state.activeProjectId;
  }

  current = pending;
  emit();
  return commitGenerationResult({
    name: pending.projectName,
    dsl: pending.result.dsl,
    multiLayer: pending.result.multiLayer,
    instructionMarkdown: pending.result.instructionMarkdown,
  });
}

export function useGenerationRun(): GenerationRun | null {
  return useSyncExternalStore(
    (onStoreChange) => subscribeGenerationRun(() => onStoreChange()),
    getGenerationRun,
    () => null,
  );
}

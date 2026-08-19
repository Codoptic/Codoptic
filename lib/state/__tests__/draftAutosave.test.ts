import { beforeEach, describe, expect, it, vi } from 'vitest';

const { saveDraft, deleteDraft, loadDraft, writeDraftShadow, saveProjectCatalog } = vi.hoisted(() => ({
  saveDraft: vi.fn(async () => undefined),
  deleteDraft: vi.fn(async () => undefined),
  loadDraft: vi.fn(async () => null),
  writeDraftShadow: vi.fn(() => undefined),
  saveProjectCatalog: vi.fn(async () => undefined),
}));

vi.mock('../../cache/draftCache', () => ({
  deleteDraft,
  loadDraft,
  saveDraft,
  writeDraftShadow,
  saveProjectCatalog,
}));

import { flushDraftSave, useDiagramStore } from '../store';

describe('draft autosave', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    saveDraft.mockClear();
    deleteDraft.mockClear();
    loadDraft.mockClear();
    writeDraftShadow.mockClear();
    storage.clear();

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });

    useDiagramStore.setState({
      dslText: '',
      overrides: { nodes: {}, groups: {}, edges: {} },
      activeProjectId: null,
      generatedProjects: [],
      multiLayer: null,
      activeLayer: 'overview',
    });
  });

  it('persists the latest DSL change immediately', async () => {
    useDiagramStore.getState().setDsl('Architecture\nService > Database');

    await vi.waitFor(() => {
      expect(saveDraft).toHaveBeenCalledTimes(1);
    });

    expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'scratch',
        dslText: 'Architecture\nService > Database',
        overrides: { nodes: {}, groups: {}, edges: {} },
        activeProjectId: null,
      }),
    );
  });

  it('drains the latest pending snapshot when hard-saving', async () => {
    let resolveFirstSave: ((value: undefined | PromiseLike<undefined>) => void) | undefined;
    let resolveSecondSave: ((value: undefined | PromiseLike<undefined>) => void) | undefined;

    saveDraft
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            resolveFirstSave = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            resolveSecondSave = resolve;
          }),
      );

    useDiagramStore.getState().setDsl('Architecture\nService > Queue');
    await vi.waitFor(() => {
      expect(saveDraft).toHaveBeenCalledTimes(1);
    });

    const hardSave = flushDraftSave();
    useDiagramStore.getState().setDsl('Architecture\nService > Database');

    resolveFirstSave?.(undefined);
    await vi.waitFor(() => {
      expect(saveDraft).toHaveBeenCalledTimes(2);
    });

    expect(saveDraft).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        key: 'scratch',
        dslText: 'Architecture\nService > Database',
        overrides: { nodes: {}, groups: {}, edges: {} },
        activeProjectId: null,
      }),
    );

    resolveSecondSave?.(undefined);
    await hardSave;
  });

  it('writes a shadow snapshot immediately when drag overrides change', async () => {
    useDiagramStore.getState().setOverride('nodes', 'n1', { x: 48, y: 96 });

    expect(writeDraftShadow).toHaveBeenCalledTimes(1);
    expect(writeDraftShadow).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'scratch',
        dslText: '',
        activeProjectId: null,
        overrides: {
          nodes: { n1: { x: 48, y: 96 } },
          groups: {},
          edges: {},
        },
      }),
    );

    await vi.waitFor(() => {
      expect(saveDraft).toHaveBeenCalledTimes(1);
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
const { saveDraft, deleteDraft, loadDraft, writeDraftShadow } = vi.hoisted(() => ({
  saveDraft: vi.fn(async () => undefined),
  deleteDraft: vi.fn(async () => undefined),
  loadDraft: vi.fn(async () => null),
  writeDraftShadow: vi.fn(() => undefined),
}));

vi.mock('../../cache/draftCache', () => ({
  deleteDraft,
  loadDraft,
  saveDraft,
  writeDraftShadow,
}));

import { useDiagramStore, type MultiLayerOutput } from '../store';
import {
  addStoredProject,
  getNextProjectName,
  readStoredProjects,
  writeActiveProjectId,
  writeStoredProjects,
  renameStoredProject,
} from '../projectStorage';
import { writeUiPreference } from '../uiPreferences';

describe('project tab loading', () => {
  const storage = new Map<string, string>();

  const sampleMultiLayer: MultiLayerOutput = {
    generatedAt: 1716163200000,
    overview: {
      name: 'Overview',
      description: 'High level',
      dsl: 'overview dsl',
    },
    layers: [
      {
        name: 'API',
        description: 'Requests',
        dsl: 'api dsl',
      },
      {
        name: 'Data',
        description: 'Storage',
        dsl: 'data dsl',
      },
    ],
  };

  const installLocalStorageMock = () => {
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
  };

  beforeEach(() => {
    saveDraft.mockClear();
    deleteDraft.mockClear();
    loadDraft.mockClear();
    writeDraftShadow.mockClear();
    installLocalStorageMock();
    writeStoredProjects([]);
    useDiagramStore.setState({
      dslText: '',
      multiLayer: null,
      activeLayer: 'overview',
      activeProjectId: null,
      generatedProjects: [],
      overrides: { nodes: {}, groups: {}, edges: {} },
      maxMode: false,
      instructionMode: false,
    });
  });

  it('restores the stored multi-layer bundle when reopening a generated project', () => {
    const project = addStoredProject('Repo', 'overview dsl', sampleMultiLayer);

    useDiagramStore.getState().openProject({
      id: project.id,
      dsl: project.dsl,
      multiLayer: project.multiLayer,
    });

    const state = useDiagramStore.getState();
    expect(state.activeProjectId).toBe(project.id);
    expect(state.dslText).toBe('overview dsl');
    expect(state.multiLayer).toEqual(sampleMultiLayer);
    expect(state.activeLayer).toBe('overview');
  });

  it('clears stale multi-layer state when opening a plain example project', () => {
    useDiagramStore.setState({
      multiLayer: sampleMultiLayer,
      activeLayer: 'Data',
      activeProjectId: 'proj-123',
      dslText: 'old dsl',
    });

    useDiagramStore.getState().openProject({
      id: 'default:flow',
      dsl: 'flow example',
    });

    const state = useDiagramStore.getState();
    expect(state.activeProjectId).toBe('default:flow');
    expect(state.dslText).toBe('flow example');
    expect(state.multiLayer).toBeNull();
    expect(state.activeLayer).toBe('overview');
  });

  it('activates and renders a newly generated project atomically', () => {
    const projectId = useDiagramStore
      .getState()
      .addGeneratedProject('Generated Repo', 'generated overview dsl', sampleMultiLayer, 'guide');

    const state = useDiagramStore.getState();
    expect(state.activeProjectId).toBe(projectId);
    expect(state.dslText).toBe('generated overview dsl');
    expect(state.generatedProjects[0]?.id).toBe(projectId);
    expect(state.multiLayer).toEqual(sampleMultiLayer);
    expect(state.activeLayer).toBe('overview');
    expect(state.instructionMarkdown).toBe('guide');
  });

  it('hydrates the active project DSL instead of stale editor scratch text', () => {
    const project = addStoredProject('Huge Repo', 'Frontend\nBackend\nFrontend > Backend');
    writeActiveProjectId(project.id);
    writeUiPreference('dslText', '/');

    useDiagramStore.getState().hydrateUiPreferences();

    const state = useDiagramStore.getState();
    expect(state.activeProjectId).toBe(project.id);
    expect(state.dslText).toBe(project.dsl);
  });

  it('autosaves edits to the active multi-layer DSL tab', () => {
    const project = addStoredProject('Repo', 'overview dsl', sampleMultiLayer);
    useDiagramStore.setState({ generatedProjects: [project] });
    useDiagramStore.getState().openProject({
      id: project.id,
      dsl: project.dsl,
      multiLayer: project.multiLayer,
    });

    useDiagramStore.getState().setActiveLayer('API');
    useDiagramStore.getState().setDsl('api dsl edited');

    const state = useDiagramStore.getState();
    const storedProject = readStoredProjects().find((p) => p.id === project.id);
    expect(state.dslText).toBe('api dsl edited');
    expect(state.multiLayer?.layers.find((layer) => layer.name === 'API')?.dsl).toBe(
      'api dsl edited',
    );
    expect(
      state.generatedProjects[0]?.multiLayer?.layers.find((layer) => layer.name === 'API')?.dsl,
    ).toBe('api dsl edited');
    expect(storedProject?.multiLayer?.layers.find((layer) => layer.name === 'API')?.dsl).toBe(
      'api dsl edited',
    );
    expect(storedProject?.dsl).toBe('overview dsl');
  });

  it('restores the IndexedDB draft over stale project state on hydration', () => {
    const project = addStoredProject('Repo', 'overview dsl', sampleMultiLayer);
    useDiagramStore.setState({ generatedProjects: [project] });
    useDiagramStore.getState().openProject({
      id: project.id,
      dsl: project.dsl,
      multiLayer: project.multiLayer,
    });

    useDiagramStore.getState().setActiveLayer('Data');
    useDiagramStore.getState().applyDraft({
      key: project.id,
      dslText: 'data dsl restored',
      overrides: {
        nodes: { n1: { x: 42, y: 24 } },
        groups: {},
        edges: {},
      },
      activeProjectId: project.id,
      generatedProjects: [project],
      multiLayer: project.multiLayer ?? null,
      activeLayer: 'Data',
      instructionMarkdown: '',
      viewport: { x: 0, y: 0, scale: 1 },
    });

    const state = useDiagramStore.getState();
    expect(state.dslText).toBe('data dsl restored');
    expect(state.overrides.nodes.n1).toEqual({ x: 42, y: 24 });
    expect(state.multiLayer?.layers.find((layer) => layer.name === 'Data')?.dsl).toBe(
      'data dsl restored',
    );
    expect(state.generatedProjects[0]?.multiLayer?.layers.find((layer) => layer.name === 'Data')?.dsl).toBe(
      'data dsl restored',
    );
  });

  it('hydrates the saved DSL for the active multi-layer tab', () => {
    const editedMultiLayer: MultiLayerOutput = {
      ...sampleMultiLayer,
      layers: sampleMultiLayer.layers.map((layer) =>
        layer.name === 'Data' ? { ...layer, dsl: 'data dsl edited' } : layer,
      ),
    };
    const project = addStoredProject('Repo', 'overview dsl', editedMultiLayer);
    writeActiveProjectId(project.id);
    writeUiPreference('activeLayer', 'Data');
    writeUiPreference('dslText', 'stale scratch dsl');

    useDiagramStore.getState().hydrateUiPreferences();

    const state = useDiagramStore.getState();
    expect(state.activeLayer).toBe('Data');
    expect(state.dslText).toBe('data dsl edited');
  });

  it('hydrates max mode from saved ui preferences', () => {
    writeUiPreference('maxMode', true);

    useDiagramStore.getState().hydrateUiPreferences();

    expect(useDiagramStore.getState().maxMode).toBe(true);
  });

  it('hydrates instruction mode from saved ui preferences', () => {
    writeUiPreference('instructionMode', true);

    useDiagramStore.getState().hydrateUiPreferences();

    expect(useDiagramStore.getState().instructionMode).toBe(true);
  });

  it('allocates the smallest vacant project number for auto-created projects', () => {
    addStoredProject('project1', 'one');
    addStoredProject('project2', 'two');
    addStoredProject('project3', 'three');
    renameStoredProject(readStoredProjects()[1]!.id, 'Renamed');

    expect(getNextProjectName()).toBe('project2');

    const project = addStoredProject('project1', 'four');
    expect(project.name).toBe('project2');
  });
});

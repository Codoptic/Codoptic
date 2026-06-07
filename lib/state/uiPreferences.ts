'use client';

import type { LayoutStrategy } from '@/lib/layout/strategies';
import type { ProviderId } from '@/lib/agent/providers/types';

const UI_PREFERENCES_KEY = 'codoptic:ui-preferences:v1';

export type PersistedMode = 'editor' | 'code-space' | 'agent' | 'multi-layer' | 'custom-prompt';
export type PersistedTheme = 'dark' | 'light';
export type PersistedDiagramType = 'architecture' | 'sequence' | 'class' | 'data-flow' | 'deployment';
export type PersistedEditorTab = 'dsl' | 'ir' | 'diagnostics' | 'fix';

export interface PersistedProviderConfig {
  provider?: ProviderId;
  model?: string;
  customModel?: string;
  endpoint?: string;
}

export interface UiPreferences {
  mode?: PersistedMode;
  theme?: PersistedTheme;
  layoutStrategy?: LayoutStrategy;
  diagramType?: PersistedDiagramType;
  focusPrompt?: string;
  activeLayer?: string;
  provider?: PersistedProviderConfig;
  isEditorVisible?: boolean;
  isInspectorVisible?: boolean;
  editorTab?: PersistedEditorTab;
  repoPath?: string;
  repoLocalPath?: string;
  repoSourceType?: 'local' | 'github';
  repoUrl?: string;
  repoIgnoredFolders?: string[];
  dslText?: string;
  instructionMarkdown?: string;
  quickMode?: boolean;
  maxMode?: boolean;
  instructionMode?: boolean;
  isInspectorPropertiesVisible?: boolean;
  isInstructionVisible?: boolean;
}

const MODES = new Set<PersistedMode>(['editor', 'code-space', 'agent', 'multi-layer', 'custom-prompt']);
const THEMES = new Set<PersistedTheme>(['dark', 'light']);
const DIAGRAM_TYPES = new Set<PersistedDiagramType>(['architecture', 'sequence', 'class', 'data-flow', 'deployment']);
const EDITOR_TABS = new Set<PersistedEditorTab>(['dsl', 'ir', 'diagnostics', 'fix']);
const PROVIDERS = new Set<ProviderId>(['openai', 'anthropic', 'gemini', 'grok', 'foundry', 'mistral', 'deepseek', 'nvidia', 'openrouter']);
const LAYOUT_STRATEGIES = new Set<LayoutStrategy>(['auto', 'layered', 'force-lite', 'grid-cluster', 'manual']);

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeProvider(value: unknown): PersistedProviderConfig | undefined {
  if (!isRecord(value)) return undefined;

  const provider: PersistedProviderConfig = {};
  if (typeof value.provider === 'string' && PROVIDERS.has(value.provider as ProviderId)) {
    provider.provider = value.provider as ProviderId;
  }
  if (typeof value.model === 'string') provider.model = value.model;
  if (typeof value.customModel === 'string') provider.customModel = value.customModel;
  if (typeof value.endpoint === 'string') provider.endpoint = value.endpoint;

  return Object.keys(provider).length > 0 ? provider : undefined;
}

function sanitizePreferences(value: unknown): UiPreferences {
  if (!isRecord(value)) return {};

  const preferences: UiPreferences = {};
  if (typeof value.mode === 'string' && MODES.has(value.mode as PersistedMode)) {
    preferences.mode = value.mode as PersistedMode;
  }
  if (typeof value.theme === 'string' && THEMES.has(value.theme as PersistedTheme)) {
    preferences.theme = value.theme as PersistedTheme;
  }
  if (typeof value.layoutStrategy === 'string' && LAYOUT_STRATEGIES.has(value.layoutStrategy as LayoutStrategy)) {
    preferences.layoutStrategy = value.layoutStrategy as LayoutStrategy;
  }
  if (typeof value.diagramType === 'string' && DIAGRAM_TYPES.has(value.diagramType as PersistedDiagramType)) {
    preferences.diagramType = value.diagramType as PersistedDiagramType;
  }
  if (typeof value.focusPrompt === 'string') preferences.focusPrompt = value.focusPrompt;
  if (typeof value.dslText === 'string') preferences.dslText = value.dslText;
  if (typeof value.instructionMarkdown === 'string') preferences.instructionMarkdown = value.instructionMarkdown;
  if (typeof value.activeLayer === 'string') preferences.activeLayer = value.activeLayer;
  if (typeof value.isEditorVisible === 'boolean') preferences.isEditorVisible = value.isEditorVisible;
  if (typeof value.isInspectorVisible === 'boolean') preferences.isInspectorVisible = value.isInspectorVisible;
  if (typeof value.isInspectorPropertiesVisible === 'boolean') {
    preferences.isInspectorPropertiesVisible = value.isInspectorPropertiesVisible;
  }
  if (typeof value.isInstructionVisible === 'boolean') preferences.isInstructionVisible = value.isInstructionVisible;
  if (typeof value.editorTab === 'string' && EDITOR_TABS.has(value.editorTab as PersistedEditorTab)) {
    preferences.editorTab = value.editorTab as PersistedEditorTab;
  }
  if (typeof value.repoPath === 'string') preferences.repoPath = value.repoPath;
  if (typeof value.repoLocalPath === 'string') preferences.repoLocalPath = value.repoLocalPath;
  if (value.repoSourceType === 'local' || value.repoSourceType === 'github') {
    preferences.repoSourceType = value.repoSourceType;
  }
  if (typeof value.repoUrl === 'string') preferences.repoUrl = value.repoUrl;
  if (Array.isArray(value.repoIgnoredFolders)) {
    preferences.repoIgnoredFolders = value.repoIgnoredFolders.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value.quickMode === 'boolean') preferences.quickMode = value.quickMode;
  if (typeof value.maxMode === 'boolean') preferences.maxMode = value.maxMode;
  if (typeof value.instructionMode === 'boolean') preferences.instructionMode = value.instructionMode;

  const provider = sanitizeProvider(value.provider);
  if (provider) preferences.provider = provider;

  return preferences;
}

export function readUiPreferences(): UiPreferences {
  if (!canUseLocalStorage()) return {};

  try {
    return sanitizePreferences(JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) ?? '{}'));
  } catch {
    return {};
  }
}

export function readUiPreference<K extends keyof UiPreferences>(key: K): UiPreferences[K] | undefined {
  return readUiPreferences()[key];
}

export function writeUiPreference<K extends keyof UiPreferences>(key: K, value: UiPreferences[K]): void {
  if (!canUseLocalStorage()) return;

  const preferences = readUiPreferences();
  if (value === undefined) {
    delete preferences[key];
  } else {
    preferences[key] = value;
  }

  try {
    window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // QuotaExceededError or similar — swallow so callers (Monaco onChange, setDsl) keep working.
  }
}

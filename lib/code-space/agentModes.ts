export const CODE_SPACE_AGENT_MODES = ['ask', 'plan', 'code'] as const;

export type CodeSpaceAgentMode = (typeof CODE_SPACE_AGENT_MODES)[number];

export interface CodeSpaceAgentModeMeta {
  mode: CodeSpaceAgentMode;
  label: string;
  description: string;
  accentClassName: string;
  buttonClassName: string;
  menuItemClassName: string;
  readOnly: boolean;
  createsPlanMarkdown: boolean;
}

export const DEFAULT_CODE_SPACE_AGENT_MODE: CodeSpaceAgentMode = 'code';

export const CODE_SPACE_AGENT_MODE_META: Record<CodeSpaceAgentMode, CodeSpaceAgentModeMeta> = {
  ask: {
    mode: 'ask',
    label: 'Ask',
    description: 'Answer questions from project context without changing files.',
    accentClassName: 'text-[#3fb950]',
    buttonClassName: 'border-[#30363d] bg-[#21262d] text-[#7ee787] hover:border-[#484f58] hover:bg-[#30363d]',
    menuItemClassName: 'text-[#7ee787] hover:bg-[#12331f]',
    readOnly: true,
    createsPlanMarkdown: false,
  },
  plan: {
    mode: 'plan',
    label: 'Plan',
    description: 'Analyze deeply, clarify scope, and write an editable markdown plan.',
    accentClassName: 'text-[#a371f7]',
    buttonClassName: 'border-[#30363d] bg-[#21262d] text-[#d2a8ff] hover:border-[#484f58] hover:bg-[#30363d]',
    menuItemClassName: 'text-[#d2a8ff] hover:bg-[#2b1b40]',
    readOnly: false,
    createsPlanMarkdown: true,
  },
  code: {
    mode: 'code',
    label: 'Code',
    description: 'Analyze, plan, and proceed toward implementation.',
    accentClassName: 'text-[#58a6ff]',
    buttonClassName: 'border-[#30363d] bg-[#21262d] text-[#79b8ff] hover:border-[#484f58] hover:bg-[#30363d]',
    menuItemClassName: 'text-[#79b8ff] hover:bg-[#112b55]',
    readOnly: false,
    createsPlanMarkdown: false,
  },
};

export function normalizeCodeSpaceAgentMode(value: unknown): CodeSpaceAgentMode {
  if (value === 'ask' || value === 'plan' || value === 'code') return value;
  if (value === 'agent' || value === 'edit' || value === 'debug' || value === 'review' || value === 'chat') return 'code';
  return DEFAULT_CODE_SPACE_AGENT_MODE;
}

export function getCodeSpaceAgentModeMeta(mode: unknown): CodeSpaceAgentModeMeta {
  return CODE_SPACE_AGENT_MODE_META[normalizeCodeSpaceAgentMode(mode)];
}

export function isCodeSpaceReadOnlyMode(mode: unknown): boolean {
  return getCodeSpaceAgentModeMeta(mode).readOnly;
}

export function isCodeSpacePlanMode(mode: unknown): boolean {
  return normalizeCodeSpaceAgentMode(mode) === 'plan';
}

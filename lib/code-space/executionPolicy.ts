export const CODE_SPACE_EXECUTION_POLICIES = ['auto', 'manual'] as const;

export type CodeSpaceExecutionPolicy = (typeof CODE_SPACE_EXECUTION_POLICIES)[number];

export interface CodeSpaceExecutionPolicyMeta {
  policy: CodeSpaceExecutionPolicy;
  label: string;
  description: string;
  accentClassName: string;
  buttonClassName: string;
  menuItemClassName: string;
}

export const DEFAULT_CODE_SPACE_EXECUTION_POLICY: CodeSpaceExecutionPolicy = 'manual';

export const CODE_SPACE_EXECUTION_POLICY_META: Record<CodeSpaceExecutionPolicy, CodeSpaceExecutionPolicyMeta> = {
  auto: {
    policy: 'auto',
    label: 'Auto',
    description: 'Queue generated changes visibly first, then apply only after the server explicitly marks a patch as safe for auto-apply.',
    accentClassName: 'text-[#f85149]',
    buttonClassName: 'border-[#30363d] bg-[#21262d] text-[#fb7185] hover:border-[#484f58] hover:bg-[#30363d]',
    menuItemClassName: 'text-[#fb7185] hover:bg-[#3b151f]',
  },
  manual: {
    policy: 'manual',
    label: 'Confirm',
    description: 'Review-first mode: keep generated diffs pending for editor review before accepting them, and never leave a run spinning after the stream ends.',
    accentClassName: 'text-[#3fb950]',
    buttonClassName: 'border-[#30363d] bg-[#21262d] text-[#7ee787] hover:border-[#484f58] hover:bg-[#30363d]',
    menuItemClassName: 'text-[#7ee787] hover:bg-[#12331f]',
  },
};

export function normalizeCodeSpaceExecutionPolicy(value: unknown): CodeSpaceExecutionPolicy {
  if (value === 'auto' || value === 'manual') return value;
  return DEFAULT_CODE_SPACE_EXECUTION_POLICY;
}

export function isCodeSpaceAutoExecutionPolicy(policy: unknown): boolean {
  return normalizeCodeSpaceExecutionPolicy(policy) === 'auto';
}

export function shouldAutoApplyCodeSpaceDiffs(_policy: unknown, autoApplied = false): boolean {
  // Root Cause vs Logic: the UI previously consumed a `diff_proposed` event in Auto mode before the
  // patch was visible. If apply then failed or the active project snapshot was stale, users saw a
  // completion summary but no Code changes card and no file mutation. Runtime patches should remain
  // visible unless the server explicitly flags the event as already safe for auto-apply.
  return autoApplied === true;
}

export function getCodeSpaceExecutionPolicyMeta(policy: unknown): CodeSpaceExecutionPolicyMeta {
  return CODE_SPACE_EXECUTION_POLICY_META[normalizeCodeSpaceExecutionPolicy(policy)];
}

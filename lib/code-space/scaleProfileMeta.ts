import {
  RUNTIME_SCALE_PROFILES,
  normalizeRuntimeScaleProfile,
  type RuntimeScaleProfile,
} from '@/lib/code-space/runtime/scaleProfile';

export type { RuntimeScaleProfile };

export interface RuntimeScaleProfileMeta {
  profile: RuntimeScaleProfile;
  label: string;
  shortLabel: string;
  description: string;
  accentClassName: string;
  buttonClassName: string;
  menuItemClassName: string;
}

export const DEFAULT_RUNTIME_SCALE_PROFILE: RuntimeScaleProfile = 'deep';

export const RUNTIME_SCALE_PROFILE_META: Record<RuntimeScaleProfile, RuntimeScaleProfileMeta> = {
  standard: {
    profile: 'standard',
    label: 'Standard',
    shortLabel: 'Std',
    description: 'Lightweight runs with tight subagent, repair, and time limits.',
    accentClassName: 'text-[#e3b341]',
    buttonClassName: 'border-[#30363d] bg-[#21262d] text-[#e3b341] hover:border-[#484f58] hover:bg-[#30363d]',
    menuItemClassName: 'text-[#e3b341] hover:bg-[#2d2410]',
  },
  deep: {
    profile: 'deep',
    label: 'Deep',
    shortLabel: 'Deep',
    description: 'Balanced scale for most coding tasks with moderate delegation headroom.',
    accentClassName: 'text-[#56d4dd]',
    buttonClassName: 'border-[#30363d] bg-[#21262d] text-[#56d4dd] hover:border-[#484f58] hover:bg-[#30363d]',
    menuItemClassName: 'text-[#56d4dd] hover:bg-[#102a2e]',
  },
  massive: {
    profile: 'massive',
    label: 'Massive',
    shortLabel: 'Max',
    description: 'High parallelism and longer wall-clock budget for large multi-file work.',
    accentClassName: 'text-[#f0883e]',
    buttonClassName: 'border-[#30363d] bg-[#21262d] text-[#f0883e] hover:border-[#484f58] hover:bg-[#30363d]',
    menuItemClassName: 'text-[#f0883e] hover:bg-[#2d1c10]',
  },
  full_access_local: {
    profile: 'full_access_local',
    label: 'Full Access',
    shortLabel: 'Full',
    description: 'Maximum local runtime access, delegation depth, and repair headroom.',
    accentClassName: 'text-[#f85149]',
    buttonClassName: 'border-[#30363d] bg-[#21262d] text-[#fb7185] hover:border-[#484f58] hover:bg-[#30363d]',
    menuItemClassName: 'text-[#fb7185] hover:bg-[#3b151f]',
  },
};

export function getRuntimeScaleProfileMeta(profile: unknown): RuntimeScaleProfileMeta {
  return RUNTIME_SCALE_PROFILE_META[normalizeRuntimeScaleProfile(profile)];
}

export { RUNTIME_SCALE_PROFILES, normalizeRuntimeScaleProfile };

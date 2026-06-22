export const RUNTIME_SCALE_PROFILES = ['standard', 'deep', 'massive', 'full_access_local'] as const;

export type RuntimeScaleProfile = (typeof RUNTIME_SCALE_PROFILES)[number];

export interface RuntimeScaleLimits {
  profile: RuntimeScaleProfile;
  maxAutomaticSubagents: number;
  maxSubagentConcurrency: number;
  maxSubagentToolCalls: number;
  maxWorkPackages: number;
  maxDepth: number;
  maxWallClockMs: number;
  maxSpendUnits: number;
  maxRepairAttempts: number;
  repeatedFailureLimit: number;
}

const LIMITS: Record<RuntimeScaleProfile, RuntimeScaleLimits> = {
  standard: {
    profile: 'standard',
    maxAutomaticSubagents: 3,
    maxSubagentConcurrency: 2,
    maxSubagentToolCalls: 14,
    maxWorkPackages: 3,
    maxDepth: 1,
    maxWallClockMs: 10 * 60_000,
    maxSpendUnits: 80,
    maxRepairAttempts: 2,
    repeatedFailureLimit: 2,
  },
  deep: {
    profile: 'deep',
    maxAutomaticSubagents: 6,
    maxSubagentConcurrency: 3,
    maxSubagentToolCalls: 28,
    maxWorkPackages: 8,
    maxDepth: 2,
    maxWallClockMs: 25 * 60_000,
    maxSpendUnits: 180,
    maxRepairAttempts: 3,
    repeatedFailureLimit: 3,
  },
  massive: {
    profile: 'massive',
    maxAutomaticSubagents: 16,
    maxSubagentConcurrency: 5,
    maxSubagentToolCalls: 48,
    maxWorkPackages: 24,
    maxDepth: 3,
    maxWallClockMs: 90 * 60_000,
    maxSpendUnits: 600,
    maxRepairAttempts: 5,
    repeatedFailureLimit: 3,
  },
  full_access_local: {
    profile: 'full_access_local',
    maxAutomaticSubagents: 24,
    maxSubagentConcurrency: 6,
    maxSubagentToolCalls: 64,
    maxWorkPackages: 32,
    maxDepth: 3,
    maxWallClockMs: 120 * 60_000,
    maxSpendUnits: 900,
    maxRepairAttempts: 5,
    repeatedFailureLimit: 4,
  },
};

export function normalizeRuntimeScaleProfile(value: unknown, mode: 'ask' | 'plan' | 'code' = 'code'): RuntimeScaleProfile {
  if (value === 'standard' || value === 'deep' || value === 'massive' || value === 'full_access_local') return value;
  return mode === 'code' ? 'deep' : 'standard';
}

export function runtimeScaleLimits(profile: unknown, mode: 'ask' | 'plan' | 'code' = 'code'): RuntimeScaleLimits {
  return LIMITS[normalizeRuntimeScaleProfile(profile, mode)];
}

export function profileAllowsFullLocalAccess(profile: unknown): boolean {
  return normalizeRuntimeScaleProfile(profile) === 'full_access_local';
}

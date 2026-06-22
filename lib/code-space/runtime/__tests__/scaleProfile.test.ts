import { describe, expect, it } from 'vitest';
import { normalizeRuntimeScaleProfile, runtimeScaleLimits } from '../scaleProfile';

describe('runtime scale profiles', () => {
  it('defaults Code mode to deep and non-Code modes to standard', () => {
    expect(normalizeRuntimeScaleProfile(undefined, 'code')).toBe('deep');
    expect(normalizeRuntimeScaleProfile(undefined, 'plan')).toBe('standard');
  });

  it('expands subagent and repair limits for massive profiles', () => {
    const deep = runtimeScaleLimits('deep', 'code');
    const massive = runtimeScaleLimits('massive', 'code');
    expect(massive.maxAutomaticSubagents).toBeGreaterThan(deep.maxAutomaticSubagents);
    expect(massive.maxSubagentConcurrency).toBeGreaterThan(deep.maxSubagentConcurrency);
    expect(massive.maxRepairAttempts).toBeGreaterThanOrEqual(deep.maxRepairAttempts);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CODE_SPACE_EXECUTION_POLICY,
  getCodeSpaceExecutionPolicyMeta,
  isCodeSpaceAutoExecutionPolicy,
  normalizeCodeSpaceExecutionPolicy,
  shouldAutoApplyCodeSpaceDiffs,
} from '../executionPolicy';

describe('Code Space execution policy', () => {
  it('defaults unknown values to manual confirmation mode', () => {
    expect(DEFAULT_CODE_SPACE_EXECUTION_POLICY).toBe('manual');
    expect(normalizeCodeSpaceExecutionPolicy(undefined)).toBe('manual');
    expect(normalizeCodeSpaceExecutionPolicy('surprise')).toBe('manual');
  });

  it('uses red for auto and green for confirm', () => {
    expect(getCodeSpaceExecutionPolicyMeta('auto').accentClassName).toBe('text-[#f85149]');
    expect(getCodeSpaceExecutionPolicyMeta('manual').accentClassName).toBe('text-[#3fb950]');
    expect(getCodeSpaceExecutionPolicyMeta('auto').label).toBe('Auto');
    expect(getCodeSpaceExecutionPolicyMeta('manual').label).toBe('Confirm');
    expect(getCodeSpaceExecutionPolicyMeta('manual').description).toContain('Review-first mode');
  });

  it('recognizes auto mode and auto-applied diffs', () => {
    expect(isCodeSpaceAutoExecutionPolicy('auto')).toBe(true);
    expect(isCodeSpaceAutoExecutionPolicy('manual')).toBe(false);
    // Auto-apply is gated on the server's explicit autoApplied flag, not on the UI policy alone,
    // so a proposed diff stays visible until the runtime confirms it was already applied safely.
    expect(shouldAutoApplyCodeSpaceDiffs('auto')).toBe(false);
    expect(shouldAutoApplyCodeSpaceDiffs('auto', true)).toBe(true);
    expect(shouldAutoApplyCodeSpaceDiffs('manual', true)).toBe(true);
    expect(shouldAutoApplyCodeSpaceDiffs('manual', false)).toBe(false);
  });
});

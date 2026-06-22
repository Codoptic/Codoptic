import { describe, expect, it } from 'vitest';
import {
  formatAutonomyBlockedToolMessage,
  formatAutonomyToolGuidance,
  isAutonomyPolicyFailureRecoverable,
  isSuggestOnlySelectiveWritePath,
} from '../autonomyPolicy';
import { buildCodeSystemPrompt } from '../codeAgentLoop';

describe('autonomyPolicy', () => {
  it('documents allowed and blocked tools for suggest_only', () => {
    const guidance = formatAutonomyToolGuidance('suggest_only');
    expect(guidance).toContain('harness_context');
    expect(guidance).toContain('edit_file');
    expect(guidance).toContain('.agent/tests/');
    expect(guidance).toContain('run_command');
    expect(guidance).toMatch(/never retry/i);
  });

  it('returns non-recoverable policy failures under suggest_only', () => {
    expect(isAutonomyPolicyFailureRecoverable('suggest_only', 'blocked')).toBe(false);
    expect(isAutonomyPolicyFailureRecoverable('suggest_only', 'approval_required')).toBe(false);
    expect(isAutonomyPolicyFailureRecoverable('auto_safe_tools', 'approval_required')).toBe(true);
  });

  it('steers blocked tools toward allowed alternatives', () => {
    const message = formatAutonomyBlockedToolMessage('run_command', 'suggest_only', 'Suggest-only mode forbids mutating tool execution.');
    expect(message).toMatch(/do not retry/i);
    expect(message).toMatch(/edit_file/i);
    expect(message).toMatch(/harness_context|read_file/i);
  });

  it('recognizes selective write paths', () => {
    expect(isSuggestOnlySelectiveWritePath('.agent/tests/check.py')).toBe(true);
    expect(isSuggestOnlySelectiveWritePath('src/app.ts')).toBe(false);
  });
});

describe('buildCodeSystemPrompt autonomy guidance', () => {
  it('embeds confirm-mode tool policy in the code system prompt', () => {
    const prompt = buildCodeSystemPrompt('demo', [], 'suggest_only');
    expect(prompt).toContain('Autonomy policy (Confirm / suggest_only');
    expect(prompt).toContain('Propose source edits with edit_file only');
  });
});

import type { AutonomyLevel } from '@/lib/code-space/domain';
import type { ToolPermission } from './toolRegistry';
import { isReadOnlyTool } from './toolBudget';

/** Registry tools that may run under suggest_only but only emit proposals (no user source writes). */
export const SUGGEST_ONLY_PROPOSE_REGISTRY_TOOLS = new Set([
  'edit_file',
  'propose_edit_blocks',
  'propose_patch',
  'create_files',
  'propose_memory_update',
]);

/** Paths edit_file may write to disk even under suggest_only (ephemeral agent artifacts). */
export const SUGGEST_ONLY_SELECTIVE_WRITE_PREFIXES = ['.agent/tests'];

export function isSuggestOnlyProposeRegistryTool(name: string): boolean {
  return SUGGEST_ONLY_PROPOSE_REGISTRY_TOOLS.has(name);
}

export function isSuggestOnlySelectiveWritePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return SUGGEST_ONLY_SELECTIVE_WRITE_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

export function canRegistryToolAutoRunUnderSuggestOnly(registryToolName: string, riskLevel: string): boolean {
  if (riskLevel === 'safe' || isReadOnlyTool(registryToolName)) return true;
  if (isSuggestOnlyProposeRegistryTool(registryToolName)) return true;
  return false;
}

export function isAutonomyPolicyFailureRecoverable(autonomy: AutonomyLevel, permission: ToolPermission): boolean {
  if (autonomy === 'suggest_only') return false;
  return permission === 'approval_required';
}

const SUGGEST_ONLY_BLOCKED_ALTERNATIVES: Record<string, string> = {
  run_command:
    'use read_file, search_text, git_status, git_diff, harness_context, or scan_code_quality for inspection; use edit_file to propose source changes.',
  terminal_start:
    'use read-only repository tools instead of an interactive terminal; propose edits with edit_file.',
  terminal_write:
    'use read-only repository tools instead of an interactive terminal.',
  terminal_read:
    'use read-only repository tools instead of an interactive terminal.',
  terminal_wait:
    'use read-only repository tools instead of an interactive terminal.',
  terminal_signal:
    'use read-only repository tools instead of an interactive terminal.',
  terminal_close:
    'use read-only repository tools instead of an interactive terminal.',
  run_validation_matrix:
    'skip live validation in Confirm mode — the user runs validation after accepting proposed patches; finish with edit_file proposals instead.',
  apply_patch:
    'use edit_file to propose SEARCH/REPLACE edits for user review.',
  restore_checkpoint:
    'Confirm mode does not apply or restore checkpoints; propose the needed edits with edit_file.',
  propose_edit_blocks:
    'call edit_file with SEARCH/REPLACE blocks — proposals are recorded automatically under Confirm mode.',
  create_directory:
    'use create_files to propose a tracked <directory>/.gitkeep file, or switch autonomy before creating an untracked empty directory.',
};

export function suggestOnlyBlockedAlternative(registryToolName: string): string {
  return (
    SUGGEST_ONLY_BLOCKED_ALTERNATIVES[registryToolName] ??
    'use read-only inspection tools (read_file, search_text, harness_context) and edit_file to propose changes.'
  );
}

export function formatAutonomyBlockedToolMessage(
  toolName: string,
  autonomy: AutonomyLevel,
  reason: string,
): string {
  if (autonomy !== 'suggest_only') {
    return `${toolName} requires approval under autonomy "${autonomy}". ${reason}`;
  }
  return [
    `${toolName} is blocked under suggest_only (Confirm mode): ${reason}`,
    'Do not retry this tool in this run.',
    `Instead: ${suggestOnlyBlockedAlternative(toolName)}`,
  ].join(' ');
}

// Motivation vs Logic: models treated autonomy policy blocks as external deadlocks and retried mutating
// tools forever. Pin allowed vs blocked tools in the system prompt and seed so Confirm-mode runs
// inspect freely, propose with edit_file, and only write ephemeral .agent/tests/ scripts when needed.
export function formatAutonomyToolGuidance(autonomy: AutonomyLevel): string {
  if (autonomy !== 'suggest_only') return '';
  return [
    'Autonomy policy (Confirm / suggest_only — user reviews patches before anything hits source files):',
    '- Inspect freely: read_file, list_files, search_text, repo_map, dependency_trace, git_status, git_diff, harness_context, research_web, scan_code_quality, read_artifact, grep_artifact.',
    '- Propose user-source edits with edit_file (exact SEARCH/REPLACE) and new files with create_files. Proposals enter the review queue; disk source stays unchanged until the user accepts.',
    '- Selective writes allowed: edit_file may write ephemeral verification scripts under .agent/tests/ only.',
    '- Propose durable memories with propose_memory_update (does not write /memories until approved).',
    '- Blocked for this run: run_command, terminal_*, apply_patch, restore_checkpoint, create_directory with untracked directories, run_validation_matrix. Validation runs after the user accepts proposals.',
    '- Policy blocks are not repository failures — never retry a blocked tool; switch to an allowed tool above.',
    '- attempt_completion(success=true) is valid once the required edit_file proposals exist, even though user source files are not written yet.',
  ].join('\n');
}

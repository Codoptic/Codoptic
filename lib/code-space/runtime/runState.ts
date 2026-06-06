export const CODE_SPACE_RUN_PHASES = [
  'created',
  'classifying',
  'loading_project_rules',
  'mapping_repository',
  'gathering_context',
  'tracing_dependencies',
  'planning',
  'awaiting_clarification',
  'proposing_patch',
  'awaiting_patch_review',
  'diff_review_emitted',
  'awaiting_diff_confirmation',
  'applying_patch',
  'validating',
  'repairing',
  'verified',
  'needs_review',
  'failed',
  'cancelled',
] as const;

export type CodeSpaceRunPhase = (typeof CODE_SPACE_RUN_PHASES)[number];

export interface CodeSpaceRunState {
  runId: string;
  phase: CodeSpaceRunPhase;
  status: 'running' | 'verified' | 'needs_review' | 'failed' | 'cancelled';
  updatedAt: number;
}

export function createRunState(runId: string): CodeSpaceRunState {
  return { runId, phase: 'created', status: 'running', updatedAt: Date.now() };
}

export function transitionRunState(
  state: CodeSpaceRunState,
  phase: CodeSpaceRunPhase,
): CodeSpaceRunState {
  const terminalStatus =
    phase === 'verified'
      ? 'verified'
      : phase === 'needs_review'
        ? 'needs_review'
        : phase === 'failed'
          ? 'failed'
          : phase === 'cancelled'
            ? 'cancelled'
            : 'running';

  return { ...state, phase, status: terminalStatus, updatedAt: Date.now() };
}

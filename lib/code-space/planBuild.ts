import type { CodeSpaceAgentMode } from './agentModes';

export interface CodeSpacePromptOptions {
  modeOverride?: CodeSpaceAgentMode;
  buildPlanPath?: string;
  agentPrompt?: string;
}

export function appendInstructionToPrompt(prompt: string, instruction?: string | null): string {
  const trimmedInstruction = instruction?.trim();
  if (!trimmedInstruction) return prompt;

  // Motivation vs Logic: Code Space should honor user-specific coding preferences without forcing every caller to duplicate prompt stitching, so we keep the merge rule in one reusable helper.
  return [prompt, '', 'Additional instruction for user customization:', trimmedInstruction].join('\n');
}

export function buildPlanImplementationPrompt(filePath: string): string {
  return [
    `Build from the approved plan at ${filePath}.`,
    '',
    'Read that plan artifact first and treat it as the source of truth for the implementation goal.',
    'If the plan contains a "New Implementations" section, create that manifest first with create_files/create_directory before modifying existing files.',
    'Before proposing edits, gather the target files plus related imports, tests, docs, configs, and runtime surfaces so the patch is grounded in current workspace evidence.',
    'Use Code mode to create concrete reviewable file changes through the patch pipeline instead of returning only an advisory summary. For scratch-project plans, create real project files in coherent batches, then validate the runnable path.',
    'Run the detected validation strategy when available, inspect failures, make bounded repair attempts for failures caused by the change, and finish with verified changes or a needs_review summary with exact blockers.',
    'If the plan is outdated or conflicts with the current workspace, explain the conflict and make the smallest safe adjustment instead of generating another plan.',
  ].join('\n');
}

export function extractBuildPlanPath(prompt: string): string | null {
  const match = prompt.match(/\bplan at\s+([^\s.][^\s]*|(?:\.{1,2}\/)?[^\s]+|\.agent\/plans\/[^\s]+)/i);
  const candidate = match?.[1]?.replace(/[),.;:]+$/g, '');
  if (!candidate) return null;
  return candidate.replace(/\\/g, '/').replace(/^\/+/, '');
}

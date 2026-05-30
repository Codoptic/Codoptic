import {
  buildCodeCompletionResponse,
  buildPlanCompletionResponse,
  tightenAgentSummary,
  type CodeResponseInput,
  type PlanResponseInput,
  type RunValidationResult,
} from '@/lib/code-space/agent/runResponses';

export { tightenAgentSummary };

export function buildAskFinalResponse(input: {
  projectName: string;
  prompt: string;
  evidence: Array<{ path: string; summary: string; content?: string }>;
  missingContextWarnings?: string[];
}): string {
  if (!input.evidence.length) {
    return `I could not find enough readable repository evidence in ${input.projectName} to answer that confidently.`;
  }
  const critical = input.evidence.slice(0, 4).map((file) => `\`${file.path}\``);
  const warnings = input.missingContextWarnings?.length ? ` Missing evidence: ${input.missingContextWarnings.join('; ')}.` : '';
  return `Based on the repository evidence, the relevant surface is ${critical.join(', ')}. ${input.evidence[0]?.summary ?? 'The selected files contain the key implementation path.'}${warnings}`;
}

export function buildPlanFinalResponse(input: PlanResponseInput): string {
  return buildPlanCompletionResponse(input);
}

export function buildCodeFinalResponse(input: CodeResponseInput): string {
  return buildCodeCompletionResponse(input);
}

/**
 * Confirm-mode (suggest_only) completion: the agent proposed edits but wrote nothing.
 * The summary points the user at the accept/reject panel rather than claiming applied work.
 */
export function buildCodeProposalResponse(projectName: string, proposedFiles: string[], summary?: string): string {
  const lead = summary?.trim() ? `${summary.trim().replace(/\s+/g, ' ').slice(0, 240)} ` : '';
  const list = proposedFiles.slice(0, 5).map((path) => `\`${path}\``);
  const suffix = proposedFiles.length > list.length ? `, and ${proposedFiles.length - list.length} more` : '';
  const count = `${proposedFiles.length} file${proposedFiles.length === 1 ? '' : 's'}`;
  return `${lead}Proposed changes to ${count} in ${projectName}: ${formatList(list)}${suffix}. Review them in the Code changes panel and accept to apply, or reject to discard — nothing was written to disk in Confirm mode.`;
}

function formatList(items: string[]): string {
  if (!items.length) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function validationStatus(results: RunValidationResult[]): 'passed' | 'failed' | 'skipped' {
  if (!results.length) return 'skipped';
  if (results.some((result) => result.status === 'failed')) return 'failed';
  if (results.some((result) => result.status === 'skipped')) return 'skipped';
  return 'passed';
}

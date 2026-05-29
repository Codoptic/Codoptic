import type { ToolSpec } from '@/lib/agent/providers';
import type { ContextGraphResult } from './contextGraphEngine';
import { listRepositoryFiles } from './repoMap';
import { isReadOnlyTool } from './toolBudget';
import { CODE_MODE_TOOL_SPECS } from './toolExecutor';
import { selectEvidenceFiles } from './codeAgentLoop';
import { REQUIRED_PLAN_SECTIONS } from './planningEngine';
import {
  buildWorkflowKernelPrompt,
  formatContextSufficiencyMarkdown,
  formatWorkflowDodMarkdown,
  type ContextSufficiencyReport,
} from './workflowPolicy';

const MAX_EVIDENCE_FILES = 24;
const MAX_EVIDENCE_CHARS = 16_000;
const MAX_INDEX_ENTRIES = 800;

/** Terminal tools unique to Plan mode. They signal completion via CodeAgentContext fields. */
const PLAN_TERMINAL_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'ask_clarifying_questions',
    description:
      'Ask the user up to 3 clarifying questions ONLY when missing information would materially change scope, safety, architecture, or acceptance criteria. Each question may offer choices. Calling this pauses the run for the user to answer; do not also call write_plan_artifact in the same turn.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              choices: { type: 'array', items: { type: 'string' } },
              allowMultiple: { type: 'boolean' },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'write_plan_artifact',
    description:
      'Finalize the implementation plan. Provide the complete plan markdown you authored from the evidence you actually read. It MUST contain every required section heading. Set status="ready" only when the context-sufficiency gate is satisfied; otherwise status="needs_review" with the exact blocker. Stop after this call.',
    inputSchema: {
      type: 'object',
      properties: {
        planMarkdown: { type: 'string' },
        summary: { type: 'string' },
        inspectedFiles: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['ready', 'needs_review'] },
      },
      required: ['planMarkdown', 'summary'],
    },
  },
];

/** Read-only Code-mode tools (single-sourced) plus the two Plan terminal tools. */
export const PLAN_MODE_TOOL_SPECS: ToolSpec[] = [
  ...CODE_MODE_TOOL_SPECS.filter((spec) => isReadOnlyTool(spec.name)),
  ...PLAN_TERMINAL_TOOL_SPECS,
];

export function buildPlanSystemPrompt(projectName: string, instructionFiles: string[]): string {
  return [
    buildWorkflowKernelPrompt('plan'),
    '',
    `You are Code Space's planning agent for the "${projectName}" repository. You produce an implementation-grade plan that a separate coding agent will execute.`,
    'Behave like a senior engineer scoping a change: resolve intent, read the exact files and line ranges that matter, and only then author the plan. Do NOT write code and do NOT edit source files — your only mutation is the plan artifact.',
    '',
    'Workflow you must follow:',
    '1. Resolve intent. If missing information would materially change scope, safety, architecture, or acceptance criteria, call ask_clarifying_questions (max 3). Otherwise state assumptions and continue.',
    '2. Gather real evidence with read_file (use startLine/endLine to read precise ranges), search_text, dependency_trace, repo_map, and git tools. Do not rely on filenames alone — read the code.',
    '3. Respect the context-sufficiency gate. If it is not satisfied, recall more files/imports/tests/configs before finalizing.',
    '4. Author the plan yourself, grounded in what you actually read: narrow the intent, protect scope with explicit non-goals, prevent duplicate/speculative architecture, name the specific files with per-file changes and reasons (cite line ranges where helpful), and order small milestones.',
    '5. Call write_plan_artifact exactly once with the complete markdown. Then stop.',
    '',
    'The plan markdown MUST include these section headings verbatim:',
    ...REQUIRED_PLAN_SECTIONS.map((section) => `- ## ${section}`),
    '',
    'Hard rules:',
    '- Prefer the smallest coherent change; never invent services, dependencies, databases, queues, or broad rewrites without repository evidence.',
    '- Every major change must tie back to the user objective.',
    '- Be honest: if assumptions are wrong or evidence is missing, set the plan status to needs_review with the exact blocker rather than guessing.',
    instructionFiles.length ? `\nProject instruction files in effect: ${instructionFiles.join(', ')}. Honor their conventions.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Re-prompt used when the planning loop ended without authoring a plan (models often emit the plan
 * as prose instead of calling the tool). It keeps the agent recalling evidence AND forces it to
 * finalize via write_plan_artifact (or ask_clarifying_questions if genuinely blocked).
 */
export function buildPlanFinalizationDirective(sufficiency: ContextSufficiencyReport): string {
  const lines = [
    'You have not produced a plan yet, and you answered in prose instead of calling a tool. That is not allowed.',
    'Keep investigating with read_file / search_text / dependency_trace if you still need evidence — do not give up on finding context.',
  ];
  if (sufficiency.status === 'needs_recall' && (sufficiency.recommendedRecall.length || sufficiency.requiredEvidence.length)) {
    lines.push('', 'The context gate still wants more evidence:', formatContextSufficiencyMarkdown(sufficiency));
  }
  lines.push(
    '',
    'Then you MUST call the write_plan_artifact tool (NOT a chat message) with the complete plan markdown containing every required "## <section>" heading, grounded in what you read. If you are genuinely blocked on intent, call ask_clarifying_questions instead. Do not end your turn without calling one of these two tools.',
  );
  return lines.join('\n');
}

export async function buildPlanSeedMessage(
  root: string,
  prompt: string,
  context: ContextGraphResult,
  validationCommands: Array<{ command: string; args: string[]; reason: string }>,
  sufficiency: ContextSufficiencyReport,
  clarificationAnswers?: string,
): Promise<string> {
  const evidence = selectEvidenceFiles(context, prompt, MAX_EVIDENCE_FILES)
    .map((file) => {
      const body = file.content.length > MAX_EVIDENCE_CHARS ? `${file.content.slice(0, MAX_EVIDENCE_CHARS)}\n[TRUNCATED — read_file for the rest]` : file.content;
      return [`--- FILE ${file.path} (${file.summary}) ---`, body, file.truncated ? '[TRUNCATED]' : ''].filter(Boolean).join('\n');
    })
    .join('\n\n');

  const repositoryFiles = await listRepositoryFiles(root);
  const fileIndex = repositoryFiles.slice(0, MAX_INDEX_ENTRIES).join('\n');
  const validation = validationCommands.length
    ? validationCommands.map((command) => `- ${[command.command, ...command.args].join(' ')} (${command.reason})`).join('\n')
    : '- No validation command auto-detected. Recommend an appropriate check in the Validation Plan.';

  return [
    'Planning task:',
    prompt,
    '',
    clarificationAnswers ? ['The user already answered your clarifying questions — do NOT ask again:', clarificationAnswers, ''].join('\n') : '',
    'Context sufficiency gate (recall more evidence if this is not satisfied before finalizing):',
    formatContextSufficiencyMarkdown(sufficiency),
    '',
    'Definition of Done the executing agent will be held to (your plan must enable it):',
    formatWorkflowDodMarkdown(),
    '',
    'Validation commands detected in this repository:',
    validation,
    '',
    'Repository file index (read any of these with read_file; not the full tree if truncated):',
    fileIndex || '(empty)',
    '',
    'Initial evidence already gathered for you (read more precise ranges as needed):',
    evidence || '(none — start by exploring with list_files / search_text)',
  ]
    .filter(Boolean)
    .join('\n');
}

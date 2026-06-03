import type { ToolSpec } from '@/lib/agent/providers';
import type { ContextGraphResult } from './contextGraphEngine';
import { listRepositoryFiles } from './repoMap';
import { isReadOnlyTool } from './toolBudget';
import { CODE_MODE_TOOL_SPECS } from './toolExecutor';
import { selectEvidenceFiles } from './codeAgentLoop';
import { REQUIRED_PLAN_SECTIONS } from './planningEngine';
import {
  buildAmbiguityClarificationGate,
  buildWorkflowKernelPrompt,
  formatContextSufficiencyMarkdown,
  formatWorkflowDodMarkdown,
  type ContextSufficiencyReport,
  type PromptAmbiguityReport,
} from './workflowPolicy';
import { allocateContextBudget, formatEvidenceBody } from './contextWindowManager';

/** Terminal tools unique to Plan mode. They signal completion via CodeAgentContext fields. */
const PLAN_TERMINAL_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'ask_clarifying_questions',
    description:
      'Ask the user 1-3 LLM-authored, high-level multiple-choice questions only after repository exploration shows a genuinely user-owned product, architecture, data-model, migration, compatibility, or safety decision remains unresolved. Do not ask generic depth, verification, implementation-approach-label, or preference questions the agent can choose from repo conventions. Each question MUST include a short `rationale` and 2-4 labeled `options` ({label, description}). Calling this pauses the run for the user to answer; do not also call write_plan_artifact in the same turn.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              rationale: { type: 'string', description: 'Why this materially changes scope, design, or acceptance criteria.' },
              options: {
                type: 'array',
                description: 'At least 2 labeled choices the user can pick from.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
              allowMultiple: { type: 'boolean' },
            },
            required: ['question', 'rationale', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'write_plan_artifact',
    description:
      'Finalize the implementation plan after repository exploration. Provide human-reviewable plan markdown authored from the evidence you actually read. It MUST contain every required public section heading. Keep operational runbook details internal: do not include tool statuses, context-sufficiency diagnostics, diagnosis checks before editing, repair plans, implementation policy, final response format instructions, Definition of Done, or similar agent-only instructions. If no high-level user-owned decision remains, choose the best implementation path yourself from repository conventions. Set status="ready" only after you have autonomously recalled enough repository evidence; otherwise status="needs_review" only for an exact unreadable file, unsafe ambiguity, or exhausted bounded recall blocker. Stop after this call.',
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
    '1. Gather real evidence first with read_file (use startLine/endLine to read precise ranges), search_text, dependency_trace, repo_map, and git tools. Do not rely on filenames alone — read the code before asking the user anything.',
    '2. Resolve intent from the prompt plus evidence. Ask clarifying MCQs only when a high-level product, architecture, data-model, migration, compatibility, or safety decision remains genuinely user-owned and would materially change the plan.',
    '3. Skip clarifying questions for choices the agent can make optimally: patch depth, minimal-vs-coordinated implementation labels, whether to add obvious nearby tests, validation strictness, naming, formatting, and other repo-convention decisions.',
    '4. Use context-sufficiency diagnostics only as private recall guidance. If evidence is missing, keep exploring with repository tools — read files/imports/tests/configs/routes/call sites until the plan is grounded or a concrete unreadable/safety blocker remains.',
    '5. Author the public plan yourself, grounded in what you actually read and any user-confirmed answers: narrow the intent, protect scope with explicit non-goals, describe the chosen path, name the specific files with per-file changes and reasons, order small milestones, and list validation commands. Keep agent-only operational policy in your private reasoning, not in the plan markdown.',
    '6. Call either ask_clarifying_questions or write_plan_artifact exactly once. Then stop.',
    '',
    'The plan markdown MUST include these section headings verbatim:',
    ...REQUIRED_PLAN_SECTIONS.map((section) => `- ## ${section}`),
    '',
    'Hard rules:',
    '- Prefer the smallest coherent change; never invent services, dependencies, databases, queues, or broad rewrites without repository evidence.',
    '- Every major change must tie back to the user objective.',
    '- Be honest: if assumptions are wrong, a named file cannot be read, or a safety boundary blocks progress after bounded autonomous recall, set the plan status to needs_review with the exact blocker rather than guessing.',
    '- Clarifying questions must be generated from the evidence you read in this run. Never use canned questions such as "Which implementation approach should the plan use?", "How deep should I go?", or "How should we verify the change?"',
    '- Never include a plan section titled "Context Sufficiency Gate", "Context Sufficiency", "needs_recall", "Remaining blocker surfaces", "Status", "Candidate Approaches", "Approach 1", "Approach 2", "Diagnosis Checks Before Editing Code", "Repair Plan", "Repair Policy", "Implementation Policy for the Next Code Run", "Target Design Direction", "Definition of Done", "Final Response Format", or similar internal/runbook/choice-menu diagnostics. Do not tell the user one more evidence bundle is needed; recall the missing files yourself first.',
    '',
    // Motivation vs Logic: Plan mode emits two surfaces — the plan markdown (rich, sectioned) and
    // the chat summary (must be tight). Same prompt, two distinct outputs.
    'Communication style — the chat summary (NOT the plan markdown) must stay tight:',
    '- The `summary` field on write_plan_artifact is at most 2 short sentences (~200 chars). One paragraph, no markdown headings.',
    '- Never produce sectioned chat output like "Summary of intent and actions", "Evidence inspected", "DoD status vs checklist", "Next steps / Options for you". Keep chat summary concise and keep agent-only runbook content private.',
    '- Never offer the user a menu of options ("retry / repair / apply manually"). If a high-level human-owned decision is genuinely unresolved after codebase research, call ask_clarifying_questions; otherwise commit to a recommendation in the plan.',
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
    'Keep investigating with read_file / search_text / dependency_trace if you still need evidence — do not give up on finding context and do not summarize missing context as a plan section.',
  ];
  if (sufficiency.status === 'needs_recall' && (sufficiency.recommendedRecall.length || sufficiency.requiredEvidence.length)) {
    lines.push('', 'Private recall guidance; use it to read/search more repository evidence, but do NOT copy it into the plan markdown:', formatContextSufficiencyMarkdown(sufficiency));
  }
  lines.push(
    '',
    'Then you MUST either call ask_clarifying_questions with evidence-specific high-level MCQs if a user-owned decision remains, or call write_plan_artifact with complete human-reviewable plan markdown containing every required "## <section>" heading, grounded in what you read and without tool statuses, approach menus, or agent-only runbook sections. Do not end your turn without calling one of these two tools.',
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
  model = '',
  ambiguity?: PromptAmbiguityReport,
): Promise<string> {
  const budget = allocateContextBudget(model);
  const evidence = selectEvidenceFiles(context, prompt, budget.maxFiles)
    .map((file) => {
      const body = formatEvidenceBody(file.path, file.content, budget);
      return [`--- FILE ${file.path} (${file.summary}) ---`, body, file.truncated ? '[TRUNCATED]' : ''].filter(Boolean).join('\n');
    })
    .join('\n\n');

  const repositoryFiles = await listRepositoryFiles(root);
  const fileIndex = repositoryFiles.slice(0, budget.maxIndexEntries).join('\n');
  const validation = validationCommands.length
    ? validationCommands.map((command) => `- ${[command.command, ...command.args].join(' ')} (${command.reason})`).join('\n')
    : '- No validation command auto-detected. Recommend an appropriate check in the Validation Plan.';

  return [
    'Planning task:',
    prompt,
    '',
    ambiguity?.ambiguous ? [buildAmbiguityClarificationGate(ambiguity), ''].join('\n') : '',
    clarificationAnswers ? ['The user already answered your clarifying questions — do NOT ask again:', clarificationAnswers, ''].join('\n') : '',
    'Private context recall guidance (do not copy this into the plan markdown; recall more evidence if it is not satisfied before finalizing):',
    formatContextSufficiencyMarkdown(sufficiency),
    '',
    'Internal execution policy for the coding agent (do not copy this into the plan markdown):',
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

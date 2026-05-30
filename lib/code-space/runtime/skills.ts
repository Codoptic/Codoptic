/**
 * Adapted "Superpowers" agent skills.
 *
 * Motivation vs Logic: industry-standard agents (Claude/Cursor and the Superpowers skill set)
 * run a hard-gated workflow — brainstorm/clarify, write a plan, validate test-first, then
 * self-review the diff — instead of jumping straight to edits. We bundle that discipline as a
 * compact per-mode "skill kernel" injected into the workflow prompt so the behavior is consistent
 * across every project, regardless of whether the target repo ships its own instructions.
 *
 * Projects may additionally drop `.agent/skills/*.md` files in their repo; those are loaded by the
 * InstructionLoader and layered on top of these defaults.
 */
import type { WorkflowMode } from './workflowPolicy';

export interface AgentSkill {
  id: string;
  title: string;
  appliesTo: WorkflowMode[];
  lines: string[];
}

export const SUPERPOWERS_SKILLS: AgentSkill[] = [
  {
    id: 'brainstorming',
    title: 'Brainstorming & clarification',
    appliesTo: ['plan'],
    lines: [
      'When the request is ambiguous (vague goals, no concrete target, multiple plausible designs), STOP and ask 2-6 multiple-choice clarifying questions, each with a rationale and labeled options, before planning.',
      'Surface 2-3 candidate approaches with explicit pros/cons and a recommendation; never silently pick one.',
    ],
  },
  {
    id: 'writing-plans',
    title: 'Writing plans',
    appliesTo: ['plan'],
    lines: [
      'Ground every plan in evidence you actually read (cite files and line ranges). State intent, explicit non-goals, and assumptions.',
      'Prefer the smallest coherent change. Do not invent services, dependencies, or rewrites without repository evidence.',
    ],
  },
  {
    id: 'tdd-validation',
    title: 'Test-first validation',
    appliesTo: ['code'],
    lines: [
      'Read before you edit. Implement the smallest change that makes the failing behavior/tests pass.',
      'Run the project\'s real detected validation commands; never claim success with zero changed files or only skipped checks. Repair bounded failures within the smallest affected area.',
    ],
  },
  {
    id: 'diff-review',
    title: 'Self-review before validation',
    appliesTo: ['code'],
    lines: [
      'Before validation, review the full aggregated diff for unintended changes, leftover debug code, and scope creep.',
      'If the diff drifts beyond the task, narrow it before proceeding rather than rationalizing extra edits.',
    ],
  },
];

/**
 * Compact, per-mode skill guidance for the workflow kernel prompt. Returns an empty string when no
 * skills apply to the mode so the kernel stays lean.
 */
export function buildSkillsKernel(mode: WorkflowMode): string {
  const applicable = SUPERPOWERS_SKILLS.filter((skill) => skill.appliesTo.includes(mode));
  if (!applicable.length) return '';
  return [
    'Skills (hard-gated workflow disciplines):',
    ...applicable.flatMap((skill) => [`- ${skill.title}:`, ...skill.lines.map((line) => `  - ${line}`)]),
  ].join('\n');
}

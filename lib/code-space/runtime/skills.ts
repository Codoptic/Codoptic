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
  {
    // Motivation vs Logic: agents kept handing back multi-section technical reports ("Summary of
    // intent and actions" / "DoD status vs checklist" / "Options for you") instead of a single
    // decisive sentence. This skill is shared across all modes so the contract is uniform.
    id: 'concise-output',
    title: 'Concise final response',
    appliesTo: ['ask', 'plan', 'code'],
    lines: [
      'The user-visible reply (assistant text and any tool `summary` field) is at most 4 short sentences (~240 chars), one paragraph, no markdown section headings.',
      'Never produce sectioned reports ("Summary of intent and actions", "Evidence inspected", "DoD status vs checklist", "Validation plan", "Next steps / Options for you", "If you want me to proceed").',
      'Never offer the user a menu ("Option A: retry / Option B: repair / Option C: apply manually"). If a real human decision is needed in plan mode, call ask_clarifying_questions; otherwise commit and report.',
      'Do not narrate tool internals or pre-validation errors as the final answer — either retry the tool with a smaller, corrected input, or report the single exact unresolved blocker.',
    ],
  },
  {
    // Motivation vs Logic: a single literal substring search missed the intent of "comprehensive
    // grep". Pin a regex-first protocol so URL/identifier replacements are exhaustive but bounded,
    // and so 0-match outcomes are reported honestly without inventing adjacent normalization work.
    id: 'comprehensive-search',
    title: 'Comprehensive search-and-replace',
    appliesTo: ['ask', 'plan', 'code'],
    lines: [
      'For URLs, hostnames, env keys, identifiers, or deprecated symbols, drive search_text with a regex (it is case-insensitive). Do not rely on a single literal substring.',
      'Try at least three variants before declaring zero matches: the exact literal, a host/path-only fragment with `[-_]?` between word boundaries, and the most distinctive identifier substring.',
      'For URLs, anchor on the host and accept any scheme/path: `https?://[^/\\s"\\\'\\)]*<host-fragment>`. Also search the replacement string to detect partially-completed migrations.',
      'If every variant returns zero matches, briefly report "no occurrences of <pattern> found" and stop. Do NOT invent unrelated normalization, casing fixes, or refactors the user did not ask for.',
      'When matches exist, replace every occurrence in a single edit_file batch, then re-run the same regex to confirm the remaining count is zero.',
    ],
  },
];

/**
 * Compact, per-mode skill guidance for the workflow kernel prompt. Returns an empty string when no
 * skills apply to the mode so the kernel stays lean.
 */
export interface SkillCatalogEntry {
  id: string;
  title: string;
  description: string;
}

export function listSkillCatalog(mode: WorkflowMode): SkillCatalogEntry[] {
  return SUPERPOWERS_SKILLS.filter((skill) => skill.appliesTo.includes(mode)).map((skill) => ({
    id: skill.id,
    title: skill.title,
    description: skill.lines[0] ?? skill.title,
  }));
}

export function readSkillBody(id: string): string | null {
  const skill = SUPERPOWERS_SKILLS.find((item) => item.id === id);
  if (!skill) return null;
  return [`# ${skill.title}`, ...skill.lines.map((line) => `- ${line}`)].join('\n');
}

export function buildSkillsKernel(mode: WorkflowMode): string {
  const catalog = listSkillCatalog(mode);
  if (!catalog.length) return '';
  return [
    'Skills catalog (call read_skill before applying a body):',
    ...catalog.map((skill) => `- ${skill.id}: ${skill.description}`),
  ].join('\n');
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';
import {
  formatPlanArtifactSectionHeading,
  PLAN_ARTIFACT_SECTION_TITLES,
} from '@/lib/code-space/agent/planTemplate';
import type { ContextGraphFile, ContextGraphResult } from './contextGraphEngine';
import type { TerminalCommand } from './terminalPolicy';
import {
  assessContextSufficiency,
  formatContextSufficiencyMarkdown,
  formatWorkflowDodMarkdown,
} from './workflowPolicy';

export interface WorkflowOutline {
  intentSummary: string;
  planItems: string[];
  clarifyingQuestions: CodeSpaceClarifyingQuestion[];
}

const REQUIRED_PLAN_SECTIONS = [
  'Summary',
  'Intent, Scope, and Non-Goals',
  'Context Sufficiency Gate',
  'Repository Evidence Reviewed',
  'Current-State Diagnosis to Verify',
  'Candidate Approaches and Recommendation',
  'Target Design Direction',
  'Implementation Milestones',
  'File-Level Change Plan',
  'Validation Plan',
  'Safety and Change Control',
  'Repair Policy',
  'Definition of Done',
  'Final Response Format',
];
const MAX_PLAN_FILES = 14;

function formatList(items: string[]): string {
  if (!items.length) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function normalizePrompt(prompt: string, limit = 360): string {
  return prompt.trim().replace(/\s+/g, ' ').slice(0, limit) || '(not provided)';
}

function planCandidateFiles(context: ContextGraphResult): ContextGraphFile[] {
  return context.files
    .filter((file) => !file.path.startsWith('.agent/plans/'))
    .sort((a, b) => {
      const explicitDelta = Number(b.reasons.includes('explicit_file')) - Number(a.reasons.includes('explicit_file'));
      return explicitDelta || b.score - a.score || a.path.localeCompare(b.path);
    })
    .slice(0, MAX_PLAN_FILES);
}

function filesByGroup(files: ContextGraphFile[]): Record<string, ContextGraphFile[]> {
  const groups: Record<string, ContextGraphFile[]> = {
    'Primary target files': [],
    'Call sites and runtime entrypoints': [],
    'Configuration and startup': [],
    'Tests and validation': [],
    'Supporting files': [],
  };

  for (const file of files) {
    if (file.reasons.includes('explicit_file') || file.reasons.includes('explicit_folder')) groups['Primary target files']?.push(file);
    else if (/route|controller|handler|main|app\.|server|runtime|chatbot|retrieval|database|workspace|panel|agent|planner|tool|context/i.test(file.path)) groups['Call sites and runtime entrypoints']?.push(file);
    else if (/config|settings|env|package\.json|pyproject|requirements|docker|compose|tsconfig|vitest|playwright/i.test(file.path)) groups['Configuration and startup']?.push(file);
    else if (/test|spec|pytest|vitest|playwright|__tests__/i.test(file.path)) groups['Tests and validation']?.push(file);
    else groups['Supporting files']?.push(file);
  }

  return groups;
}

function summarizeAction(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (/workflow|planning|agentic|agent|code\s*space|cursor|codex|claude\s*code/.test(lower)) return 'Upgrade the Code Space agent workflow so planning, context recall, execution, validation, repair, and verdicts are evidence-first and auditable.';
  if (/disable|turn off|remove|bypass/.test(lower)) return 'Disable or bypass only the requested functionality while keeping the rest of the application path intact.';
  if (/fix|bug|error|traceback|exception|fail/.test(lower)) return 'Fix the reported failure at the smallest responsible implementation surface.';
  if (/refactor|cleanup|simplify/.test(lower)) return 'Refactor the relevant implementation path without changing unrelated behavior.';
  if (/add|implement|support|enable/.test(lower)) return 'Implement the requested behavior in the smallest coherent set of files.';
  return 'Apply the requested change using the selected repository evidence and avoid unrelated architecture work.';
}

function buildFilePlan(file: ContextGraphFile, prompt: string): string {
  const lowerPath = file.path.toLowerCase();
  const lowerPrompt = prompt.toLowerCase();
  if (/workflowpolicy|planningengine|agentruntime|codeagentloop|contextgraphengine|validationrunner|repairloop|tool/.test(lowerPath) && /workflow|agent|plan|code\s*space|validation|repair|context/.test(lowerPrompt)) {
    return 'align this agent workflow surface with the shared v3.2 policy and keep state/validation boundaries typed.';
  }
  if (/database|mongo|mongodb/.test(lowerPath) && /disable|mongo|mongodb|database/.test(lowerPrompt)) {
    return 'inspect startup/initialization paths and remove, bypass, or guard the database connection without breaking imports.';
  }
  if (/retrieval|rag|rerank|vector|faiss|search/.test(lowerPath) && /rag|retriev|clinical|passage|vector|faiss/.test(lowerPrompt)) {
    return 'disable clinical passage retrieval/RAG calls and preserve a direct non-RAG response path.';
  }
  if (/chatbot|route|app|main|runtime|workspace|panel/.test(lowerPath)) {
    return 'update the runtime or UI call path so the requested behavior is actually used by users.';
  }
  if (/config|settings|env/.test(lowerPath)) {
    return 'check whether a flag or setting is the safest way to control the feature.';
  }
  if (/test|spec/.test(lowerPath)) {
    return 'add or update focused coverage for the changed workflow behavior.';
  }
  return 'review only if it is required by imports, call sites, or validation failures.';
}

function validationLines(validationCommands: TerminalCommand[]): string[] {
  if (!validationCommands.length) return ['- Manual review — no project-specific validation command was detected; do not claim verification until a compile/test command is run or the exact blocker is reported.'];
  return validationCommands.map((command) => `- ${[command.command, ...command.args].join(' ')} — ${command.reason}`);
}

function evidenceLines(files: ContextGraphFile[]): string[] {
  if (!files.length) return ['- No target files were selected. Re-run context discovery before implementing.'];
  const groups = filesByGroup(files);
  return Object.entries(groups).flatMap(([group, groupFiles]) => {
    if (!groupFiles.length) return [];
    return [
      `- ${group}:`,
      ...groupFiles.map((file) => `  - ${file.path}: ${file.summary}`),
    ];
  });
}

function diagnosisLines(context: ContextGraphResult, prompt: string): string[] {
  const selected = planCandidateFiles(context).slice(0, 6).map((file) => file.path);
  const lowerPrompt = prompt.toLowerCase();
  const workflowTask = /workflow|planning|agent|code\s*space|validation|repair|context|patch/.test(lowerPrompt);
  return [
    '- Verify the current flow from user prompt → mode selection → context graph → plan artifact/code loop → validation → final verdict.',
    '- Confirm whether any existing implementation already owns the requested responsibility before adding new abstractions.',
    workflowTask
      ? '- Verify that context insufficiency, no-op patch outcomes, validation failures, and review/autonomy states terminate with explicit needs_review/verified verdicts.'
      : '- Verify that the suspected runtime failure exists in the selected files before editing.',
    selected.length ? `- Evidence to inspect first: ${formatList(selected.map((file) => `\`${file}\``))}.` : '- Evidence to inspect first: rerun repository context collection because no primary files were selected.',
  ];
}

function milestoneLines(files: ContextGraphFile[], validationCommands: TerminalCommand[]): string[] {
  const primary = files.slice(0, 5).map((file) => `\`${file.path}\``);
  const validation = validationCommands[0] ? [validationCommands[0].command, ...validationCommands[0].args].join(' ') : 'focused inspection or nearest available validation command';
  return [
    '### Milestone 1 — Verify and map current behaviour',
    primary.length ? `Files to inspect: ${formatList(primary)}.` : 'Files to inspect: rerun context recall to select primary files.',
    'Tasks: trace the current data/control flow, identify duplicate or competing paths, and confirm the smallest owner module.',
    'Acceptance: current behaviour is understood before implementation and no speculative path is created.',
    '',
    '### Milestone 2 — Implement the smallest coherent change',
    'Tasks: edit only the owner module(s), reuse existing abstractions, preserve public APIs, and keep the patch reviewable.',
    'Acceptance: requested behaviour is implemented in real code, not as documentation or a parallel unused path.',
    '',
    '### Milestone 3 — Consolidate, test, and remove drift',
    'Tasks: update usages/imports, add or update focused tests, remove duplicate logic only when safe, and validate.',
    `Validation: ${validation}.`,
  ];
}

/**
 * Evidence-grounded candidate approaches for the deterministic fallback plan. Real plans authored by
 * the model will be richer; this guarantees the required section exists with at least two distinct,
 * scope-aware options and an explicit recommendation even when the model fails to finalize.
 */
function candidateApproachLines(files: ContextGraphFile[], action: string): string[] {
  const owner = files[0]?.path ?? 'the smallest owner module identified during recall';
  const secondary = files[1]?.path;
  return [
    `- **Approach A — Minimal in-place change (recommended).** Implement "${action}" directly in \`${owner}\`, reusing existing abstractions and preserving public APIs. Pros: smallest, most reviewable diff; lowest regression risk. Cons: limited if the responsibility is actually shared.`,
    secondary
      ? `- **Approach B — Coordinated change across owners.** Extend \`${owner}\` and \`${secondary}\` together when the behaviour spans both. Pros: keeps related call sites coherent. Cons: larger surface, more validation.`
      : '- **Approach B — Extract a small shared helper.** Introduce one focused, well-named helper if the logic would otherwise be duplicated. Pros: single source of truth. Cons: adds an abstraction; only worth it with real duplication evidence.',
    '- **Approach C — Defer/escalate.** If recall shows the request is ambiguous or unsafe, stop and report `needs_review` with the exact blocker instead of guessing.',
    '- **Recommendation:** Approach A unless repository evidence proves the responsibility is shared, in which case prefer Approach B. Avoid Approach C only when intent and evidence are clear.',
  ];
}

export class PlanningEngine {
  buildTodos(mode: 'ask' | 'plan' | 'code', context: ContextGraphResult): string[] {
    if (mode === 'ask') return ['Gather repository evidence for the question', 'Trace relevant references and tests', 'Answer directly from evidence'];
    const surfaces = planCandidateFiles(context).slice(0, 4).map((file) => file.path);
    if (mode === 'plan') {
      return [
        'Resolve intent, scope, non-goals, assumptions, and risk',
        surfaces.length ? `Ground the plan in ${formatList(surfaces.map((file) => `\`${file}\``))}` : 'Ground the plan in selected repository evidence',
        'Score context sufficiency and list recall targets',
        'Write an implementation-grade plan artifact',
        'Define validation, repair, rollback, and verdict gates',
      ];
    }
    return [
      'Load the approved plan and target files',
      surfaces.length ? `Prepare the patch across ${formatList(surfaces.map((file) => `\`${file}\``))}` : 'Recall enough context, then prepare the smallest coherent patch',
      'Run validation and inspect failures',
      'Repair bounded failures or mark exact needs_review blockers',
    ];
  }

  buildOutline(mode: 'ask' | 'plan' | 'code', prompt: string, context: ContextGraphResult): WorkflowOutline {
    return {
      intentSummary: normalizePrompt(prompt, 320),
      planItems: this.buildTodos(mode, context).slice(0, 6),
      clarifyingQuestions: [],
    };
  }

  buildPlanArtifact({
    projectName,
    prompt,
    context,
    validationCommands,
  }: {
    projectName: string;
    prompt: string;
    context: ContextGraphResult;
    validationCommands: TerminalCommand[];
  }): string {
    const selectedFiles = planCandidateFiles(context);
    const topFiles = selectedFiles.slice(0, 6).map((file) => `\`${file.path}\``);
    const action = summarizeAction(prompt);
    const filePlans = selectedFiles.map((file) => `- ${file.path}: ${buildFilePlan(file, prompt)}`);
    const sufficiency = assessContextSufficiency({ mode: 'plan', prompt, context, validationCommands });

    return [
      `# Plan: ${projectName} Code Space Task`,
      '',
      `Your task is to ${action.charAt(0).toLowerCase()}${action.slice(1)}`,
      'Do not start by coding. First inspect the repository, verify the current implementation, identify the smallest safe change, then implement only what is required.',
      '',
      '## Summary',
      `- Request: ${normalizePrompt(prompt)}`,
      `- Implementation goal: ${action}`,
      topFiles.length ? `- Primary files to inspect/change: ${formatList(topFiles)}.` : '- Primary files to inspect/change: none selected yet; rerun context discovery before editing.',
      `- Context gate: ${sufficiency.status} (${sufficiency.score}/100, ${sufficiency.confidence} confidence).`,
      '',
      '## Intent, Scope, and Non-Goals',
      '### In scope',
      '- Repository investigation and evidence-backed implementation planning.',
      '- The smallest coherent code, test, and validation changes required by the user request.',
      '- Honest final verdicts with exact blockers when validation or context is insufficient.',
      '',
      '### Out of scope',
      '- Broad rewrites, new services, new dependencies, new databases, background jobs, or unrelated UI flows unless repository evidence proves they are required.',
      '- Changing secrets, credentials, production data, deployment settings, or remote branches without explicit approval.',
      '- Implementing non-goals hidden inside exploratory findings.',
      '',
      '### Assumptions',
      '- Existing project conventions should be reused before adding new abstractions.',
      '- Public APIs and user-visible flows should remain stable unless the request explicitly changes them.',
      '- If these assumptions are wrong, stop and report `needs_review`.',
      '',
      '## Context Sufficiency Gate',
      ...formatContextSufficiencyMarkdown(sufficiency).split('\n'),
      '- If this gate is not ready, recall the listed files/surfaces before editing or finalising.',
      '',
      '## Repository Evidence Reviewed',
      ...evidenceLines(selectedFiles),
      '',
      '## Current-State Diagnosis to Verify',
      ...diagnosisLines(context, prompt),
      'This matters because an ungrounded plan can create duplicate architecture, modify the wrong owner module, or claim validation without touching the real runtime path.',
      '',
      '## Candidate Approaches and Recommendation',
      ...candidateApproachLines(selectedFiles, action),
      '',
      '## Target Design Direction',
      '- Prefer existing project conventions and typed boundaries.',
      '- Refactor toward one source of truth per responsibility.',
      '- Keep UI, transport, runtime orchestration, validation, persistence, and business logic clearly separated.',
      '- Do not add dependencies unless there is no reasonable existing alternative.',
      '',
      'Expected ownership:',
      ...filePlans,
      '',
      '## Implementation Milestones',
      ...milestoneLines(selectedFiles, validationCommands),
      '',
      '## File-Level Change Plan',
      ...filePlans,
      selectedFiles.length ? '- Add or update focused tests at the closest existing test surface.' : '- No file-level change plan is valid until context recall selects target files.',
      '',
      '## Validation Plan',
      ...validationLines(validationCommands),
      '- Prefer targeted validation first, then broader typecheck/lint/test/build gates where available.',
      '- If a command is unavailable, broken, or unsafe, report the exact reason and run the closest safe fallback.',
      '- Do not mark the task complete if validation fails, is skipped, or cannot be run without explaining why.',
      '',
      '## Safety and Change Control',
      '- Read target files from disk before editing.',
      '- Check existing abstractions first and preserve public APIs unless migration is explicit.',
      '- Avoid destructive changes and unrelated formatting churn.',
      '- Require explicit approval before installing dependencies, changing schemas, deleting files, moving large folders, touching credentials/secrets, deploying, or pushing remote branches.',
      '- Stop and report `needs_review` if repository state contradicts this plan, risky unapproved changes are required, validation repeatedly fails, or the fix expands beyond scope.',
      '',
      '## Repair Policy',
      '1. Read the validation failure carefully.',
      '2. Identify the smallest affected area.',
      '3. Make the smallest safe repair.',
      '4. Re-run the relevant validation.',
      '5. Stop as `needs_review` if the same failure repeats or the repair becomes risky.',
      'Do not make unrelated changes during repair.',
      '',
      '## Definition of Done',
      ...formatWorkflowDodMarkdown().split('\n'),
      '',
      '## Final Response Format',
      'When finished, respond with:',
      '- what changed',
      '- key files changed',
      '- validation run and results',
      '- unresolved issues, if any',
      '- commit hash, if a commit was made',
      '',
    ].join('\n');
  }

  async writePlanArtifact(root: string, sessionId: string, projectName: string, prompt: string, context: ContextGraphResult, validationCommands: TerminalCommand[]): Promise<{ filePath: string; content: string }> {
    const content = this.buildPlanArtifact({ projectName, prompt, context, validationCommands });
    return this.writePlanContent(root, sessionId, content);
  }

  /** Persist plan markdown to the canonical .agent/plans/<sessionId>.md path. */
  async writePlanContent(root: string, sessionId: string, content: string): Promise<{ filePath: string; content: string }> {
    const filePath = `.agent/plans/${sessionId.replace(/[^a-zA-Z0-9_.-]+/g, '-')}.md`;
    await fs.mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await fs.writeFile(path.join(root, filePath), content, 'utf8');
    return { filePath, content };
  }
}

export function planContainsRequiredSections(content: string): boolean {
  return REQUIRED_PLAN_SECTIONS.every((section) => content.includes(formatPlanArtifactSectionHeading(section)) || content.includes(`## ${section}`));
}

export { REQUIRED_PLAN_SECTIONS, PLAN_ARTIFACT_SECTION_TITLES };

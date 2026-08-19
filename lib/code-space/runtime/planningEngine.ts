import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';
import {
  formatPlanArtifactSectionHeading,
  PLAN_ARTIFACT_SECTION_TITLES,
} from '@/lib/code-space/agent/planTemplate';
import type { ContextGraphFile, ContextGraphResult } from './contextGraphEngine';
import type { TerminalCommand } from './terminalPolicy';

export interface WorkflowOutline {
  intentSummary: string;
  planItems: string[];
  clarifyingQuestions: CodeSpaceClarifyingQuestion[];
}

const REQUIRED_PLAN_SECTIONS = [
  'Summary',
  'Intent, Scope, and Non-Goals',
  'Repository Evidence Reviewed',
  'Implementation Milestones',
  'New Implementations',
  'File-Level Change Plan',
  'Validation Plan',
];
const MAX_PLAN_FILES = 14;
const HIDDEN_PLAN_SECTION_HEADINGS = [
  'Context Sufficiency Gate',
  'Context Sufficiency',
  'Status',
  'Candidate Approaches',
  'Candidate Approaches and Recommendation',
  'Approach 1',
  'Approach 2',
  'Approach 3',
  'Current-State Diagnosis to Verify',
  'Diagnosis Checks Before Editing Code',
  'Target Design Direction',
  'Safety and Change Control',
  'Repair Policy',
  'Repair Plan',
  'Implementation Policy for the Next Code Run',
  'Definition of Done',
  'Final Response Format',
  'Final Response Format for the Implementation Run',
] as const;

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
  if (!validationCommands.length) return ['- Manual review plus the nearest project-specific compile, test, or build check the implementer can identify.'];
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

function milestoneLines(files: ContextGraphFile[], validationCommands: TerminalCommand[]): string[] {
  const primary = files.slice(0, 5).map((file) => `\`${file.path}\``);
  const validation = validationCommands[0] ? [validationCommands[0].command, ...validationCommands[0].args].join(' ') : 'focused inspection or nearest available validation command';
  return [
    '### Milestone 1 — Confirm ownership',
    primary.length ? `Review ${formatList(primary)} and confirm where the requested behavior belongs.` : 'Identify the primary owner file before changing behavior.',
    '',
    '### Milestone 2 — Implement the smallest coherent change',
    'Make the requested behavior change in the owner module(s), reusing existing project conventions.',
    '',
    '### Milestone 3 — Validate the result',
    `Run ${validation} and update nearby tests when the changed behavior needs coverage.`,
  ];
}

function newFileDirectoryLines(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  if (/\b(new file|new files|create file|create files|folder|directory|scratch|from scratch|scaffold|build (an?|the)? ?(app|project|site|tool)|generate (an?|the)? ?(app|project|site|tool))\b/.test(lower)) {
    return [
      '- Code mode must create a concrete manifest before editing: list every new file/directory, its purpose, and whether it uses `create_files` or `create_directory`.',
      '- Use `create_files` for source/config/test/doc scaffold files and `create_directory` only for intentionally empty directories.',
    ];
  }
  return ['- No new files/directories planned unless implementation-time evidence proves one is required.'];
}

export class PlanningEngine {
  buildTodos(_mode: 'ask' | 'plan' | 'code', _context: ContextGraphResult): string[] {
    return [];
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

    return [
      `# Plan: ${projectName} Code Space Task`,
      '',
      '## Summary',
      `- Request: ${normalizePrompt(prompt)}`,
      `- Implementation goal: ${action}`,
      topFiles.length ? `- Primary files: ${formatList(topFiles)}.` : '- Primary files: to be confirmed by implementation-time repository inspection.',
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
      '',
      '## Repository Evidence Reviewed',
      ...evidenceLines(selectedFiles),
      '',
      '## Implementation Milestones',
      ...milestoneLines(selectedFiles, validationCommands),
      '',
      '## New Implementations',
      ...newFileDirectoryLines(prompt),
      '',
      '## File-Level Change Plan',
      ...filePlans,
      selectedFiles.length ? '- Add or update focused tests at the closest existing test surface.' : '- No file-level change plan is valid until context recall selects target files.',
      '',
      '## Validation Plan',
      ...validationLines(validationCommands),
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
    const sanitizedContent = sanitizePlanMarkdown(content);
    await fs.mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await fs.writeFile(path.join(root, filePath), sanitizedContent, 'utf8');
    return { filePath, content: sanitizedContent };
  }
}

export function planContainsRequiredSections(content: string): boolean {
  return REQUIRED_PLAN_SECTIONS.every((section) => content.includes(formatPlanArtifactSectionHeading(section)) || content.includes(`## ${section}`));
}

export function sanitizePlanMarkdown(content: string): string {
  const hiddenHeadingPattern = new RegExp(
    `^#{1,6}\\s+(?:${HIDDEN_PLAN_SECTION_HEADINGS.map((heading) => escapeRegExp(heading)).join('|')})\\b`,
    'i',
  );
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let skippingHiddenSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed)) {
      skippingHiddenSection = hiddenHeadingPattern.test(trimmed);
      if (skippingHiddenSection) continue;
    }
    if (skippingHiddenSection) continue;
    if (/^[-*]?\s*Status\s*:\s*(ready|needs_recall|needs_review|verified|failed|cancelled)\b/i.test(trimmed)) continue;
    if (/^[-*]?\s*(Approach\s+\d+|Approach\s+[A-Z])\b/i.test(trimmed)) continue;
    kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { REQUIRED_PLAN_SECTIONS, PLAN_ARTIFACT_SECTION_TITLES };

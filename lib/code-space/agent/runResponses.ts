import { PLAN_ARTIFACT_SECTION_TITLES } from './planTemplate';

export interface RunValidationCommand {
  command: string;
  reason: string;
}

export interface RunValidationResult {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  output: string;
}

export interface PlanResponseInput {
  planPath: string;
  projectName: string;
  planContent?: string;
  inspectedFiles: Array<{ path: string; summary?: string }>;
  validationCommands: RunValidationCommand[];
}

export interface CodeResponseInput {
  projectName: string;
  files: Array<{ path: string; explanation: string }>;
  validationRuns: RunValidationResult[];
  summary?: string;
  checkpointRef?: string;
}

export function buildPlanCompletionResponse(input: PlanResponseInput): string {
  const summaryHighlight = extractSectionLead(input.planContent ?? '', 'Summary');
  const planHighlights = [
    summaryHighlight,
    ...PLAN_ARTIFACT_SECTION_TITLES.slice(1).flatMap((title) => extractSectionBullets(input.planContent ?? '', title)),
  ]
    .filter((item): item is string => Boolean(item))
    .slice(0, 2);
  const fileHighlights = input.inspectedFiles.slice(0, 3).map((file) => `\`${file.path}\``);
  const validationHighlights = summarizeValidationCommands(input.validationCommands, 2);

  const lines: string[] = [`Saved ${input.planPath} for ${input.projectName}.`];
  if (planHighlights.length) {
    lines.push(`Plan focus: ${planHighlights.join('; ')}.`);
  } else if (fileHighlights.length) {
    lines.push(`Scoped the plan around ${formatList(fileHighlights)}.`);
  }
  if (validationHighlights.length) {
    lines.push(`Validation: ${validationHighlights.join('; ')}.`);
  }
  return lines.join(' ');
}

export function buildCodeCompletionResponse(input: CodeResponseInput): string {
  const lines: string[] = [];
  const cleanSummary = input.files.length ? normalizeSummary(input.summary, true) : normalizeSummary(input.summary, false);
  if (cleanSummary) lines.push(cleanSummary);

  if (input.files.length) {
    const fileList = input.files.slice(0, 3).map((file) => `\`${file.path}\``);
    const suffix = input.files.length > fileList.length ? `, and ${input.files.length - fileList.length} more` : '';
    lines.push(
      `Updated ${input.files.length} file${input.files.length === 1 ? '' : 's'} in ${input.projectName}: ${formatList(fileList)}${suffix}. Code changes are written through the checkpointed patch pipeline when accepted or auto-apply succeeds.`,
    );
  } else {
    lines.push(
      `No code changes were applied in ${input.projectName}. The agent could not complete the task autonomously — see the summary above for what it found and why it stopped.`,
    );
  }

  const failed = input.validationRuns.filter((run) => run.status === 'failed');
  const passed = input.validationRuns.filter((run) => run.status === 'passed');
  const skipped = input.validationRuns.filter((run) => run.status === 'skipped');
  if (failed.length) {
    lines.push(`Validation still needs attention: ${failed.map((run) => `\`${run.command}\``).join(', ')}.`);
  } else if (passed.length || skipped.length) {
    const validationBits = [
      passed.length ? `${passed.length} passed` : null,
      skipped.length ? `${skipped.length} skipped` : null,
    ].filter(Boolean);
    lines.push(`Validation: ${validationBits.join(', ')}.`);
  }

  if (input.checkpointRef) {
    lines.push('Checkpoint created before the edit.');
  }

  return lines.join(' ');
}

/**
 * Aggressively trim a model-authored summary down to a single short paragraph for the user-facing
 * chat reply. Strips multi-section markdown reports ("## Summary of intent and actions",
 * "## DoD status vs checklist", etc.), "Options for you" menus, and any narration after the first
 * paragraph.
 *
 * Motivation vs Logic: blocked agents tend to dump long sectioned reports with DoD checklists and
 * option menus into the chat. The skills/system-prompt tell them not to, but we also normalize
 * here so a non-compliant model cannot leak that text to the user. Cap is ~280 chars so the
 * concise-output skill's "≤ 4 short sentences" contract holds end-to-end.
 */
export function tightenAgentSummary(summary: string | undefined | null): string {
  if (!summary) return '';
  const lines = summary.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^\s*#{1,6}\s+\S/.test(line));
  const truncated = headingIndex >= 0 ? lines.slice(0, headingIndex) : lines;

  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of truncated) {
    if (line.trim() === '') {
      if (current.length) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      continue;
    }
    current.push(line.trim());
  }
  if (current.length) paragraphs.push(current.join(' '));
  const firstPara = paragraphs.find((value) => value.trim()) ?? '';

  let trimmed = firstPara.replace(/\s+/g, ' ').trim();
  if (trimmed.length > 280) {
    const cut = trimmed.slice(0, 280);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    trimmed = sentenceEnd > 120 ? cut.slice(0, sentenceEnd + 1).trim() : `${cut.trim()}…`;
  }
  return trimmed;
}

function normalizeSummary(summary?: string, proposedOnly = false): string | null {
  const tightened = tightenAgentSummary(summary);
  if (!tightened) return null;
  if (/^done\b/i.test(tightened)) return null;
  if (/^plan ready\b/i.test(tightened)) return null;
  if (/\b(unable to produce|cannot produce|could not produce|insufficient evidence|not enough evidence|no reviewable code patch was produced)\b/i.test(tightened)) return null;
  let normalized = tightened.slice(0, 240);
  if (proposedOnly) {
    normalized = normalized
      .replace(/^fixed\b/i, 'Proposed a fix for')
      .replace(/^updated\b/i, 'Proposed an update to')
      .replace(/^changed\b/i, 'Proposed changes to')
      .replace(/^implemented\b/i, 'Proposed an implementation for');
  }
  return normalized;
}

function summarizeValidationCommands(commands: RunValidationCommand[], limit: number): string[] {
  return commands.slice(0, limit).map((command) => `\`${command.command}\``);
}

function extractSectionBullets(content: string, heading: string): string[] {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(heading)}\\b`, 'i').test(line.trim()));
  if (startIndex < 0) return [];

  const bullets: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (/^##\s+/.test(line)) break;
    const bullet = line.match(/^[-*]\s+(.*)$/)?.[1] ?? line.match(/^\d+\.\s+(.*)$/)?.[1];
    if (!bullet) continue;
    const normalized = bullet.replace(/\s+/g, ' ').trim();
    if (normalized && !bullets.includes(normalized)) bullets.push(normalized);
    if (bullets.length >= 2) break;
  }
  return bullets;
}

function extractSectionLead(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(heading)}\\b`, 'i').test(line.trim()));
  if (startIndex < 0) return null;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line) continue;
    if (/^##\s+/.test(line)) break;
    return line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').replace(/\s+/g, ' ').trim() || null;
  }

  return null;
}

function formatList(items: string[]): string {
  if (!items.length) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

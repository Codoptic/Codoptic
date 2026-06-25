const MAX_DISPLAY_CHARS = 260;

export function sanitizeAgentDisplayText(text: string | undefined | null): string {
  if (!text) return '';
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const subagent = normalizeSubagentFailure(normalized);
  if (subagent) return subagent;

  const completionSummary = extractAttemptCompletionSummary(normalized);
  if (completionSummary) return sanitizeAgentDisplayText(completionSummary);

  if (/\bspawn\b[\s\S]*\benoent\b/i.test(normalized) || /\bcommands?\b[\s\S]*\b(spawn|execute|start)[\s\S]*\benoent\b/i.test(normalized)) {
    return appendNoFilesChanged('The run is blocked because commands cannot start in this workspace.', normalized);
  }

  if (
    /\b(workspace|environment|command runner|execution layer)\b[\s\S]*\b(unable|cannot|can't|nonfunctional|broken|blocked)\b[\s\S]*\b(spawn|execute|run commands?)\b/i.test(normalized) ||
    /\bunable to spawn any command\b/i.test(normalized)
  ) {
    return appendNoFilesChanged('The run is blocked because commands cannot start in this workspace.', normalized);
  }

  if (/\badvisory-only\b|\bsuggest-only\b|\bsource edits are blocked\b|\bprohibited from editing files\b|\bno edit pipeline was available\b/i.test(normalized)) {
    return appendNoFilesChanged('The helper could only inspect the repo; it could not make changes in this run.', normalized);
  }

  let cleaned = normalized
    .replace(/\battempt_completion\s*\(([^)]*)\)/gi, (_match, args: string) => extractSummaryFromArgs(args) || 'Completion recorded.')
    .replace(/\bsuccess\s*=\s*(?:true|false)\b/gi, '')
    .replace(/\bcompletedOriginalRequest\s*=\s*(?:true|false)\b/gi, '')
    .replace(/\bsummary\s*=\s*("[^"]*"|'[^']*'|[^,\n)]+)/gi, (_match, value: string) => stripQuotes(value))
    .replace(/\bSubagent failed:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  cleaned = stripVerboseSections(cleaned);
  return capSentence(cleaned);
}

export function sanitizeAgentDetailText(text: string | undefined | null): string | undefined {
  const cleaned = sanitizeAgentDisplayText(text);
  return cleaned || undefined;
}

export function agentDisplayDedupeKey(text: string): string {
  const cleaned = sanitizeAgentDisplayText(text).toLowerCase();
  if (!cleaned) return '';
  if (/commands cannot start in this workspace/.test(cleaned)) return 'blocked:command-spawn';
  if (/could only inspect the repo/.test(cleaned)) return 'blocked:advisory-only';
  if (/no files were changed/.test(cleaned)) return 'blocked:no-files-changed';
  return cleaned.replace(/`[^`]+`/g, '`path`').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

export function conciseValidationOutput(output: string | undefined | null): string | undefined {
  if (!output?.trim()) return undefined;
  const sanitized = sanitizeAgentDisplayText(output);
  if (sanitized && sanitized !== output.trim()) return sanitized;
  const firstUsefulLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^>?\s*(npm|yarn|pnpm|node)\b/i.test(line));
  return capSentence(firstUsefulLine || output.trim(), 220);
}

function extractAttemptCompletionSummary(text: string): string | null {
  const match = text.match(/attempt_completion\s*\(([\s\S]*?)\)/i);
  if (!match) return null;
  return extractSummaryFromArgs(match[1] ?? '');
}

function extractSummaryFromArgs(args: string): string | null {
  const summaryMatch = args.match(/\bsummary\s*=\s*("([^"]*)"|'([^']*)'|([^,\n)]+))/i);
  return stripQuotes(summaryMatch?.[1] ?? '').trim() || null;
}

function normalizeSubagentFailure(text: string): string | null {
  const match = text.match(/Subagent failed:\s*([^:]+):\s*([\s\S]*)/i);
  if (!match) return null;
  const role = humanizeRole(match[1] ?? 'helper');
  const detail = match[2] ?? '';
  const unwrappedDetail = extractAttemptCompletionSummary(detail) || detail;
  if (/\badvisory-only\b|\bsuggest-only\b|\bsource edits are blocked\b|\bprohibited from editing files\b|\bno edit pipeline was available\b/i.test(unwrappedDetail)) {
    return appendNoFilesChanged(`${role} could only inspect the repo; it could not make changes in this run.`, unwrappedDetail);
  }
  if (/\bspawn\b[\s\S]*\benoent\b/i.test(unwrappedDetail)) {
    return appendNoFilesChanged(`${role} was blocked because commands cannot start in this workspace.`, unwrappedDetail);
  }
  const cleanDetail = sanitizeAgentDisplayText(unwrappedDetail);
  return cleanDetail ? `${role} reported: ${cleanDetail}` : `${role} could not complete its helper task.`;
}

function appendNoFilesChanged(lead: string, source: string): string {
  return /\bno (?:source )?files? (?:were )?(?:modified|changed)\b/i.test(source) ? `${lead} No files were changed.` : lead;
}

function stripVerboseSections(text: string): string {
  const sectionIndex = text.search(/\b(Summary of intent and actions|Evidence inspected|DoD status|Validation plan|Next steps|Options for you)\b/i);
  return sectionIndex > 0 ? text.slice(0, sectionIndex).trim() : text;
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

function humanizeRole(role: string): string {
  const cleaned = role.trim().replace(/[-_]+/g, ' ') || 'helper';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function capSentence(text: string, limit = MAX_DISPLAY_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  const cut = normalized.slice(0, limit);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return sentenceEnd > 80 ? cut.slice(0, sentenceEnd + 1).trim() : `${cut.trimEnd()}...`;
}

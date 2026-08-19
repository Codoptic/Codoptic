import { createHash } from 'node:crypto';

export interface EditBlock {
  path: string;
  search: string;
  replace: string;
  reason: string;
}

export interface EditBlockPreview {
  path: string;
  beforeContent: string;
  afterContent: string;
  beforeExists: boolean;
  explanation: string;
  unifiedDiff: string;
  beforeHash: string;
  afterHash: string;
}

export interface EditBlockDiagnostic {
  path: string;
  code:
    | 'EMPTY_SEARCH'
    | 'SEARCH_NOT_FOUND'
    | 'SEARCH_NOT_UNIQUE'
    | 'INVALID_PATH'
    | 'SYNTAX_ERROR';
  message: string;
  line?: number;
  column?: number;
}

export type EditBlockResult =
  | { ok: true; previews: EditBlockPreview[] }
  | { ok: false; diagnostics: EditBlockDiagnostic[] };

export interface EditBlockApplyOptions {
  fileExists?: boolean;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeWs(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function findFuzzySearch(haystack: string, needle: string): string | null {
  const normalizedNeedle = normalizeWs(needle);
  if (!normalizedNeedle) return null;
  const lines = haystack.split('\n');
  const needleLines = needle.replace(/\r\n/g, '\n').split('\n');
  if (needleLines.length > lines.length) return null;
  for (let index = 0; index <= lines.length - needleLines.length; index += 1) {
    const slice = lines.slice(index, index + needleLines.length).join('\n');
    if (normalizeWs(slice) === normalizedNeedle) return slice;
  }
  return null;
}

function closestLineSnippet(haystack: string, needle: string): string {
  const first = needle.replace(/\r\n/g, '\n').split('\n').find((line) => line.trim()) ?? '';
  if (!first) return '';
  const hit = haystack.split('\n').find((line) => line.includes(first.trim().slice(0, 40)));
  return hit ? hit.slice(0, 200) : '';
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const next = haystack.indexOf(needle, index);
    if (next < 0) break;
    count += 1;
    index = next + needle.length;
  }
  return count;
}

function lineForIndex(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split('\n').length;
}

export function normalizeAgentPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

export function applyEditBlocksToContent(path: string, beforeContent: string, edits: EditBlock[], options: EditBlockApplyOptions = {}): EditBlockResult {
  const normalizedPath = normalizeAgentPath(path);
  if (!normalizedPath || normalizedPath.startsWith('../') || normalizedPath.includes('/../')) {
    return { ok: false, diagnostics: [{ path, code: 'INVALID_PATH', message: `Invalid edit path: ${path}` }] };
  }

  let nextContent = beforeContent;
  let exists = options.fileExists ?? true;
  const diagnostics: EditBlockDiagnostic[] = [];

  for (const edit of edits) {
    if (!edit.search) {
      if (!exists) {
        nextContent = edit.replace;
        exists = true;
        continue;
      }
      diagnostics.push({
        path: normalizedPath,
        code: 'EMPTY_SEARCH',
        message: 'SEARCH block can only be empty when creating a file that does not exist.',
      });
      continue;
    }

    if (!exists) {
      diagnostics.push({
        path: normalizedPath,
        code: 'SEARCH_NOT_FOUND',
        message: 'Target file does not exist. Use an empty SEARCH block to create it safely through edit_file.',
      });
      continue;
    }

    let search = edit.search;
    let occurrences = countOccurrences(nextContent, search);
    if (occurrences === 0) {
      const fuzzy = findFuzzySearch(nextContent, search);
      if (fuzzy) {
        search = fuzzy;
        occurrences = countOccurrences(nextContent, search);
      }
    }
    if (occurrences === 0) {
      const closest = closestLineSnippet(nextContent, edit.search);
      diagnostics.push({
        path: normalizedPath,
        code: 'SEARCH_NOT_FOUND',
        message: closest
          ? `SEARCH block did not match. Closest existing span:\n${closest}`
          : 'SEARCH block did not exactly match the current file. Re-read the target range and regenerate the edit.',
      });
      continue;
    }
    if (occurrences > 1) {
      diagnostics.push({
        path: normalizedPath,
        code: 'SEARCH_NOT_UNIQUE',
        message: 'SEARCH block matched more than once. Add surrounding context until it is unique.',
      });
      continue;
    }

    nextContent = nextContent.replace(search, edit.replace);
  }

  if (diagnostics.length) return { ok: false, diagnostics };

  return {
    ok: true,
    previews: [
      {
        path: normalizedPath,
        beforeContent,
        afterContent: nextContent,
        beforeExists: options.fileExists ?? true,
        explanation: edits.map((edit) => edit.reason).filter(Boolean).join('\n') || 'Surgical edit block proposal',
        unifiedDiff: createUnifiedDiff(normalizedPath, beforeContent, nextContent),
        beforeHash: hashContent(beforeContent),
        afterHash: hashContent(nextContent),
      },
    ],
  };
}

export function applyGroupedEditBlocks(files: Record<string, string>, edits: EditBlock[], options: { existingFiles?: Record<string, boolean> } = {}): EditBlockResult {
  const grouped = new Map<string, EditBlock[]>();
  for (const edit of edits) {
    const normalized = normalizeAgentPath(edit.path);
    grouped.set(normalized, [...(grouped.get(normalized) ?? []), { ...edit, path: normalized }]);
  }

  const previews: EditBlockPreview[] = [];
  const diagnostics: EditBlockDiagnostic[] = [];
  for (const [filePath, fileEdits] of grouped) {
    const before = files[filePath] ?? '';
    const result = applyEditBlocksToContent(filePath, before, fileEdits, { fileExists: options.existingFiles?.[filePath] ?? true });
    if (!result.ok) diagnostics.push(...result.diagnostics);
    else previews.push(...result.previews);
  }

  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, previews };
}

export function createUnifiedDiff(filePath: string, beforeContent: string, afterContent: string): string {
  if (beforeContent === afterContent) return '';

  const before = beforeContent.split('\n');
  const after = afterContent.split('\n');
  const out = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;
  const hunk: string[] = [];

  while (i < before.length || j < after.length) {
    if (before[i] === after[j]) {
      if (hunk.length) hunk.push(` ${before[i] ?? ''}`);
      i += 1;
      j += 1;
      oldLine += 1;
      newLine += 1;
      continue;
    }

    const startOld = oldLine;
    const startNew = newLine;
    hunk.length = 0;
    let oldCount = 0;
    let newCount = 0;

    while ((i < before.length || j < after.length) && before[i] !== after[j]) {
      const nextBeforeEqualsAfterNext = before[i] !== undefined && before[i] === after[j + 1];
      const nextAfterEqualsBeforeNext = after[j] !== undefined && after[j] === before[i + 1];

      if (nextBeforeEqualsAfterNext && after[j] !== undefined) {
        hunk.push(`+${after[j]}`);
        j += 1;
        newLine += 1;
        newCount += 1;
      } else if (nextAfterEqualsBeforeNext && before[i] !== undefined) {
        hunk.push(`-${before[i]}`);
        i += 1;
        oldLine += 1;
        oldCount += 1;
      } else {
        if (before[i] !== undefined) {
          hunk.push(`-${before[i]}`);
          i += 1;
          oldLine += 1;
          oldCount += 1;
        }
        if (after[j] !== undefined) {
          hunk.push(`+${after[j]}`);
          j += 1;
          newLine += 1;
          newCount += 1;
        }
      }

      if (hunk.length > 400) break;
    }

    out.push(`@@ -${startOld},${Math.max(oldCount, 1)} +${startNew},${Math.max(newCount, 1)} @@`);
    out.push(...hunk);
  }

  return `${out.join('\n')}\n`;
}

export function parseSearchReplaceBlocks(raw: string): EditBlock[] {
  const edits: EditBlock[] = [];
  const pattern = /<<<<<<< SEARCH(?:\s+path="([^"]+)")?[^\n]*\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
  for (const match of raw.matchAll(pattern)) {
    const path = match[1]?.trim();
    if (!path) continue;
    const search = match[2] ?? '';
    const replace = match[3] ?? '';
    edits.push({ path, search, replace, reason: 'Model-generated SEARCH/REPLACE block' });
  }
  return edits;
}

export function validateSyntaxLightweight(path: string, content: string): EditBlockDiagnostic[] {
  const diagnostics: EditBlockDiagnostic[] = [];
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'json') {
    try {
      JSON.parse(content);
    } catch (error) {
      diagnostics.push({ path, code: 'SYNTAX_ERROR', message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (ext === 'py') {
    diagnostics.push(...validatePythonIndentation(path, content));
  }

  if (['ts', 'tsx', 'js', 'jsx'].includes(ext ?? '')) {
    const pairs: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}']];
    for (const [open, close] of pairs) {
      const openCount = (content.match(new RegExp(`\\${open}`, 'g')) ?? []).length;
      const closeCount = (content.match(new RegExp(`\\${close}`, 'g')) ?? []).length;
      if (Math.abs(openCount - closeCount) > 2) {
        const index = content.lastIndexOf(openCount > closeCount ? open : close);
        diagnostics.push({
          path,
          code: 'SYNTAX_ERROR',
          line: lineForIndex(content, index),
          message: `Large delimiter imbalance for ${open}${close}. Run typecheck after applying or regenerate a smaller edit.`,
        });
      }
    }
  }

  return diagnostics;
}

function validatePythonIndentation(path: string, content: string): EditBlockDiagnostic[] {
  const diagnostics: EditBlockDiagnostic[] = [];
  const indentStack = [0];
  let previousRequiresIndent = false;
  let bracketDepth = 0;
  let backslashContinuation = false;
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const trimmed = rawLine.trim();
    const lineNumber = index + 1;
    if (!trimmed || trimmed.startsWith('#')) continue;

    const leading = rawLine.match(/^[\t ]*/)?.[0] ?? '';
    if (/\t/.test(leading) && / /.test(leading)) {
      diagnostics.push({ path, code: 'SYNTAX_ERROR', line: lineNumber, column: 1, message: 'Python indentation mixes tabs and spaces on the same line.' });
      break;
    }

    const indent = indentationWidth(leading);
    const currentIndent = indentStack[indentStack.length - 1] ?? 0;
    // A physical line is a continuation when the previous logical line left a bracket open or
    // ended with a backslash. Continuation lines have free-form indentation, so skip indent checks.
    const inContinuation = bracketDepth > 0 || backslashContinuation;

    if (!inContinuation && indent > currentIndent) {
      if (!previousRequiresIndent) {
        diagnostics.push({
          path,
          code: 'SYNTAX_ERROR',
          line: lineNumber,
          column: leading.length + 1,
          message: 'Unexpected Python indentation: this line is indented without a preceding block header.',
        });
        break;
      }
      indentStack.push(indent);
    } else if (!inContinuation && indent < currentIndent) {
      while (indentStack.length > 1 && indent < (indentStack[indentStack.length - 1] ?? 0)) indentStack.pop();
      if (indent !== (indentStack[indentStack.length - 1] ?? 0)) {
        diagnostics.push({ path, code: 'SYNTAX_ERROR', line: lineNumber, column: leading.length + 1, message: 'Python indentation does not match any outer indentation level.' });
        break;
      }
    } else if (!inContinuation && previousRequiresIndent && indent === currentIndent) {
      diagnostics.push({ path, code: 'SYNTAX_ERROR', line: lineNumber, column: leading.length + 1, message: 'Expected an indented Python block after a block header.' });
      break;
    }

    const stripped = stripPythonComment(trimmed);
    const newBracketDepth = Math.max(0, bracketDepth + bracketDelta(stripped));
    const endsWithBackslash = stripped.trimEnd().endsWith('\\');
    // Root Cause vs Logic: a block header can complete on the same physical line that closes a
    // multi-line bracket (e.g. `for x in [\n ... \n]:`). The colon only opens an indented block once
    // the statement's brackets are balanced and it is not a backslash continuation. Using the
    // start-of-line continuation flag (the old code) cleared this requirement and falsely rejected
    // the valid indented body that followed.
    previousRequiresIndent = newBracketDepth === 0 && !endsWithBackslash && pythonLineRequiresIndent(trimmed);
    bracketDepth = newBracketDepth;
    backslashContinuation = newBracketDepth === 0 && endsWithBackslash;
  }

  return diagnostics;
}

function indentationWidth(value: string): number {
  let width = 0;
  for (const char of value) width += char === '\t' ? 4 : 1;
  return width;
}

function pythonLineRequiresIndent(trimmedLine: string): boolean {
  return stripPythonComment(trimmedLine).trimEnd().endsWith(':');
}

function stripPythonComment(line: string): string {
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = line[index - 1];
    if (char === "'" && previous !== '\\' && quote !== 'double') quote = quote === 'single' ? null : 'single';
    if (char === '"' && previous !== '\\' && quote !== 'single') quote = quote === 'double' ? null : 'double';
    if (char === '#' && quote == null) return line.slice(0, index);
  }
  return line;
}

function bracketDelta(line: string): number {
  let delta = 0;
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = line[index - 1];
    if (char === "'" && previous !== '\\' && quote !== 'double') quote = quote === 'single' ? null : 'single';
    else if (char === '"' && previous !== '\\' && quote !== 'single') quote = quote === 'double' ? null : 'double';
    else if (quote == null && ['(', '[', '{'].includes(char ?? '')) delta += 1;
    else if (quote == null && [')', ']', '}'].includes(char ?? '')) delta -= 1;
  }
  return delta;
}

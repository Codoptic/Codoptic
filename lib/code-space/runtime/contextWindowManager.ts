/**
 * Context window management for Codoptic's agent loops.
 *
 * Provides token estimation, model-aware budget allocation, and adaptive evidence
 * reduction so seed messages fit within provider context limits before the first call.
 *
 * Pruning priority when over budget:
 *  1. Halve the repository file index
 *  2. Halve per-file character limits and evidence file count
 *  3. Skeleton mode — replace evidence bodies with signature-only extractions
 */

const CHARS_PER_TOKEN = 3.8;

/**
 * Context windows (tokens) keyed by model name substring — longest key first so that
 * 'gpt-35-turbo-16k' matches before 'gpt-35-turbo', 'gemini-1.5-pro' before 'gemini-1.5'.
 */
const CONTEXT_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ['gpt-4o-mini', 128_000],
  ['gpt-4o', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4-32k', 32_768],
  ['gpt-35-turbo-16k', 16_384],
  ['gpt-35-turbo', 4_096],
  ['gpt-4', 8_192],
  ['o3-mini', 200_000],
  ['o1-preview', 128_000],
  ['o1-mini', 128_000],
  ['o1', 128_000],
  ['o3', 200_000],
  ['claude-3-5', 200_000],
  ['claude-3', 200_000],
  ['claude-2', 100_000],
  ['gemini-1.5-pro', 2_000_000],
  ['gemini-1.5-flash', 1_000_000],
  ['gemini-1.5', 1_000_000],
  ['gemini-pro', 32_760],
  ['gemini', 32_760],
  ['mistral-large', 128_000],
  ['mistral-small', 32_000],
  ['mistral', 32_000],
  ['llama-3', 128_000],
  ['llama', 8_192],
  ['deepseek', 64_000],
];

const SAFE_DEFAULT_CONTEXT_WINDOW = 32_000;

const OUTPUT_RESERVE = 4_096;
const OVERHEAD_RESERVE = 3_000;

export interface ContextBudget {
  maxFiles: number;
  maxCharsPerFile: number;
  maxIndexEntries: number;
  /** Replace evidence bodies with regex-extracted skeletons to minimize token usage. */
  useSkeleton: boolean;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function contextWindowForModel(model: string): number {
  const lower = model.toLowerCase();
  const match = CONTEXT_WINDOWS.find(([key]) => lower.includes(key));
  return match?.[1] ?? SAFE_DEFAULT_CONTEXT_WINDOW;
}

/**
 * Computes adaptive evidence limits that fit the model's context window.
 * Falls through progressively more aggressive tiers until one fits.
 */
export function allocateContextBudget(model: string): ContextBudget {
  const window = contextWindowForModel(model);
  const available = window - OUTPUT_RESERVE - OVERHEAD_RESERVE;

  // Token estimate: index entries (~65 chars avg) + evidence (maxCharsPerFile chars each).
  const estimate = (maxFiles: number, maxCharsPerFile: number, maxIndexEntries: number): number =>
    Math.ceil((maxIndexEntries * 65) / CHARS_PER_TOKEN) +
    maxFiles * Math.ceil(maxCharsPerFile / CHARS_PER_TOKEN);

  if (estimate(24, 16_000, 800) <= available) return { maxFiles: 24, maxCharsPerFile: 16_000, maxIndexEntries: 800, useSkeleton: false };
  if (estimate(24, 16_000, 400) <= available) return { maxFiles: 24, maxCharsPerFile: 16_000, maxIndexEntries: 400, useSkeleton: false };
  if (estimate(16, 8_000, 300) <= available) return { maxFiles: 16, maxCharsPerFile: 8_000, maxIndexEntries: 300, useSkeleton: false };
  if (estimate(10, 4_000, 200) <= available) return { maxFiles: 10, maxCharsPerFile: 4_000, maxIndexEntries: 200, useSkeleton: false };
  if (estimate(6, 2_000, 100) <= available) return { maxFiles: 6, maxCharsPerFile: 2_000, maxIndexEntries: 100, useSkeleton: true };
  return { maxFiles: 4, maxCharsPerFile: 1_000, maxIndexEntries: 50, useSkeleton: true };
}

/**
 * Returns a tighter budget that uses skeleton summaries and halves all limits.
 * Used as the retry budget after a content-filter or context-limit 400 error.
 */
export function fallbackContextBudget(current: ContextBudget): ContextBudget {
  return {
    maxFiles: Math.max(4, Math.floor(current.maxFiles / 2)),
    maxCharsPerFile: Math.max(800, Math.floor(current.maxCharsPerFile / 2)),
    maxIndexEntries: Math.max(50, Math.floor(current.maxIndexEntries / 2)),
    useSkeleton: true,
  };
}

// --- Patterns for TypeScript/JavaScript skeleton extraction ---
const TS_IMPORT_RE = /^import\b/;
const TS_EXPORT_REEXPORT_RE = /^export\s+\{/;
const TS_DECORATOR_RE = /^@\w/;
const TS_DECLARATION_RE = /^(?:export\s+)?(?:(?:async\s+)?function|class|interface|type|enum|const\s+\w+\s*[:=]|let\s+\w+\s*[:=])\b|^(?:(?:public|private|protected|static|readonly|abstract|override|async)\s+)+\w+\s*[(<]|^export\s+default\b/;

// --- Patterns for Python skeleton extraction ---
const PY_KEEP_RE = /^(?:def |async def |class |from .+ import|import |@\w+)/;

/**
 * Extracts a compact skeleton from a source file: imports, exports, type/interface
 * definitions, and function/class signatures. Function bodies are collapsed to `{ ... }`.
 *
 * Handles TypeScript/JavaScript and Python. Other file types are sliced to ~600 chars.
 */
export function skeletonizeFileContent(filePath: string, content: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'py') return skeletonizePython(filePath, content);
  if (['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].includes(ext)) return skeletonizeTypeScript(filePath, content);
  return `// Skeleton: ${filePath}\n${content.slice(0, 600)}\n// [truncated]`;
}

/**
 * Format a single evidence file body for a seed message.
 *
 * Motivation vs Logic: blindly slicing a large file at `maxCharsPerFile` cuts mid-function and
 * loses the very signatures the agent needs to act. Instead, oversized files are skeletonized
 * (imports/exports/signatures preserved, bodies elided) before any hard cut, so the model keeps a
 * faithful API surface rather than an arbitrary prefix.
 */
export function formatEvidenceBody(filePath: string, content: string, budget: ContextBudget): string {
  if (content.length <= budget.maxCharsPerFile) {
    return budget.useSkeleton ? skeletonizeFileContent(filePath, content) : content;
  }
  const skeleton = skeletonizeFileContent(filePath, content);
  if (skeleton.length <= budget.maxCharsPerFile) return skeleton;
  return `${skeleton.slice(0, budget.maxCharsPerFile)}\n// [skeleton truncated — use read_file for the rest]`;
}

function skeletonizeTypeScript(filePath: string, content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [`// Skeleton: ${filePath}`];
  let braceDepth = 0;
  let inBody = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
      if (!inBody) kept.push(line);
      continue;
    }

    if (TS_IMPORT_RE.test(trimmed) || TS_EXPORT_REEXPORT_RE.test(trimmed) || TS_DECORATOR_RE.test(trimmed)) {
      if (!inBody) kept.push(line);
      continue;
    }

    if (TS_DECLARATION_RE.test(trimmed)) {
      if (!inBody) {
        const sigLine = line.trimEnd();
        kept.push(sigLine.endsWith('{') ? `${sigLine} ... }` : sigLine);
        const opens = (line.match(/\{/g)?.length ?? 0);
        const closes = (line.match(/\}/g)?.length ?? 0);
        const net = opens - closes;
        if (net > 0) { braceDepth = net; inBody = true; }
      }
      continue;
    }

    if (inBody) {
      braceDepth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      if (braceDepth <= 0) {
        braceDepth = 0;
        inBody = false;
        if (trimmed === '}' || trimmed === '};' || trimmed === '})' || trimmed === '});') kept.push(line);
      }
    } else {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

function skeletonizePython(filePath: string, content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [`# Skeleton: ${filePath}`];
  let inBody = false;
  let bodyIndent = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (PY_KEEP_RE.test(trimmed)) {
      kept.push(line);
      inBody = true;
      bodyIndent = indent;
      continue;
    }

    if (inBody) {
      if (trimmed === '' || indent <= bodyIndent) { inBody = false; }
      else { continue; }
    }

    if (!inBody) kept.push(line);
  }
  return kept.join('\n');
}

/** True when the error signals the prompt exceeded the model's context window. */
export function isContextLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /context.{0,40}(length|limit|window|exceeded|too.{0,15}long)|maximum.{0,25}token|reduce.{0,20}(input|length|size)|tokens.{0,25}(exceed|over|maximum)/i.test(err.message);
}

/** True when Azure OpenAI's content management policy filtered the request. */
export function isContentFilterError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return /content.{0,40}(filter|policy|management|blocked|flagged|filtered)|ResponsibleAI|content_filter/i.test(msg);
}

/** True when a 400 can be mitigated by reducing or skeletonizing the prompt payload. */
export function isReduciblePromptError(err: unknown): boolean {
  return isContextLimitError(err) || isContentFilterError(err);
}

/**
 * Compresses old tool-result messages in a conversation to reduce total token count.
 * Keeps the most recent `keepRecent` tool turns intact; older ones are trimmed to a summary.
 */
export function compressMessageHistory(
  messages: Array<{ role: string; content: string; toolResults?: Array<{ toolCallId: string; content: string; isError?: boolean }> }>,
  keepRecent = 4,
): void {
  const MAX_OLD_RESULT_CHARS = 400;
  let toolTurnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'tool' || !msg.toolResults) continue;
    toolTurnsSeen++;
    if (toolTurnsSeen <= keepRecent) continue;
    for (const result of msg.toolResults) {
      if (result.content.length > MAX_OLD_RESULT_CHARS) {
        result.content = `${result.content.slice(0, MAX_OLD_RESULT_CHARS)}\n[prior tool result truncated for context]`;
      }
    }
  }
}

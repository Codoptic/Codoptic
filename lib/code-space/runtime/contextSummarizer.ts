/**
 * Chunked LLM summarizer for agent evidence files.
 *
 * When the context window budget is tight, large evidence files are split into
 * semantically-bounded chunks and each chunk is summarized by the provider before
 * being assembled back into a compact, high-signal representation.
 *
 * Prompt design principles (industry-standard approach):
 * - Preserve exact names — the coding agent needs them verbatim for tool calls.
 * - Elide bodies — keep signatures, types, and configuration values only.
 * - Target density — 10-30 declarations per chunk; prose is stripped.
 * - Chunk boundaries at blank lines after closing braces (semantic vs. hard splits).
 *
 * Hierarchy:
 *   small file  (<= 8K chars)   → returned as-is
 *   medium file (<= 32K chars)  → synchronous regex skeleton (no LLM call, instant)
 *   large file  (> 32K chars)   → async LLM chunked summarization with sync fallback
 */

import type { ProviderSession } from '@/lib/agent/providers';
import { chatWithRetry } from '@/lib/agent/providers';
import { skeletonizeFileContent } from './contextWindowManager';

const DEFAULT_CHUNK_SIZE_CHARS = 7_000;
const SMALL_FILE_CHARS = 8_000;
const MEDIUM_FILE_CHARS = 32_000;

/**
 * System prompt for the chunk summarizer.
 * Deliberately minimal — the coding agent downstream needs API surface, not narrative.
 */
export const SUMMARIZER_SYSTEM_PROMPT = [
  'You are a code summarizer for an autonomous coding agent. Condense source code into compact, high-signal summaries.',
  '',
  'Rules:',
  '- Extract: function/method signatures with parameter types and return types, class names, exported constants, type and interface definitions, and key configuration values.',
  '- Preserve: exact identifiers — names of functions, types, and exports must appear verbatim. The downstream agent uses them as-is.',
  '- Omit: implementation bodies, inline comments, blank lines, and anything not in the API surface.',
  '- Format: one declaration per line. No markdown headers. No prose explanations.',
  '- Config files (JSON, YAML, TOML): emit key–value pairs at the top level only, skip nested boilerplate.',
  '- Cap output: 10–35 lines. If the chunk has fewer declarations, include them all.',
].join('\n');

/**
 * Prompt for a single chunk. Exported so callers can log or unit-test the exact payload.
 */
export function buildChunkSummaryPrompt(
  filePath: string,
  chunkIndex: number,
  totalChunks: number,
  chunk: string,
  task: string,
): string {
  return [
    `File: ${filePath}${totalChunks > 1 ? ` (chunk ${chunkIndex + 1}/${totalChunks})` : ''}`,
    `Task context (for relevance): ${task.slice(0, 240)}`,
    '',
    '```',
    chunk,
    '```',
    '',
    'Emit a compact summary of the declarations above. One declaration per line. No prose.',
  ].join('\n');
}

/**
 * Splits content into chunks at semantic boundaries (blank lines after closing braces)
 * when a natural split point exists within 200 chars of the target. Falls back to a
 * hard character split if no natural boundary is found.
 */
export function chunkContent(content: string, chunkSize = DEFAULT_CHUNK_SIZE_CHARS): string[] {
  if (content.length <= chunkSize) return [content];
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const end = start + chunkSize;
    if (end >= content.length) {
      chunks.push(content.slice(start));
      break;
    }
    // Search a ±200-char window around the target split for a blank line.
    const windowStart = Math.max(start, end - 200);
    const windowEnd = Math.min(content.length, end + 200);
    const window = content.slice(windowStart, windowEnd);
    const blankLineMatch = window.match(/\n\n(?=\S)/);
    const splitAt = blankLineMatch?.index != null ? windowStart + blankLineMatch.index + 1 : end;
    chunks.push(content.slice(start, splitAt));
    start = splitAt;
  }
  return chunks;
}

export class ContextSummarizer {
  constructor(private readonly session: ProviderSession) {}

  /**
   * Regex skeleton extraction — always available, zero latency, no LLM cost.
   * Reliable fallback for any error path.
   */
  summarizeSync(filePath: string, content: string): string {
    return skeletonizeFileContent(filePath, content);
  }

  /**
   * LLM-based chunked summarization. Splits the file, summarizes each chunk in parallel,
   * then reassembles with part markers when multi-chunk. Falls back to sync on any error.
   */
  async summarizeAsync(filePath: string, content: string, task: string, signal?: AbortSignal): Promise<string> {
    try {
      const chunks = chunkContent(content);
      const summaries = await Promise.all(
        chunks.map((chunk, idx) =>
          chatWithRetry(
            this.session,
            [
              { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
              { role: 'user', content: buildChunkSummaryPrompt(filePath, idx, chunks.length, chunk, task) },
            ],
            { signal },
          ),
        ),
      );
      const body = summaries
        .map((s, i) => (chunks.length > 1 ? `// --- part ${i + 1}/${chunks.length} ---\n${s.trim()}` : s.trim()))
        .join('\n');
      return `// Summarized by ContextSummarizer: ${filePath}\n${body}`;
    } catch {
      return this.summarizeSync(filePath, content);
    }
  }

  /**
   * Tiered entry point:
   *  - Small  (<= 8K chars)  → return as-is
   *  - Medium (<= 32K chars) → sync skeleton
   *  - Large  (> 32K chars)  → async LLM chunked summarization
   */
  async summarize(filePath: string, content: string, task: string, signal?: AbortSignal): Promise<string> {
    if (content.length <= SMALL_FILE_CHARS) return content;
    if (content.length <= MEDIUM_FILE_CHARS) return this.summarizeSync(filePath, content);
    return this.summarizeAsync(filePath, content, task, signal);
  }
}

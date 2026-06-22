import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeContextPath, safeReadTextFile } from './repoMap';

export const PROJECT_MEMORY_DIR = 'memories';
export const RECOMMENDED_MEMORY_FILES = [
  'user-preferences.md',
  'project-context.md',
  'research-notes.md',
  'decisions.md',
];

const MEMORY_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json']);
const MAX_MEMORY_BYTES = 120_000;
const MAX_MEMORY_CHARS = 12_000;

export interface MemoryEntry {
  path: string;
  title: string;
  content: string;
  score: number;
  reasons: string[];
  truncated: boolean;
}

export interface MemoryBackend {
  list(root: string): Promise<string[]>;
  read(root: string, memoryPath: string): Promise<MemoryEntry | null>;
}

export interface MemoryContext {
  entries: MemoryEntry[];
  recommendedFiles: string[];
}

export class ProjectFileMemoryBackend implements MemoryBackend {
  async list(root: string): Promise<string[]> {
    const dir = path.join(root, PROJECT_MEMORY_DIR);
    const results: string[] = [];

    async function walk(current: string): Promise<void> {
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const full = path.join(current, entry.name);
        const relative = normalizeContextPath(path.relative(root, full));
        if (!relative || !relative.startsWith(`${PROJECT_MEMORY_DIR}/`)) continue;
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!MEMORY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_MEMORY_BYTES) continue;
        } catch {
          continue;
        }
        results.push(relative);
      }
    }

    await walk(dir);
    return results.sort();
  }

  async read(root: string, memoryPath: string): Promise<MemoryEntry | null> {
    const normalized = normalizeMemoryPath(memoryPath);
    if (!normalized) return null;
    const content = await safeReadTextFile(root, normalized);
    if (content == null) return null;
    return toMemoryEntry(normalized, content, 0, ['direct_read']);
  }
}

export class MemoryManager {
  constructor(private readonly backend: MemoryBackend = new ProjectFileMemoryBackend()) {}

  async collectRelevant(root: string, prompt: string, limit = 4): Promise<MemoryContext> {
    const files = await this.backend.list(root);
    const terms = memoryTerms(prompt);
    const entries: MemoryEntry[] = [];
    for (const file of files) {
      const entry = await this.backend.read(root, file);
      if (!entry) continue;
      const scored = scoreMemory(entry, terms);
      if (scored.score > 0 || isRecommendedMemory(file)) entries.push(scored);
    }
    return {
      entries: entries
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, Math.max(0, limit)),
      recommendedFiles: RECOMMENDED_MEMORY_FILES.map((file) => `${PROJECT_MEMORY_DIR}/${file}`),
    };
  }

  async list(root: string): Promise<string[]> {
    return this.backend.list(root);
  }

  async read(root: string, memoryPath: string): Promise<MemoryEntry | null> {
    return this.backend.read(root, memoryPath);
  }
}

export function normalizeMemoryPath(memoryPath: string): string {
  if (path.isAbsolute(memoryPath) || memoryPath.includes('..')) return '';
  const normalized = normalizeContextPath(memoryPath);
  if (!normalized) return '';
  const withRoot = normalized === PROJECT_MEMORY_DIR || normalized.startsWith(`${PROJECT_MEMORY_DIR}/`)
    ? normalized
    : `${PROJECT_MEMORY_DIR}/${normalized}`;
  if (withRoot === PROJECT_MEMORY_DIR) return '';
  if (withRoot.includes('..') || path.isAbsolute(withRoot)) return '';
  if (!MEMORY_EXTENSIONS.has(path.extname(withRoot).toLowerCase())) return '';
  return withRoot;
}

export function formatMemoryContext(context: MemoryContext): string {
  if (!context.entries.length) {
    return [
      'Project memories: none found.',
      `Recommended durable memory files: ${context.recommendedFiles.join(', ')}.`,
      'Do not create or update memories unless the user asks or a memory update is clearly useful; propose updates with propose_memory_update.',
    ].join('\n');
  }
  const rendered = context.entries.map((entry) =>
    [
      `--- MEMORY ${entry.path} (${entry.title}) ---`,
      entry.content,
      entry.truncated ? '[TRUNCATED]' : '',
    ].filter(Boolean).join('\n'),
  );
  return [
    'Relevant project memories loaded from /memories (durable user/project knowledge, not cache):',
    ...rendered,
    '',
    'Use memory as preference/context evidence. If this run discovers durable knowledge worth saving, call propose_memory_update rather than writing memory files directly.',
  ].join('\n\n');
}

function toMemoryEntry(memoryPath: string, rawContent: string, score: number, reasons: string[]): MemoryEntry {
  const redacted = redactSecrets(rawContent.trim());
  const title = redacted.split(/\r?\n/).find((line) => line.trim())?.replace(/^#+\s*/, '').slice(0, 120) || path.basename(memoryPath);
  const truncated = redacted.length > MAX_MEMORY_CHARS;
  return {
    path: memoryPath,
    title,
    content: truncated ? redacted.slice(0, MAX_MEMORY_CHARS) : redacted,
    score,
    reasons,
    truncated,
  };
}

function scoreMemory(entry: MemoryEntry, terms: string[]): MemoryEntry {
  const haystack = `${entry.path}\n${entry.title}\n${entry.content}`.toLowerCase();
  let score = isRecommendedMemory(entry.path) ? 10 : 0;
  const reasons = new Set(entry.reasons);
  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    score += entry.path.toLowerCase().includes(term) ? 12 : 4;
    reasons.add(`matches:${term}`);
  }
  if (/preference|prefer|style|decision|context|research|constraint/i.test(entry.content)) {
    score += 6;
    reasons.add('durable_context');
  }
  return { ...entry, score, reasons: Array.from(reasons) };
}

function memoryTerms(prompt: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'code', 'space', 'please', 'implement', 'review']);
  return Array.from(new Set(prompt.toLowerCase().split(/[^a-z0-9_/-]+/).filter((term) => term.length > 2 && !stop.has(term)))).slice(0, 32);
}

function isRecommendedMemory(memoryPath: string): boolean {
  return RECOMMENDED_MEMORY_FILES.some((file) => memoryPath === `${PROJECT_MEMORY_DIR}/${file}`);
}

function redactSecrets(content: string): string {
  return content
    .replace(/(api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{20,})\b/gi, '[REDACTED]');
}

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardPath } from '@/lib/security/pathGuard';

export type AgentArtifactKind = 'terminal_log' | 'grep_result' | 'test_report' | 'lsp_trace' | 'docs_page' | 'large_file' | 'validation_report' | 'browser_screenshot';

export interface AgentArtifact {
  artifactId: string;
  runId: string;
  kind: AgentArtifactKind;
  path: string;
  summary: string;
  byteLength: number;
  lineCount: number;
  createdAt: number;
  readHints: Array<{ startLine: number; endLine: number; reason: string }>;
}

function artifactRoot(projectRoot: string, runId: string): string {
  const guarded = guardPath(projectRoot);
  const safeRun = runId.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  if (guarded.ok) return path.join(guarded.resolved, '.agent', 'runs', safeRun, 'artifacts');
  return path.join(os.tmpdir(), 'codoptic-artifacts', safeRun);
}

function idFor(runId: string, kind: AgentArtifactKind, content: string): string {
  const digest = createHash('sha256').update(`${runId}:${kind}:${content}`).digest('hex').slice(0, 12);
  return `artifact:${runId.replace(/[^a-zA-Z0-9_.-]+/g, '-')}:${kind}:${digest}`;
}

function summarizeLines(content: string): Array<{ startLine: number; endLine: number; reason: string }> {
  const lines = content.split('\n');
  const hints: Array<{ startLine: number; endLine: number; reason: string }> = [];
  const failureIndex = lines.findIndex((line) => /error|failed|failure|exception|stack|TS\d+|ERR!/i.test(line));
  if (failureIndex >= 0) {
    hints.push({ startLine: Math.max(1, failureIndex - 5), endLine: Math.min(lines.length, failureIndex + 20), reason: 'first likely failure' });
  }
  if (lines.length > 40) hints.push({ startLine: Math.max(1, lines.length - 40), endLine: lines.length, reason: 'final output summary' });
  if (!hints.length) hints.push({ startLine: 1, endLine: Math.min(lines.length, 80), reason: 'artifact preview' });
  return hints;
}

export async function writeAgentArtifact({
  projectRoot,
  runId,
  kind,
  content,
  summary,
}: {
  projectRoot: string;
  runId: string;
  kind: AgentArtifactKind;
  content: string;
  summary: string;
}): Promise<AgentArtifact> {
  const root = artifactRoot(projectRoot, runId);
  await fs.mkdir(root, { recursive: true });
  const artifactId = idFor(runId, kind, content);
  const filePath = path.join(root, `${artifactId.replace(/[:/]/g, '-')}.txt`);
  await fs.writeFile(filePath, content, 'utf8');
  const lines = content.split('\n');
  return {
    artifactId,
    runId,
    kind,
    path: filePath,
    summary,
    byteLength: Buffer.byteLength(content, 'utf8'),
    lineCount: lines.length,
    createdAt: Date.now(),
    readHints: summarizeLines(content),
  };
}

export async function readArtifactRange(artifactPath: string, startLine: number, endLine: number): Promise<{ content: string; startLine: number; endLine: number; lineCount: number }> {
  const content = await fs.readFile(artifactPath, 'utf8');
  const lines = content.split('\n');
  const start = Math.max(1, Math.floor(startLine));
  const end = Math.min(lines.length, Math.max(start, Math.floor(endLine)));
  return {
    content: lines.slice(start - 1, end).join('\n'),
    startLine: start,
    endLine: end,
    lineCount: lines.length,
  };
}

export async function grepArtifact(artifactPath: string, pattern: string, contextLines = 3): Promise<{ matches: Array<{ line: number; text: string; context: string[] }>; truncated: boolean }> {
  const content = await fs.readFile(artifactPath, 'utf8');
  const lines = content.split('\n');
  const rx = new RegExp(pattern, 'i');
  const matches: Array<{ line: number; text: string; context: string[] }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!rx.test(line)) continue;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length, index + contextLines + 1);
    matches.push({ line: index + 1, text: line, context: lines.slice(start, end) });
    if (matches.length >= 50) break;
  }
  return { matches, truncated: matches.length >= 50 };
}

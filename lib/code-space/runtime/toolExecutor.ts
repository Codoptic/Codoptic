import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AutonomyLevel } from '@/lib/code-space/domain';
import type { CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';
import type { ToolCall, ToolSpec } from '@/lib/agent/providers';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import {
  applyGroupedEditBlocks,
  createUnifiedDiff,
  validateSyntaxLightweight,
  type EditBlock,
  type EditBlockDiagnostic,
} from '@/lib/code-space/agent/editBlocks';
import { writeAgentArtifact, readArtifactRange, grepArtifact, type AgentArtifact } from '@/lib/code-space/agent/artifacts';
import type { AgentEventType } from './events';
import { applyPatchFiles, PatchApplyError } from './patchApply';
import { planContainsRequiredSections, REQUIRED_PLAN_SECTIONS } from './planningEngine';
import type { SubagentSpawnRequest, SubagentResult } from './subagentRunner';
import {
  createCheckpointFromSnapshots,
  loadFileCheckpoint,
  restoreFileCheckpoint,
  type FileCheckpoint,
} from './checkpointManager';
import { PermissionManager } from './permissionManager';
import { createDefaultToolRegistry, ToolRegistry } from './toolRegistry';
import { TerminalRunner } from './terminalRunner';
import { isRiskyTerminalCommand, type TerminalCommand } from './terminalPolicy';
import { traceDependencyEdges } from './dependencyTrace';
import { listRepositoryFiles, normalizeContextPath, safeReadTextFile } from './repoMap';
import { hashContent } from './patchReview';

export interface LedgerEntry {
  beforeContent: string;
  afterContent: string;
  deleted: boolean;
  existedBefore: boolean;
}

export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
}

export type EditFailureCode = 'SEARCH_NOT_FOUND' | 'SEARCH_NOT_UNIQUE' | 'SYNTAX_ERROR' | 'AST_PREVALIDATION_FAILED';

export interface EditFailure {
  code: EditFailureCode;
  message: string;
  line?: number;
  at: number;
}

/** Persisted checkpoint plus a hook so the runtime can record it to the store. */
export type CheckpointSink = (checkpoint: FileCheckpoint) => void | Promise<void>;

export interface CodeAgentContext {
  root: string;
  runId: string;
  projectId: string;
  sessionId: string;
  autonomy: AutonomyLevel;
  emit: (event: AgentSSEEvent) => void | Promise<void>;
  emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>;
  /** Original → latest content per touched path; powers the final cumulative diff. */
  ledger: Map<string, LedgerEntry>;
  /** Paths proposed (but NOT written) under suggest_only autonomy — pending user accept/reject. */
  proposedFiles: Set<string>;
  /** Latest proposed before/after per path (suggest_only); used for final pre-completion validation. */
  proposedLedger: Map<string, Pick<LedgerEntry, 'beforeContent' | 'afterContent' | 'existedBefore'>>;
  /** Recoverable edit_file failures per path — cleared when a working edit lands. */
  editFailures: Map<string, EditFailure[]>;
  /** Files the model has read this run. */
  readFiles: Set<string>;
  /** Artifacts produced during the run, keyed by artifactId. */
  artifacts: Map<string, AgentArtifact>;
  /** Checkpoints captured during the run (per edit_file apply). */
  checkpoints: FileCheckpoint[];
  /** Plan mode: clarifying questions the model asked (terminal — pauses the run). */
  planClarification?: { questions: CodeSpaceClarifyingQuestion[] };
  /** Plan mode: the finalized plan artifact the model authored (terminal). */
  planArtifactRequest?: { planMarkdown: string; summary: string; inspectedFiles: string[]; status: 'ready' | 'needs_review' };
  /** Code mode: spawn an isolated subagent (wired by the runtime). Absent in subagent contexts. */
  spawnSubagent?: (request: SubagentSpawnRequest) => Promise<SubagentResult>;
  registry: ToolRegistry;
  permission: PermissionManager;
  terminal: TerminalRunner;
  onCheckpoint?: CheckpointSink;
  signal?: AbortSignal;
}

const MAX_TOOL_OUTPUT = 6000;
const MAX_SEARCH_FILE_BYTES = 200_000;
const MAX_SEARCH_MATCHES = 80;

/** Tool specs advertised to the model for Code mode. */
export const CODE_MODE_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace. Optionally pass startLine/endLine (1-based) to read a slice. Always read a file before editing it.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'] },
  },
  {
    name: 'list_files',
    description: 'List files and folders under a workspace directory (default: repo root). Set recursive=true to list the full subtree.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } } },
  },
  {
    name: 'search_text',
    description: 'Search the workspace for a substring or regex, returning matching files with line numbers and nearby context. Use before refactors to find references.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, glob: { type: 'string' }, contextLines: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'repo_map',
    description: 'Summarize the repository: file count, top-level directories, detected languages, package manager, and available validation commands.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dependency_trace',
    description: 'Trace direct imports and reverse importers around the given paths. Use after a rename/move to find every file that must be updated.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
  },
  {
    name: 'git_status',
    description: 'Show the current git branch and changed-file state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    description: 'Show the current uncommitted workspace diff, optionally scoped to a path.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'read_artifact',
    description: 'Read a line range from a stored artifact (e.g. full command output) by artifactId instead of pulling the whole thing into context.',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['artifactId', 'startLine', 'endLine'] },
  },
  {
    name: 'grep_artifact',
    description: 'Search inside a stored artifact by artifactId without loading it fully into context.',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string' }, pattern: { type: 'string' }, contextLines: { type: 'number' } }, required: ['artifactId', 'pattern'] },
  },
  {
    name: 'edit_file',
    description: 'Apply exact SEARCH/REPLACE edit blocks to files on disk. Each edit\'s "search" must match the current file content exactly and uniquely. The server checkpoints, conflict-checks, syntax-validates, and writes. Returns diffs or actionable diagnostics to fix and retry. Use empty search with a new path to create a file.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' }, reason: { type: 'string' } },
            required: ['path', 'search', 'replace', 'reason'],
          },
        },
      },
      required: ['edits'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a workspace command (tests, typecheck, build, lint, grep, ls, etc.) and capture output. Destructive or network-mutating commands are gated and require approval.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, reason: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command', 'reason'] },
  },
  {
    name: 'restore_checkpoint',
    description: 'Revert all files captured by a previously created checkpoint (checkpointRef is the checkpoint id returned by an earlier edit_file).',
    inputSchema: { type: 'object', properties: { checkpointRef: { type: 'string' }, reason: { type: 'string' } }, required: ['checkpointRef'] },
  },
  {
    name: 'spawn_subagent',
    description:
      'Delegate a focused subtask to an isolated subagent with a fresh context window. role is one of: explorer, critic, docs-reader, test-writer, verifier. Returns the subagent\'s factual summary. Use to parallelize investigation, get an independent critique, read docs, or write tests without bloating your own context. Read-only roles cannot edit files.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string' },
        task: { type: 'string' },
        readOnly: { type: 'boolean' },
        maxToolCalls: { type: 'number' },
        allowedTools: { type: 'array', items: { type: 'string' } },
      },
      required: ['role', 'task'],
    },
  },
  {
    name: 'attempt_completion',
    description: 'Signal that the task is finished. Set success=false if you could not complete it; never fabricate a result. Provide a concise summary of what changed (or why it could not be done).',
    inputSchema: { type: 'object', properties: { success: { type: 'boolean' }, summary: { type: 'string' } }, required: ['success', 'summary'] },
  },
];

function clip(output: string): string {
  return output.length > MAX_TOOL_OUTPUT ? `${output.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated; ${output.length - MAX_TOOL_OUTPUT} more chars]` : output;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Normalize a model-supplied clarifying question into the richer schema.
 *
 * Motivation vs Logic: industry-standard agents ask MCQs with a rationale and labeled
 * options, not bare strings. We accept either `options:[{label,description}]` or legacy
 * `choices:string[]`, and always populate `choices` (option labels) so older renderers and
 * answer-parsing keep working.
 */
function parseClarifyingQuestion(entry: Record<string, unknown>, id: string): CodeSpaceClarifyingQuestion {
  const rawOptions = Array.isArray(entry.options) ? entry.options : [];
  const options = rawOptions
    .map((option) => {
      if (option && typeof option === 'object') {
        const record = option as Record<string, unknown>;
        const label = str(record.label) || str(record.value) || str(record.title);
        return label ? { label, description: str(record.description) || undefined } : null;
      }
      return typeof option === 'string' && option ? { label: option } : null;
    })
    .filter((option): option is { label: string; description?: string } => Boolean(option));

  const legacyChoices = Array.isArray(entry.choices)
    ? entry.choices.filter((choice): choice is string => typeof choice === 'string')
    : [];
  const choices = options.length ? options.map((option) => option.label) : legacyChoices;

  return {
    id,
    question: str(entry.question),
    choices,
    allowMultiple: entry.allowMultiple === true,
    rationale: str(entry.rationale) || undefined,
    options: options.length ? options : undefined,
  };
}

function formatEditDiagnostics(diagnostics: EditBlockDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => `- ${diagnostic.path} [${diagnostic.code}]${diagnostic.line ? ` line ${diagnostic.line}` : ''}: ${diagnostic.message}`)
    .join('\n');
}


function toEditFailureCode(code: EditBlockDiagnostic['code']): EditFailureCode | null {
  if (code === 'SEARCH_NOT_FOUND' || code === 'SEARCH_NOT_UNIQUE' || code === 'SYNTAX_ERROR') return code;
  return null;
}

export function recordEditFailures(ctx: CodeAgentContext, filePath: string, failures: EditFailure[]): void {
  if (!failures.length) return;
  const normalized = normalizeContextPath(filePath);
  const existing = ctx.editFailures.get(normalized) ?? [];
  ctx.editFailures.set(normalized, [...existing, ...failures]);
}

export function clearEditFailures(ctx: CodeAgentContext, filePath: string): void {
  ctx.editFailures.delete(normalizeContextPath(filePath));
}

export function formatUnresolvedEditFailures(ctx: CodeAgentContext): string {
  return Array.from(ctx.editFailures.entries())
    .filter(([path, failures]) => failures.length > 0 && !ctx.ledger.has(path) && !ctx.proposedFiles.has(path))
    .flatMap(([path, failures]) => failures.map((failure) => `- ${path} [${failure.code}]${failure.line ? ` line ${failure.line}` : ''}: ${failure.message}`))
    .join('\n');
}

export function buildEditEscalationDirective(ctx: CodeAgentContext): string {
  const detail = formatUnresolvedEditFailures(ctx);
  if (!detail) {
    return 'You returned without applying or proposing any edits. Re-read the target files, issue corrected edit_file calls, and do not call attempt_completion until at least one edit succeeds.';
  }
  return [
    'You attempted to finish without resolving recoverable edit_file failures. This is not allowed.',
    'Recoverable diagnostics MUST be retried — re-read the failing range and issue a smaller, corrected edit_file before attempt_completion.',
    '',
    detail,
    '',
    'After 2 failed retries on the same file: read_file the target range, replan with a smaller SEARCH, and retry edit_file.',
  ].join('\n');
}

function locateSearchAnchor(content: string, search: string): number | undefined {
  const lines = content.split('\n');
  const needle = search.split('\n').find((line) => line.trim())?.trim();
  if (!needle) return undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.includes(needle)) return index + 1;
  }
  return undefined;
}

function buildReadWindow(content: string, centerLine: number, radius = 12): { start: number; end: number; text: string } {
  const lines = content.split('\n');
  const safeCenter = Math.max(1, Math.min(centerLine, lines.length || 1));
  const start = Math.max(1, safeCenter - radius);
  const end = Math.min(lines.length || 1, safeCenter + radius);
  const numbered = lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`).join('\n');
  return { start, end, text: numbered };
}

function buildRepairProtocol(filePath: string): string {
  return [
    'Repair protocol:',
    '1. Use a smaller SEARCH that copies these lines exactly.',
    '2. Match existing indentation depth (Python: keep block-relative indent).',
    `3. Re-issue edit_file on ${filePath}. Do NOT call attempt_completion until this file's edit succeeds.`,
  ].join('\n');
}

function inferFailureCenterLine(
  content: string,
  failure: EditFailure,
  search?: string,
): number {
  if (failure.line) return failure.line;
  if (search && (failure.code === 'SEARCH_NOT_FOUND' || failure.code === 'SEARCH_NOT_UNIQUE')) {
    const anchor = locateSearchAnchor(content, search);
    if (anchor) return anchor;
  }
  const lines = content.split('\n');
  return Math.max(1, Math.ceil(lines.length / 2));
}

function buildEditFailureResponse(
  headline: string,
  diagnostics: EditBlockDiagnostic[],
  currentFiles: Record<string, string>,
  edits: EditBlock[],
): string {
  const detail = formatEditDiagnostics(diagnostics);
  const primary = diagnostics[0];
  if (!primary) return `${headline}\n${detail}`;

  const normalized = normalizeContextPath(primary.path);
  const content = currentFiles[normalized] ?? '';
  const relatedEdit = edits.find((edit) => normalizeContextPath(edit.path) === normalized);
  const failureCode = toEditFailureCode(primary.code) ?? 'SYNTAX_ERROR';
  const failure: EditFailure = {
    code: failureCode,
    message: primary.message,
    line: primary.line,
    at: Date.now(),
  };
  const center = inferFailureCenterLine(content, failure, relatedEdit?.search);
  const window = buildReadWindow(content, center);
  return clip([
    headline,
    detail,
    '',
    `Current state of ${normalized} around the failing region (lines ${window.start}-${window.end}):`,
    window.text,
    '',
    buildRepairProtocol(normalized),
  ].join('\n'));
}

export class ToolExecutor {
  constructor(
    registry: ToolRegistry = createDefaultToolRegistry(),
    private readonly permission = new PermissionManager(),
  ) {
    this.registry = registry;
  }
  private readonly registry: ToolRegistry;

  /** Execute one tool call against the workspace. Never throws for tool-level failures. */
  async execute(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    try {
      switch (call.name) {
        case 'read_file':
          return await this.readFile(call, ctx);
        case 'list_files':
          return await this.listFiles(call, ctx);
        case 'search_text':
          return await this.searchText(call, ctx);
        case 'repo_map':
          return await this.repoMap(ctx);
        case 'dependency_trace':
          return await this.dependencyTrace(call, ctx);
        case 'git_status':
          return await this.git(['status', '--short', '--branch'], ctx);
        case 'git_diff':
          return await this.git(['diff', ...(str(call.input.path) ? ['--', str(call.input.path)] : [])], ctx);
        case 'read_artifact':
          return await this.readArtifact(call, ctx);
        case 'grep_artifact':
          return await this.grepArtifactTool(call, ctx);
        case 'edit_file':
          return await this.editFile(call, ctx);
        case 'run_command':
          return await this.runCommand(call, ctx);
        case 'restore_checkpoint':
          return await this.restoreCheckpoint(call, ctx);
        case 'spawn_subagent':
          return await this.spawnSubagentTool(call, ctx);
        case 'ask_clarifying_questions':
          return this.askClarifyingQuestions(call, ctx);
        case 'write_plan_artifact':
          return this.writePlanArtifactTool(call, ctx);
        default:
          return { content: `Unknown tool "${call.name}". Use one of the provided tools.`, isError: true };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Tool ${call.name} failed: ${message}`, isError: true };
    }
  }

  private async readFile(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const target = str(call.input.path);
    if (!target) return { content: 'read_file requires "path".', isError: true };
    const normalized = normalizeContextPath(target);
    // Overlay: if this run already proposed (but did not write) changes to this file, serve the
    // pending proposed content so the model stacks subsequent edits onto its own latest proposal.
    const proposed = ctx.proposedLedger.get(normalized);
    const content = proposed ? proposed.afterContent : await safeReadTextFile(ctx.root, target);
    if (content == null) return { content: `File not found or unreadable: ${target}`, isError: true };
    ctx.readFiles.add(normalized);
    await ctx.emitRuntime('file.read', { path: target });
    const lines = content.split('\n');
    const start = typeof call.input.startLine === 'number' ? Math.max(1, Math.floor(call.input.startLine)) : 1;
    const end = typeof call.input.endLine === 'number' ? Math.min(lines.length, Math.floor(call.input.endLine)) : lines.length;
    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((line, index) => `${start + index}\t${line}`).join('\n');
    const header = proposed
      ? `${target} [pending proposed content — not yet written to disk] (lines ${start}-${end} of ${lines.length}):`
      : `${target} (lines ${start}-${end} of ${lines.length}):`;
    return { content: clip(`${header}\n${numbered}`) };
  }

  private async listFiles(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const rel = normalizeContextPath(str(call.input.path) || '.');
    const recursive = call.input.recursive === true;
    if (recursive) {
      const all = await listRepositoryFiles(ctx.root);
      const prefix = rel === '.' || rel === '' ? '' : `${rel}/`;
      const matches = all.filter((file) => !prefix || file.startsWith(prefix)).slice(0, 500);
      return { content: clip(matches.join('\n') || '(no files)') };
    }
    const dir = path.resolve(ctx.root, rel === '.' ? '' : rel);
    if (dir !== ctx.root && !dir.startsWith(`${ctx.root}${path.sep}`)) return { content: 'Path escapes workspace root.', isError: true };
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return { content: `Directory not found: ${rel}`, isError: true };
    const listing = entries
      .filter((entry) => !['node_modules', '.git', '.next', 'dist', 'build'].includes(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    return { content: clip(listing.join('\n') || '(empty)') };
  }

  private async searchText(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const query = str(call.input.query);
    if (!query) return { content: 'search_text requires "query".', isError: true };
    const glob = str(call.input.glob);
    const contextLines = typeof call.input.contextLines === 'number' ? Math.max(0, Math.min(6, Math.floor(call.input.contextLines))) : 1;
    let rx: RegExp;
    try {
      rx = new RegExp(query, 'i');
    } catch {
      rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const files = await listRepositoryFiles(ctx.root);
    const candidates = glob ? files.filter((file) => matchesGlob(file, glob)) : files;
    const blocks: string[] = [];
    let matchCount = 0;
    for (const file of candidates) {
      if (matchCount >= MAX_SEARCH_MATCHES) break;
      const content = await safeReadTextFile(ctx.root, file);
      if (content == null || content.length > MAX_SEARCH_FILE_BYTES) continue;
      const lines = content.split('\n');
      for (let index = 0; index < lines.length && matchCount < MAX_SEARCH_MATCHES; index += 1) {
        if (!rx.test(lines[index] ?? '')) continue;
        matchCount += 1;
        const from = Math.max(0, index - contextLines);
        const to = Math.min(lines.length, index + contextLines + 1);
        const snippet = lines.slice(from, to).map((line, offset) => `${from + offset + 1}: ${line}`).join('\n');
        blocks.push(`${file}:\n${snippet}`);
      }
    }
    await ctx.emitRuntime('tool.completed', { tool: 'search_text', matches: matchCount });
    return { content: clip(blocks.length ? `${matchCount} match(es):\n\n${blocks.join('\n\n')}` : `No matches for "${query}".`) };
  }

  private async repoMap(ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const files = await listRepositoryFiles(ctx.root);
    const topDirs = new Map<string, number>();
    const extensions = new Map<string, number>();
    for (const file of files) {
      const top = file.includes('/') ? `${file.split('/')[0]}/` : '(root)';
      topDirs.set(top, (topDirs.get(top) ?? 0) + 1);
      const ext = file.split('.').pop() ?? '';
      if (ext) extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
    }
    const fmt = (map: Map<string, number>) =>
      Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([key, count]) => `${key} (${count})`)
        .join(', ');
    let pkgInfo = 'none';
    const pkgRaw = await safeReadTextFile(ctx.root, 'package.json');
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string>; packageManager?: string };
        pkgInfo = `scripts: ${Object.keys(pkg.scripts ?? {}).join(', ') || '(none)'}; packageManager: ${pkg.packageManager ?? 'unknown'}`;
      } catch {
        pkgInfo = 'package.json present but unparseable';
      }
    }
    return {
      content: clip(
        [
          `Files: ${files.length}`,
          `Top directories: ${fmt(topDirs)}`,
          `Languages by extension: ${fmt(extensions)}`,
          `package.json: ${pkgInfo}`,
        ].join('\n'),
      ),
    };
  }

  private async dependencyTrace(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const paths = Array.isArray(call.input.paths) ? call.input.paths.filter((p): p is string => typeof p === 'string') : [];
    if (!paths.length) return { content: 'dependency_trace requires "paths".', isError: true };
    const candidates = await listRepositoryFiles(ctx.root);
    const trace = await traceDependencyEdges({ root: ctx.root, candidates, selected: paths });
    const edges = trace.edges.slice(0, 100).map((edge) => `${edge.reason}: ${edge.from} -> ${edge.to}`);
    return { content: clip(edges.length ? `Related files: ${Array.from(trace.files).join(', ')}\n\nEdges:\n${edges.join('\n')}` : 'No local dependency edges found for those paths.') };
  }

  private async git(args: string[], ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const command: TerminalCommand = { kind: 'explore', command: 'git', args, cwd: ctx.root, reason: 'Read git state for the agent.', timeoutMs: 30_000 };
    const result = await ctx.terminal.run(command, ctx.root, ctx.signal);
    return { content: clip(result.output || '(no output)'), isError: result.status === 'failed' };
  }

  private async readArtifact(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const artifact = ctx.artifacts.get(str(call.input.artifactId));
    if (!artifact) return { content: `Unknown artifactId: ${str(call.input.artifactId)}`, isError: true };
    const range = await readArtifactRange(artifact.path, Number(call.input.startLine) || 1, Number(call.input.endLine) || 80);
    return { content: clip(`${artifact.artifactId} (lines ${range.startLine}-${range.endLine} of ${range.lineCount}):\n${range.content}`) };
  }

  private async grepArtifactTool(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const artifact = ctx.artifacts.get(str(call.input.artifactId));
    if (!artifact) return { content: `Unknown artifactId: ${str(call.input.artifactId)}`, isError: true };
    const pattern = str(call.input.pattern);
    if (!pattern) return { content: 'grep_artifact requires "pattern".', isError: true };
    const result = await grepArtifact(artifact.path, pattern, typeof call.input.contextLines === 'number' ? call.input.contextLines : 3);
    const rendered = result.matches.map((match) => `L${match.line}: ${match.text}`).join('\n');
    return { content: clip(rendered || `No matches for "${pattern}" in ${artifact.artifactId}.`) };
  }

  private async editFile(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const rawEdits = Array.isArray(call.input.edits) ? call.input.edits : [];
    const edits: EditBlock[] = rawEdits
      .filter((edit): edit is Record<string, unknown> => Boolean(edit) && typeof edit === 'object')
      .map((edit) => ({
        path: str(edit.path),
        search: str(edit.search),
        replace: str(edit.replace),
        reason: str(edit.reason) || 'Code edit',
      }))
      .filter((edit) => edit.path);
    if (!edits.length) return { content: 'edit_file requires a non-empty "edits" array of {path, search, replace, reason}.', isError: true };

    // Build current content per file. Overlay: when this run already proposed (but did not write)
    // changes to a file, baseline new edits off the latest proposed content so sequential proposals
    // to the same file stack cumulatively instead of each baselining off the original disk.
    const uniquePaths = Array.from(new Set(edits.map((edit) => normalizeContextPath(edit.path))));
    const currentFiles: Record<string, string> = {};
    const existedBefore: Record<string, boolean> = {};
    for (const filePath of uniquePaths) {
      const proposed = ctx.proposedLedger.get(filePath);
      if (proposed) {
        currentFiles[filePath] = proposed.afterContent;
        existedBefore[filePath] = true;
        continue;
      }
      const disk = await safeReadTextFile(ctx.root, filePath);
      currentFiles[filePath] = disk ?? '';
      existedBefore[filePath] = disk != null;
    }

    const grouped = applyGroupedEditBlocks(currentFiles, edits, { existingFiles: existedBefore });
    if (!grouped.ok) {
      for (const diagnostic of grouped.diagnostics) {
        const code = toEditFailureCode(diagnostic.code);
        if (!code) continue;
        recordEditFailures(ctx, diagnostic.path, [{
          code,
          message: diagnostic.message,
          line: diagnostic.line,
          at: Date.now(),
        }]);
      }
      return {
        content: buildEditFailureResponse('edit_file could not apply cleanly. Fix and retry:', grouped.diagnostics, currentFiles, edits),
        isError: true,
      };
    }

    // Root Cause vs Logic: suggest_only used to emit diff_proposed without the same syntax gate as
    // applyPatchFiles, so users hit AST_PREVALIDATION_FAILED on accept. Validate every preview here
    // (auto-apply and propose paths) before surfacing or writing.
    const syntaxDiagnostics = grouped.previews.flatMap((preview) => validateSyntaxLightweight(preview.path, preview.afterContent));
    if (syntaxDiagnostics.length) {
      for (const diagnostic of syntaxDiagnostics) {
        recordEditFailures(ctx, diagnostic.path, [{
          code: 'SYNTAX_ERROR',
          message: diagnostic.message,
          line: diagnostic.line,
          at: Date.now(),
        }]);
      }
      return {
        content: buildEditFailureResponse(
          'edit_file rejected: proposed content failed syntax pre-validation. Re-read the file, fix indentation/structure, and retry:',
          syntaxDiagnostics,
          Object.fromEntries(grouped.previews.map((preview) => [normalizeContextPath(preview.path), preview.beforeContent])),
          edits,
        ),
        isError: true,
      };
    }

    const decision = this.decide('propose_edit_blocks', ctx.autonomy);
    const applyToDisk = decision.permission === 'auto';

    const applied: string[] = [];
    for (const preview of grouped.previews) {
      const normalized = normalizeContextPath(preview.path);
      // The verifier/test-writer may always write ephemeral test scripts under .agent/tests/, even
      // under suggest_only — they are throwaway artifacts, never user source files.
      const writeThisFile = applyToDisk || normalized.startsWith('.agent/tests/');
      if (!writeThisFile) {
        // suggest_only / approval_required → propose, do not write. Keep one cumulative proposal per
        // file: baseline against the true disk original (the first proposal's beforeContent), and
        // record the latest cumulative afterContent. The stable diffId lets the UI replace the prior
        // card instead of stacking, so applying it sends original→cumulative and never conflicts.
        const existing = ctx.proposedLedger.get(normalized);
        const originalBefore = existing ? existing.beforeContent : preview.beforeContent;
        const originalExisted = existing ? existing.existedBefore : preview.beforeExists;
        const cumulativeDiff = createUnifiedDiff(normalized, originalBefore, preview.afterContent);
        await ctx.emit({
          type: 'diff_proposed',
          diffId: `patch:${ctx.runId}:${normalized}`,
          filePath: normalized,
          oldContent: originalBefore,
          newContent: preview.afterContent,
          explanation: preview.explanation,
          unifiedDiff: cumulativeDiff,
          autoApplied: false,
        });
        ctx.proposedFiles.add(normalized);
        ctx.proposedLedger.set(normalized, { beforeContent: originalBefore, afterContent: preview.afterContent, existedBefore: originalExisted });
        clearEditFailures(ctx, normalized);
        if (decision.approvalRequired) await ctx.emitRuntime('tool.approval.required', { tool: 'edit_file', path: normalized, reason: decision.reason });
        continue;
      }

      try {
        const result = await applyPatchFiles({
          root: ctx.root,
          projectId: ctx.projectId,
          runId: ctx.runId,
          patchId: `patch:${ctx.runId}:${normalized}`,
          files: [{ path: normalized, beforeContent: preview.beforeContent, afterContent: preview.afterContent, existedBefore: preview.beforeExists }],
        });
        if (result.checkpoint) {
          ctx.checkpoints.push(result.checkpoint);
          await ctx.onCheckpoint?.(result.checkpoint);
          await ctx.emitRuntime('checkpoint.created', { checkpointId: result.checkpoint.id, files: result.checkpoint.files.map((file) => file.path) });
        }
      } catch (error) {
        if (error instanceof PatchApplyError) {
          if (error.code === 'AST_PREVALIDATION_FAILED') {
            const details = error.details as { diagnostics?: EditBlockDiagnostic[] } | undefined;
            const patchDiagnostics = details?.diagnostics ?? [];
            for (const diagnostic of patchDiagnostics) {
              recordEditFailures(ctx, diagnostic.path || normalized, [{
                code: 'AST_PREVALIDATION_FAILED',
                message: diagnostic.message,
                line: diagnostic.line,
                at: Date.now(),
              }]);
            }
            if (patchDiagnostics.length) {
              return {
                content: buildEditFailureResponse(
                  `edit_file write rejected for ${normalized} [${error.code}]: ${error.message} Re-read the file and regenerate the edit.`,
                  patchDiagnostics,
                  currentFiles,
                  edits,
                ),
                isError: true,
              };
            }
          }
          recordEditFailures(ctx, normalized, [{
            code: 'AST_PREVALIDATION_FAILED',
            message: error.message,
            at: Date.now(),
          }]);
          return { content: `edit_file write rejected for ${normalized} [${error.code}]: ${error.message}. Re-read the file and regenerate the edit.`, isError: true };
        }
        throw error;
      }

      clearEditFailures(ctx, normalized);

      const existing = ctx.ledger.get(normalized);
      const original = existing ? existing.beforeContent : preview.beforeContent;
      ctx.ledger.set(normalized, { beforeContent: original, afterContent: preview.afterContent, deleted: false, existedBefore: existing ? existing.existedBefore : preview.beforeExists });
      applied.push(normalized);
      await ctx.emit({ type: 'file_applied', filePath: normalized, beforeContent: original, afterContent: preview.afterContent, explanation: preview.explanation, unifiedDiff: preview.unifiedDiff, hash: hashContent(preview.afterContent) });
      await ctx.emitRuntime(existedBefore[normalized] ? 'file.updated' : 'file.created', { path: normalized });
    }

    if (!applied.length) {
      return { content: `Proposed ${grouped.previews.length} edit(s) for review (autonomy "${ctx.autonomy}" does not auto-apply). Not written to disk.` };
    }
    const diffSummary = grouped.previews.map((preview) => preview.unifiedDiff).join('\n');
    return { content: clip(`Applied edits to: ${applied.join(', ')}\n\n${diffSummary}`) };
  }

  private async runCommand(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const commandName = str(call.input.command);
    if (!commandName) return { content: 'run_command requires "command".', isError: true };
    const args = Array.isArray(call.input.args) ? call.input.args.filter((a): a is string => typeof a === 'string') : [];
    const command: TerminalCommand = {
      kind: 'shell',
      command: commandName,
      args,
      cwd: str(call.input.cwd) ? path.resolve(ctx.root, str(call.input.cwd)) : ctx.root,
      reason: str(call.input.reason) || 'Agent-requested command.',
      timeoutMs: typeof call.input.timeoutMs === 'number' ? call.input.timeoutMs : 120_000,
    };

    const decision = this.decide('run_command', ctx.autonomy);
    if (decision.permission !== 'auto') {
      await ctx.emitRuntime('tool.approval.required', { tool: 'run_command', command: `${commandName} ${args.join(' ')}`, reason: decision.reason });
      return { content: `Command not run: autonomy "${ctx.autonomy}" requires approval for "${commandName}". ${decision.reason}`, isError: true };
    }
    if (isRiskyTerminalCommand(command)) {
      return { content: `Command "${commandName} ${args.join(' ')}" is gated by terminal policy and requires explicit approval. It was not run.`, isError: true };
    }

    const result = await ctx.terminal.run(command, ctx.root, ctx.signal);
    const artifact = await writeAgentArtifact({ projectRoot: ctx.root, runId: ctx.runId, kind: 'terminal_log', content: result.output, summary: `${result.command}: ${result.status}` });
    ctx.artifacts.set(artifact.artifactId, artifact);
    const preview = result.output.length > MAX_TOOL_OUTPUT ? `${result.output.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated; read full output via read_artifact id=${artifact.artifactId}]` : result.output;
    return { content: `[${result.status}] ${result.command}\nartifactId: ${artifact.artifactId}\n\n${preview || '(no output)'}`, isError: result.status === 'failed' };
  }

  private async restoreCheckpoint(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const ref = str(call.input.checkpointRef);
    const checkpoint = ctx.checkpoints.find((entry) => entry.id === ref);
    if (!checkpoint) return { content: `Unknown checkpointRef: ${ref}`, isError: true };
    const decision = this.decide('restore_checkpoint', ctx.autonomy);
    if (decision.permission !== 'auto') {
      await ctx.emitRuntime('tool.approval.required', { tool: 'restore_checkpoint', checkpointRef: ref, reason: decision.reason });
      return { content: `Checkpoint restore requires approval under autonomy "${ctx.autonomy}".`, isError: true };
    }
    const loaded = await loadFileCheckpoint(checkpoint.snapshotRef);
    const files = await restoreFileCheckpoint(ctx.root, loaded);
    for (const file of files) {
      const normalized = normalizeContextPath(file);
      const snapshot = loaded.files.find((entry) => normalizeContextPath(entry.path) === normalized);
      const existing = ctx.ledger.get(normalized);
      if (existing) {
        // Roll the ledger's "latest" back to this checkpoint's snapshot content.
        ctx.ledger.set(normalized, { ...existing, afterContent: snapshot?.content ?? existing.beforeContent, deleted: snapshot ? !snapshot.existed : existing.deleted });
      }
      await ctx.emit({ type: 'file_applied', filePath: normalized, beforeContent: existing?.beforeContent ?? '', afterContent: snapshot?.content ?? '', explanation: `Restored from checkpoint ${ref}`, unifiedDiff: '', hash: hashContent(snapshot?.content ?? '') });
    }
    await ctx.emitRuntime('checkpoint.restored', { checkpointId: ref, files });
    return { content: `Restored ${files.length} file(s) from ${ref}: ${files.join(', ')}` };
  }

  /** Code-mode: delegate a subtask to an isolated subagent (wired by the runtime). */
  private async spawnSubagentTool(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    if (!ctx.spawnSubagent) return { content: 'Subagent spawning is not available in this run.', isError: true };
    const role = str(call.input.role);
    const task = str(call.input.task);
    if (!role || !task) return { content: 'spawn_subagent requires "role" and "task".', isError: true };
    const allowedTools = Array.isArray(call.input.allowedTools)
      ? call.input.allowedTools.filter((tool): tool is string => typeof tool === 'string')
      : undefined;
    const result = await ctx.spawnSubagent({
      role,
      task,
      readOnly: call.input.readOnly === true ? true : undefined,
      maxToolCalls: typeof call.input.maxToolCalls === 'number' ? call.input.maxToolCalls : undefined,
      allowedTools,
    });
    return { content: clip(`[subagent:${result.role}] ${result.success ? 'completed' : 'incomplete'} (${result.toolCalls} turns)\n${result.summary}`), isError: !result.success };
  }

  /** Plan-mode terminal tool: record up to 6 clarifying questions (rationale + labeled options) and pause. */
  private askClarifyingQuestions(call: ToolCall, ctx: CodeAgentContext): ToolExecutionResult {
    const raw = Array.isArray(call.input.questions) ? call.input.questions : [];
    const questions: CodeSpaceClarifyingQuestion[] = raw
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .slice(0, 6)
      .map((entry, index) => parseClarifyingQuestion(entry, `clarify:${ctx.runId}:${index}`))
      .filter((entry) => entry.question && entry.choices.length >= 2);
    if (!questions.length) {
      return {
        content:
          'ask_clarifying_questions requires a non-empty "questions" array. Each item needs {question, rationale, options:[{label,description}]} with at least 2 options so the user can pick.',
        isError: true,
      };
    }
    ctx.planClarification = { questions };
    return { content: `Recorded ${questions.length} clarifying question(s). Stop now — the run will pause for the user to answer.` };
  }

  /** Plan-mode terminal tool: validate and record the model-authored plan artifact. */
  private writePlanArtifactTool(call: ToolCall, ctx: CodeAgentContext): ToolExecutionResult {
    const planMarkdown = str(call.input.planMarkdown);
    if (!planMarkdown.trim()) return { content: 'write_plan_artifact requires non-empty "planMarkdown".', isError: true };
    if (!planContainsRequiredSections(planMarkdown)) {
      const missing = REQUIRED_PLAN_SECTIONS.filter((section) => !planMarkdown.includes(`## ${section}`));
      return {
        content: `Plan artifact is missing required sections: ${missing.join(', ')}. Add every required "## <section>" heading (grounded in the evidence you read) and call write_plan_artifact again.`,
        isError: true,
      };
    }
    const inspectedFiles = Array.isArray(call.input.inspectedFiles)
      ? call.input.inspectedFiles.filter((file): file is string => typeof file === 'string')
      : [];
    ctx.planArtifactRequest = {
      planMarkdown,
      summary: str(call.input.summary) || 'Implementation plan ready.',
      inspectedFiles,
      status: call.input.status === 'needs_review' ? 'needs_review' : 'ready',
    };
    return { content: 'Plan artifact recorded. Stop now — do not call any more tools.' };
  }

  private decide(registryToolName: string, autonomy: AutonomyLevel) {
    const tool = this.registry.get(registryToolName);
    if (!tool) return { permission: 'auto' as const, approvalRequired: false, reason: 'Unregistered tool defaults to auto.' };
    return this.permission.decide(tool, autonomy);
  }
}

/** Build a run-level checkpoint capturing every touched file's original content. */
export async function createRunRevertCheckpoint(ctx: CodeAgentContext): Promise<FileCheckpoint | null> {
  if (!ctx.ledger.size) return null;
  const snapshots = Array.from(ctx.ledger.entries()).map(([filePath, entry]) => ({
    path: filePath,
    content: entry.existedBefore ? entry.beforeContent : null,
    existed: entry.existedBefore,
  }));
  return createCheckpointFromSnapshots({
    projectId: ctx.projectId,
    projectRoot: ctx.root,
    runId: ctx.runId,
    reason: `Revert all Code-mode changes for ${ctx.runId}`,
    snapshots,
  });
}

function matchesGlob(file: string, glob: string): boolean {
  // Minimal glob: supports **, *, and literal segments. Anchored to full path.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(file) || new RegExp(escaped).test(file);
  } catch {
    return file.includes(glob.replace(/\*/g, ''));
  }
}

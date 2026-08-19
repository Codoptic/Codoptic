import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AutonomyLevel } from '@/lib/code-space/domain';
import type { CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';
import type { ImplementationContract, PatchHistoryEntry } from '@/lib/code-space/core';
import type { ToolCall, ToolSpec } from '@/lib/agent/providers';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import {
  applyGroupedEditBlocks,
  createUnifiedDiff,
  validateSyntaxLightweight,
  type EditBlock,
  type EditBlockDiagnostic,
} from '@/lib/code-space/agent/editBlocks';
import { writeAgentArtifact, readArtifactRange, grepArtifact, type AgentArtifact, type AgentArtifactKind } from '@/lib/code-space/agent/artifacts';
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
import {
  formatAutonomyBlockedToolMessage,
  isAutonomyPolicyFailureRecoverable,
  isSuggestOnlySelectiveWritePath,
} from './autonomyPolicy';
import { createDefaultToolRegistry, ToolRegistry } from './toolRegistry';
import { TerminalRunner } from './terminalRunner';
import { isRiskyTerminalCommand, type TerminalCommand } from './terminalPolicy';
import {
  createPtySession,
  disposePtySession,
  readPtySession,
  signalPtySession,
  waitForPtySession,
  writePtySession,
} from './ptySessionManager';
import { traceDependencyEdges } from './dependencyTrace';
import { listRepositoryFiles, normalizeContextPath, safeReadTextFile } from './repoMap';
import { hashContent } from './patchReview';
import { addPatchCoverage } from './implementationContract';
import { MemoryManager, normalizeMemoryPath } from './memoryManager';
import { BrowserController } from './browserController';
import type { ContextLedger } from './contextLedger';
import type { RuntimeScaleProfile } from './scaleProfile';
import { readSkillBody } from './skills';
import { assertPersistableWorkPackage } from './workGraphPolicy';
import { buildAdvisorPacket } from './roleRouting';
import { parseLintOutput } from './lintService';
import { invokeMcpTool, parseMcpToolName } from './mcpRuntime';
import { startBackgroundJob, appendJobOutput, completeJob, matchNotifyPattern } from './backgroundJobs';
import { evaluateUserHook } from './userHooks';
import { loadMcpConfig } from './mcpRuntime';

export interface LedgerEntry {
  beforeContent: string;
  afterContent: string;
  deleted: boolean;
  existedBefore: boolean;
}

export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
  /** Failed validation/test/lint commands are feedback for the agent, not terminal user errors. */
  recoverable?: boolean;
  command?: string;
  artifactId?: string;
  parked?: boolean;
}

export interface RecoverableToolFailure {
  tool: string;
  command: string;
  artifactId?: string;
  output: string;
  at: number;
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
  /** Immutable per-edit history for Cursor-like live patch cards. */
  patchHistory?: PatchHistoryEntry[];
  /** Requirement coverage ledger for build-from-plan and large implementation runs. */
  implementationContract?: ImplementationContract;
  /** Paths proposed (but NOT written) under suggest_only autonomy — pending user accept/reject. */
  proposedFiles: Set<string>;
  /** Directories intentionally created without tracked file content during this run. */
  createdDirectories?: Set<string>;
  /** Latest proposed before/after per path (suggest_only); used for final pre-completion validation. */
  proposedLedger: Map<string, Pick<LedgerEntry, 'beforeContent' | 'afterContent' | 'existedBefore'>>;
  /** Recoverable edit_file failures per path — cleared when a working edit lands. */
  editFailures: Map<string, EditFailure[]>;
  /** Recoverable failed validation/terminal commands that must be fixed and re-run before completion. */
  recoverableFailures?: Map<string, RecoverableToolFailure>;
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
  /** Durable memory update proposals captured during this run; never written directly. */
  memoryUpdateProposals?: Array<{ path: string; content: string; reason: string }>;
  contextLedger?: ContextLedger;
  scaleProfile?: RuntimeScaleProfile;
  browser?: BrowserController;
  registry: ToolRegistry;
  permission: PermissionManager;
  terminal: TerminalRunner;
  onCheckpoint?: CheckpointSink;
  signal?: AbortSignal;
  todoBoard?: import('./todoBoard').TodoBoard;
  readHashes?: Map<string, string>;
  permissionMode?: 'ask' | 'plan' | 'code';
  persistWorkGraph?: (packages: import('./agentOrchestrator').WorkPackage[]) => Promise<string>;
  writeAllowlist?: string[];
  frozenTestRoots?: string[];
  spendMeter?: import('./spendMeter').SpendMeter;
  onBeforeCompact?: () => Promise<void>;
  userHooks?: import('./userHooks').UserHooksConfig;
  planSnapshotHash?: string;
}

const MAX_TOOL_OUTPUT = 6000;
const MAX_SEARCH_FILE_BYTES = 200_000;
const MAX_SEARCH_MATCHES = 80;

/** Tool specs advertised to the model for Code mode. */
export const CODE_MODE_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace. Defaults to a 100-line window. Pass startLine/endLine to page. Always read a file before editing it.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'] },
  },
  {
    name: 'list_files',
    description: 'List files and folders under a workspace directory (default: repo root). Set recursive=true to list the full subtree.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } } },
  },
  {
    name: 'search_text',
    description: 'Search the workspace. Default mode=files returns matching paths only. Set mode=content for snippets. Prefer ripgrep when available.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, glob: { type: 'string' }, contextLines: { type: 'number' }, mode: { type: 'string' } }, required: ['query'] },
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
    name: 'research_web',
    description: 'Fetch and summarize current web pages or GitHub repository metadata for up-to-date docs, best practices, and OSS research. Use only when current external context is useful.',
    inputSchema: {
      type: 'object',
      properties: {
        queries: { type: 'array', items: { type: 'string' } },
        urls: { type: 'array', items: { type: 'string' } },
        githubRepo: { type: 'string' },
        useBrowser: { type: 'boolean' },
        maxResults: { type: 'number' },
        maxChars: { type: 'number' },
      },
    },
  },
  {
    name: 'harness_context',
    description: 'Audit AGENTS.md/context files, pack repo context with Repomix if installed, or fetch library docs with Context7 if installed. Use before large unfamiliar changes or API-heavy work.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        library: { type: 'string' },
        query: { type: 'string' },
        maxChars: { type: 'number' },
      },
    },
  },
  {
    name: 'scan_code_quality',
    description: 'Run optional quality scanners via Semgrep, ast-grep, jscpd/cpd, and Gitleaks when installed. Missing tools return install hints.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        pattern: { type: 'string' },
        lang: { type: 'string' },
        maxChars: { type: 'number' },
      },
    },
  },
  {
    name: 'run_validation_matrix',
    description: 'Detect and run stack-specific validation commands across Node, Python, Go, and Rust. Use after edits, or dryRun=true to inspect what would run.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        changedPaths: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean' },
        timeoutMs: { type: 'number' },
      },
    },
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
    name: 'list_memories',
    description: 'List durable project memory files under /memories. These store user preferences, project context, research notes, and decisions across conversations.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_memory',
    description: 'Read one durable project memory file from /memories.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'propose_memory_update',
    description: 'Propose a durable memory update. This records an approval-gated proposal and never writes memory files directly.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'content', 'reason'] },
  },
  {
    name: 'edit_file',
    description: 'Apply exact SEARCH/REPLACE edit blocks to existing files on disk. Each edit\'s "search" must match current file content exactly and uniquely. The server checkpoints, conflict-checks, syntax-validates, and writes. Returns diffs or actionable diagnostics to fix and retry. Prefer create_files for new files and scratch-project scaffolds.',
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
    name: 'create_files',
    description: 'Create one or more missing text files, including parent directories, through the same checkpointed diff pipeline as edit_file. Fails if any target file already exists. Use this for new files, scaffolds, and projects built from scratch.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } },
            required: ['path', 'content', 'reason'],
          },
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'create_directory',
    description: 'Create an intentionally empty directory. By default trackInGit=true creates <path>/.gitkeep through the reviewable patch pipeline; trackInGit=false creates only the local directory and records it in the run ledger.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, reason: { type: 'string' }, trackInGit: { type: 'boolean' } },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a workspace command (tests, typecheck, build, lint, grep, ls, etc.) and capture output. Destructive or network-mutating commands are gated and require approval.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, reason: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command', 'reason'] },
  },
  { name: 'terminal_start', description: 'Start an interactive PTY terminal session in the workspace.', inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' } } } },
  { name: 'terminal_write', description: 'Write stdin bytes to an interactive terminal session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, data: { type: 'string' } }, required: ['sessionId', 'data'] } },
  { name: 'terminal_read', description: 'Read buffered output from an interactive terminal session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, maxChars: { type: 'number' }, clear: { type: 'boolean' } }, required: ['sessionId'] } },
  { name: 'terminal_wait', description: 'Wait for an interactive terminal session to exit or match a regex pattern.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, pattern: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['sessionId'] } },
  { name: 'terminal_signal', description: 'Send SIGINT, SIGTERM, or SIGKILL to an interactive terminal session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, signal: { type: 'string' } }, required: ['sessionId'] } },
  { name: 'terminal_close', description: 'Close an interactive terminal session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
  { name: 'browser_preview_check', description: 'Open a Playwright browser preview, collect console/network output, and capture a screenshot artifact.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, scenario: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['url', 'scenario'] } },
  { name: 'browser_open', description: 'Open a Playwright browser session for a URL and capture a screenshot.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['url'] } },
  { name: 'browser_click', description: 'Click an element in a browser session by selector.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, selector: { type: 'string' } }, required: ['sessionId', 'selector'] } },
  { name: 'browser_type', description: 'Fill an input element in a browser session by selector.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' } }, required: ['sessionId', 'selector', 'text'] } },
  { name: 'browser_scroll', description: 'Scroll a browser session by pixel delta.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['sessionId'] } },
  { name: 'browser_screenshot', description: 'Capture and persist a screenshot artifact from a browser session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, label: { type: 'string' } }, required: ['sessionId'] } },
  { name: 'browser_eval', description: 'Evaluate a bounded JavaScript expression in the page context.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, expression: { type: 'string' } }, required: ['sessionId', 'expression'] } },
  { name: 'browser_console', description: 'Read collected console messages and network errors from a browser session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
  { name: 'browser_close', description: 'Close a browser session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
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
    description: 'Signal that the task is finished. For success=true, first compare the final diff and validation against the complete original request, then set completedOriginalRequest=true. Set success=false if you could not complete it; never fabricate a result. Provide a concise summary of what changed (or why it could not be done).',
    inputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        summary: { type: 'string' },
        completedOriginalRequest: { type: 'boolean', description: 'Required true when success=true after checking the final diff against the complete original user request.' },
      },
      required: ['success', 'summary'],
    },
  },
  {
    name: 'todo_write',
    description: 'Create or replace the live TODO list for this run. Own the task breakdown; update as work progresses.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, text: { type: 'string' }, done: { type: 'boolean' } },
            required: ['text'],
          },
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'todo_update',
    description: 'Mark a live TODO done or rewrite its text.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, done: { type: 'boolean' } }, required: ['id'] },
  },
  {
    name: 'read_skill',
    description: 'Load the full body of a skill from the catalog before applying it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'propose_work_graph',
    description: 'Propose a model-authored work ledger. Each package must have dependencies or independent=true.',
    inputSchema: {
      type: 'object',
      properties: {
        packages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              role: { type: 'string' },
              title: { type: 'string' },
              task: { type: 'string' },
              independent: { type: 'boolean' },
              dependencies: { type: 'array', items: { type: 'string' } },
              readOnly: { type: 'boolean' },
            },
            required: ['role', 'task'],
          },
        },
      },
      required: ['packages'],
    },
  },
  {
    name: 'consult_advisor',
    description: 'Ask a stronger model for advice using a bounded packet (goal, recent tools, failing tests). Not the full transcript.',
    inputSchema: { type: 'object', properties: { goal: { type: 'string' }, recentTools: { type: 'array', items: { type: 'string' } }, failingTests: { type: 'array', items: { type: 'string' } } }, required: ['goal'] },
  },
  {
    name: 'read_lints',
    description: 'Parse lint/typecheck output into diagnostics for recently edited files.',
    inputSchema: { type: 'object', properties: { output: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'git_commit',
    description: 'Create a git commit from the current diff using a HEREDOC-style message. Never skip hooks or force-push.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request with gh after status/diff/log. High risk; approval gated.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] },
  },
  {
    name: 'exit_plan_mode',
    description: 'Leave plan permission mode on the same thread so implementation tools become available.',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
  },
];

export const ASK_MODE_TOOL_SPECS: ToolSpec[] = CODE_MODE_TOOL_SPECS.filter((spec) =>
  ['read_file', 'list_files', 'search_text', 'repo_map', 'dependency_trace', 'git_status', 'git_diff', 'read_memory', 'list_memories', 'read_skill', 'todo_write', 'todo_update', 'attempt_completion'].includes(spec.name),
);

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
    .filter(([path, failures]) => failures.length > 0 && !path.startsWith('.agent/tests/') && !ctx.ledger.has(path) && !ctx.proposedFiles.has(path))
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

function buildRepairProtocol(filePath: string, allowFullFileFallback = false): string {
  const steps = [
    'Repair protocol:',
    '1. Use a smaller SEARCH that copies these lines exactly.',
    '2. Match existing indentation depth (Python: keep block-relative indent).',
    `3. Re-issue edit_file on ${filePath}. Do NOT call attempt_completion until this file's edit succeeds.`,
  ];
  if (allowFullFileFallback) {
    steps.push('4. Repeated exact-match failures detected: you may replace the entire current file content as SEARCH and the complete corrected file as REPLACE.');
  }
  return steps.join('\n');
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
  repeatedFailureCount = 0,
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
    buildRepairProtocol(normalized, repeatedFailureCount >= 2 && (failureCode === 'SEARCH_NOT_FOUND' || failureCode === 'SEARCH_NOT_UNIQUE')),
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
        case 'research_web':
          return await this.researchWeb(call, ctx);
        case 'harness_context':
          return await this.harnessContext(call, ctx);
        case 'scan_code_quality':
          return await this.scanCodeQuality(call, ctx);
        case 'run_validation_matrix':
          return await this.runValidationMatrix(call, ctx);
        case 'read_artifact':
          return await this.readArtifact(call, ctx);
        case 'grep_artifact':
          return await this.grepArtifactTool(call, ctx);
        case 'list_memories':
          return await this.listMemories(ctx);
        case 'read_memory':
          return await this.readMemory(call, ctx);
        case 'propose_memory_update':
          return await this.proposeMemoryUpdate(call, ctx);
        case 'edit_file':
          return await this.editFile(call, ctx);
        case 'create_files':
          return await this.createFiles(call, ctx);
        case 'create_directory':
          return await this.createDirectory(call, ctx);
        case 'run_command':
          return await this.runCommand(call, ctx);
        case 'terminal_start':
          return await this.terminalStart(call, ctx);
        case 'terminal_write':
          return await this.terminalWrite(call, ctx);
        case 'terminal_read':
          return await this.terminalRead(call, ctx);
        case 'terminal_wait':
          return await this.terminalWait(call, ctx);
        case 'terminal_signal':
          return await this.terminalSignal(call, ctx);
        case 'terminal_close':
          return await this.terminalClose(call, ctx);
        case 'browser_preview_check':
        case 'browser_open':
          return await this.browserOpen(call, ctx);
        case 'browser_click':
          return await this.browserClick(call, ctx);
        case 'browser_type':
          return await this.browserType(call, ctx);
        case 'browser_scroll':
          return await this.browserScroll(call, ctx);
        case 'browser_screenshot':
          return await this.browserScreenshot(call, ctx);
        case 'browser_eval':
          return await this.browserEval(call, ctx);
        case 'browser_console':
          return await this.browserConsole(call, ctx);
        case 'browser_close':
          return await this.browserClose(call, ctx);
        case 'restore_checkpoint':
          return await this.restoreCheckpoint(call, ctx);
        case 'spawn_subagent':
          return await this.spawnSubagentTool(call, ctx);
        case 'ask_clarifying_questions':
          return this.askClarifyingQuestions(call, ctx);
        case 'write_plan_artifact':
          return this.writePlanArtifactTool(call, ctx);
        case 'todo_write':
          return this.todoWrite(call, ctx);
        case 'todo_update':
          return this.todoUpdate(call, ctx);
        case 'read_skill':
          return this.readSkill(call);
        case 'propose_work_graph':
          return this.proposeWorkGraph(call, ctx);
        case 'consult_advisor':
          return this.consultAdvisor(call);
        case 'read_lints':
          return this.readLints(call, ctx);
        case 'git_commit':
          return await this.gitCommit(call, ctx);
        case 'create_pull_request':
          return await this.createPullRequest(call, ctx);
        case 'exit_plan_mode':
          ctx.permissionMode = 'code';
          return { content: 'Plan permission released. Implementation tools are now available on this thread.' };
        case 'tool_search':
          return this.toolSearch(call);
        default:
          if (call.name.startsWith('mcp__')) return this.invokeMcp(call, ctx);
          return { content: `Unknown tool "${call.name}". Use one of the provided tools.`, isError: true, recoverable: true };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Tool ${call.name} failed: ${message}`, isError: true, recoverable: true };
    }
  }

  private async readFile(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const target = str(call.input.path);
    if (!target) return { content: 'read_file requires "path".', isError: true, recoverable: true };
    const normalized = normalizeContextPath(target);
    // Overlay: if this run already proposed (but did not write) changes to this file, serve the
    // pending proposed content so the model stacks subsequent edits onto its own latest proposal.
    const proposed = ctx.proposedLedger.get(normalized);
    const content = proposed ? proposed.afterContent : await safeReadTextFile(ctx.root, target);
    if (content == null) return { content: `File not found or unreadable: ${target}`, isError: true, recoverable: true };
    ctx.readFiles.add(normalized);
    await ctx.emitRuntime('file.read', { path: target });
    const lines = content.split('\n');
    ctx.contextLedger?.add({ kind: 'file_read', path: normalized, summary: `Read ${normalized} (${lines.length} lines)`, status: 'completed' });
    const start = typeof call.input.startLine === 'number' ? Math.max(1, Math.floor(call.input.startLine)) : 1;
    const defaultEnd = Math.min(lines.length, start + 99);
    const end = typeof call.input.endLine === 'number' ? Math.min(lines.length, Math.floor(call.input.endLine)) : defaultEnd;
    ctx.readHashes ??= new Map();
    ctx.readHashes.set(normalized, hashContent(content));
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
    if (dir !== ctx.root && !dir.startsWith(`${ctx.root}${path.sep}`)) return { content: 'Path escapes workspace root.', isError: true, recoverable: true };
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return { content: `Directory not found: ${rel}`, isError: true, recoverable: true };
    const listing = entries
      .filter((entry) => !['node_modules', '.git', '.next', 'dist', 'build'].includes(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    return { content: clip(listing.join('\n') || '(empty)') };
  }

  private async searchText(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const query = str(call.input.query);
    if (!query) return { content: 'search_text requires "query".', isError: true, recoverable: true };
    const glob = str(call.input.glob);
    const mode = str(call.input.mode) === 'content' ? 'content' : 'files';
    const rg = await this.searchWithRipgrep(ctx.root, query, glob, mode);
    if (rg) return { content: clip(rg) };
    const contextLines = typeof call.input.contextLines === 'number' ? Math.max(0, Math.min(6, Math.floor(call.input.contextLines))) : 1;
    let rx: RegExp;
    try {
      rx = new RegExp(query, 'i');
    } catch {
      rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const files = await listRepositoryFiles(ctx.root);
    const candidates = glob ? files.filter((file) => matchesGlob(file, glob)) : files;
    const fileHits = new Map<string, number>();
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
        fileHits.set(file, (fileHits.get(file) ?? 0) + 1);
        if (mode === 'files') continue;
        const from = Math.max(0, index - contextLines);
        const to = Math.min(lines.length, index + contextLines + 1);
        const snippet = lines.slice(from, to).map((line, offset) => `${from + offset + 1}: ${line}`).join('\n');
        blocks.push(`${file}:\n${snippet}`);
      }
    }
    if (mode === 'files') {
      const listing = [...fileHits.entries()].map(([file, count]) => `${file} (${count})`).join('\n');
      return { content: listing || `No matches for "${query}".` };
    }
    await ctx.emitRuntime('tool.completed', { tool: 'search_text', matches: matchCount });
    const rendered = blocks.length ? `${matchCount} match(es):\n\n${blocks.join('\n\n')}` : `No matches for "${query}".`;
    if (rendered.length > MAX_TOOL_OUTPUT) {
      const artifact = await writeAgentArtifact({
        projectRoot: ctx.root,
        runId: ctx.runId,
        kind: 'grep_result',
        content: rendered,
        summary: `search_text ${query}: ${matchCount} match(es)`,
      });
      ctx.artifacts.set(artifact.artifactId, artifact);
      return {
        content: `${rendered.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated; read full search output via read_artifact id=${artifact.artifactId} or grep_artifact]`,
      };
    }
    return { content: rendered };
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
    if (!paths.length) return { content: 'dependency_trace requires "paths".', isError: true, recoverable: true };
    const candidates = await listRepositoryFiles(ctx.root);
    const trace = await traceDependencyEdges({ root: ctx.root, candidates, selected: paths });
    const edges = trace.edges.slice(0, 100).map((edge) => `${edge.reason}: ${edge.from} -> ${edge.to}`);
    return { content: clip(edges.length ? `Related files: ${Array.from(trace.files).join(', ')}\n\nEdges:\n${edges.join('\n')}` : 'No local dependency edges found for those paths.') };
  }

  private async git(args: string[], ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const probe: TerminalCommand = { kind: 'explore', command: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd: ctx.root, reason: 'Check whether the workspace is git-managed.', timeoutMs: 30_000 };
    const probeResult = await ctx.terminal.run(probe, ctx.root, ctx.signal);
    if (probeResult.status === 'failed' || !/\btrue\b/i.test(probeResult.output)) {
      return { content: 'Workspace is not git-managed; using Code Space change ledger for diffs.' };
    }

    const command: TerminalCommand = { kind: 'explore', command: 'git', args, cwd: ctx.root, reason: 'Read git state for the agent.', timeoutMs: 30_000 };
    const result = await ctx.terminal.runStreaming(
      command,
      ctx.root,
      async (chunk) => {
        await ctx.emit({ type: 'terminal_chunk', chunk: chunk.chunk, stream: chunk.stream, command: chunk.command });
        await ctx.emitRuntime('terminal.output', { command: chunk.command, stream: chunk.stream, chunk: chunk.chunk });
      },
      ctx.signal,
    );
    return { content: clip(result.output || '(no output)'), isError: result.status === 'failed' };
  }

  private toolScript(...segments: string[]): string {
    return path.join(process.cwd(), 'tools', ...segments);
  }

  private async runToolScript(
    ctx: CodeAgentContext,
    registryToolName: string,
    command: TerminalCommand,
    artifactKind: AgentArtifactKind,
  ): Promise<ToolExecutionResult> {
    const decision = this.decide(registryToolName, ctx.autonomy);
    if (decision.permission === 'blocked') {
      return {
        content: formatAutonomyBlockedToolMessage(registryToolName, ctx.autonomy, decision.reason),
        isError: true,
        recoverable: isAutonomyPolicyFailureRecoverable(ctx.autonomy, decision.permission),
      };
    }
    if (decision.permission === 'approval_required') {
      const parked = await this.parkApproval(
        { id: `script:${ctx.runId}:${registryToolName}`, name: registryToolName, input: { command: command.command, args: command.args } },
        ctx,
        registryToolName,
        decision.reason,
      );
      if (parked) return parked;
    }
    const result = await ctx.terminal.run(command, ctx.root, ctx.signal);
    const artifact = await writeAgentArtifact({
      projectRoot: ctx.root,
      runId: ctx.runId,
      kind: artifactKind,
      content: result.output,
      summary: `${registryToolName}: ${result.status}`,
    });
    ctx.artifacts.set(artifact.artifactId, artifact);
    const preview = result.output.length > MAX_TOOL_OUTPUT
      ? `${result.output.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated; read full output via read_artifact id=${artifact.artifactId}]`
      : result.output;
    return {
      content: `[${result.status}] ${result.command}\nartifactId: ${artifact.artifactId}\n\n${preview || '(no output)'}`,
      isError: result.status === 'failed',
      recoverable: registryToolName === 'run_validation_matrix' && result.status === 'failed',
      command: result.command,
      artifactId: artifact.artifactId,
    };
  }

  private async researchWeb(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const queries = Array.isArray(call.input.queries) ? call.input.queries.filter((query): query is string => typeof query === 'string' && query.trim().length > 0).slice(0, 4) : [];
    const urls = Array.isArray(call.input.urls) ? call.input.urls.filter((url): url is string => typeof url === 'string' && url.trim().length > 0).slice(0, 4) : [];
    const githubRepo = str(call.input.githubRepo);
    if (!queries.length && !urls.length && !githubRepo) return { content: 'research_web requires at least one query, URL, or githubRepo.', isError: true, recoverable: true };
    const args = [this.toolScript('researcher', 'research.py')];
    for (const query of queries) args.push('--query', query);
    for (const url of urls) args.push('--url', url);
    if (githubRepo) args.push('--github-repo', githubRepo);
    if (call.input.useBrowser === true) args.push('--browser');
    if (typeof call.input.maxResults === 'number') args.push('--max-results', String(Math.max(1, Math.min(8, Math.floor(call.input.maxResults)))));
    if (typeof call.input.maxChars === 'number') args.push('--max-chars', String(Math.max(1000, Math.min(20_000, Math.floor(call.input.maxChars)))));
    return this.runToolScript(ctx, 'research_web', { kind: 'explore', command: 'python3', args, cwd: ctx.root, reason: 'Gather current external research for the agent.', timeoutMs: 90_000 }, 'docs_page');
  }

  private async harnessContext(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const mode = ['audit', 'pack', 'docs'].includes(str(call.input.mode)) ? str(call.input.mode) : 'audit';
    const args = [this.toolScript('context-harness', 'harness.py'), '--root', ctx.root, '--mode', mode];
    if (str(call.input.library)) args.push('--library', str(call.input.library));
    if (str(call.input.query)) args.push('--query', str(call.input.query));
    if (typeof call.input.maxChars === 'number') args.push('--max-chars', String(Math.max(1000, Math.min(30_000, Math.floor(call.input.maxChars)))));
    return this.runToolScript(ctx, 'harness_context', { kind: 'explore', command: 'python3', args, cwd: ctx.root, reason: 'Gather repository or documentation context for the agent.', timeoutMs: 120_000 }, 'docs_page');
  }

  private async scanCodeQuality(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const mode = ['all', 'semgrep', 'ast-grep', 'duplication', 'secrets'].includes(str(call.input.mode)) ? str(call.input.mode) : 'all';
    const args = [this.toolScript('quality-scan', 'scan.py'), '--root', ctx.root, '--mode', mode];
    if (str(call.input.pattern)) args.push('--pattern', str(call.input.pattern));
    if (str(call.input.lang)) args.push('--lang', str(call.input.lang));
    if (typeof call.input.maxChars === 'number') args.push('--max-chars', String(Math.max(1000, Math.min(30_000, Math.floor(call.input.maxChars)))));
    return this.runToolScript(ctx, 'scan_code_quality', { kind: 'lint', command: 'python3', args, cwd: ctx.root, reason: 'Run optional quality scanners for the agent.', timeoutMs: 180_000 }, 'terminal_log');
  }

  private async runValidationMatrix(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const scope = ['all', 'node', 'python', 'go', 'rust'].includes(str(call.input.scope)) ? str(call.input.scope) : 'all';
    const args = [this.toolScript('validation-matrix', 'validate.py'), '--root', ctx.root, '--scope', scope];
    const changedPaths = Array.isArray(call.input.changedPaths) ? call.input.changedPaths.filter((item): item is string => typeof item === 'string') : [];
    for (const changedPath of changedPaths.slice(0, 20)) args.push('--changed-path', changedPath);
    if (call.input.dryRun === true) args.push('--dry-run');
    if (typeof call.input.timeoutMs === 'number') args.push('--timeout', String(Math.max(10, Math.min(600, Math.floor(call.input.timeoutMs / 1000 || call.input.timeoutMs)))));
    return this.runToolScript(ctx, 'run_validation_matrix', { kind: 'test', command: 'python3', args, cwd: ctx.root, reason: 'Run detected validation commands.', timeoutMs: 240_000 }, 'terminal_log');
  }

  private async readArtifact(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const artifact = ctx.artifacts.get(str(call.input.artifactId));
    if (!artifact) return { content: `Unknown artifactId: ${str(call.input.artifactId)}`, isError: true, recoverable: true };
    const range = await readArtifactRange(artifact.path, Number(call.input.startLine) || 1, Number(call.input.endLine) || 80);
    return { content: clip(`${artifact.artifactId} (lines ${range.startLine}-${range.endLine} of ${range.lineCount}):\n${range.content}`) };
  }

  private async grepArtifactTool(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const artifact = ctx.artifacts.get(str(call.input.artifactId));
    if (!artifact) return { content: `Unknown artifactId: ${str(call.input.artifactId)}`, isError: true, recoverable: true };
    const pattern = str(call.input.pattern);
    if (!pattern) return { content: 'grep_artifact requires "pattern".', isError: true, recoverable: true };
    const result = await grepArtifact(artifact.path, pattern, typeof call.input.contextLines === 'number' ? call.input.contextLines : 3);
    const rendered = result.matches.map((match) => `L${match.line}: ${match.text}`).join('\n');
    return { content: clip(rendered || `No matches for "${pattern}" in ${artifact.artifactId}.`) };
  }

  private async listMemories(ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const memories = await new MemoryManager().list(ctx.root);
    return { content: memories.length ? memories.join('\n') : 'No project memories found under /memories.' };
  }

  private async readMemory(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const normalized = normalizeMemoryPath(str(call.input.path));
    if (!normalized) return { content: 'read_memory requires a path under /memories with extension .md, .txt, or .json.', isError: true, recoverable: true };
    const entry = await new MemoryManager().read(ctx.root, normalized);
    if (!entry) return { content: `Memory not found or unreadable: ${normalized}`, isError: true, recoverable: true };
    await ctx.emitRuntime('memory.read', { path: entry.path });
    return { content: clip(`--- MEMORY ${entry.path} (${entry.title}) ---\n${entry.content}${entry.truncated ? '\n[TRUNCATED]' : ''}`) };
  }

  private async proposeMemoryUpdate(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const normalized = normalizeMemoryPath(str(call.input.path));
    const content = str(call.input.content).trim();
    const reason = str(call.input.reason).trim();
    if (!normalized) return { content: 'propose_memory_update requires a path under /memories with extension .md, .txt, or .json.', isError: true, recoverable: true };
    if (!content) return { content: 'propose_memory_update requires non-empty content.', isError: true, recoverable: true };
    ctx.memoryUpdateProposals ??= [];
    ctx.memoryUpdateProposals.push({ path: normalized, content, reason });
    await ctx.emitRuntime('memory.update.proposed', { path: normalized, reason });
    return { content: `Proposed memory update for ${normalized}. No files were written; the parent/user approval gate must apply it later.` };
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
    if (!edits.length) return { content: 'edit_file requires a non-empty "edits" array of {path, search, replace, reason}.', isError: true, recoverable: true };

    // Build current content per file. Overlay: when this run already proposed (but did not write)
    // changes to a file, baseline new edits off the latest proposed content so sequential proposals
    // to the same file stack cumulatively instead of each baselining off the original disk.
    const uniquePaths = Array.from(new Set(edits.map((edit) => normalizeContextPath(edit.path))));
    const currentFiles: Record<string, string> = {};
    const existedBefore: Record<string, boolean> = {};
    for (const filePath of uniquePaths) {
      if (ctx.frozenTestRoots?.some((rootPath) => filePath.startsWith(rootPath)) && !ctx.writeAllowlist?.some((allowed) => filePath.startsWith(allowed))) {
        return { content: `Frozen test path ${filePath} cannot be edited by the implementer. Amend the spec instead.`, isError: true, recoverable: true };
      }
      if (ctx.writeAllowlist?.length && !ctx.writeAllowlist.some((allowed) => filePath.startsWith(allowed))) {
        return { content: `Write allowlist rejected ${filePath}.`, isError: true, recoverable: true };
      }
      const proposed = ctx.proposedLedger.get(filePath);
      if (proposed) {
        currentFiles[filePath] = proposed.afterContent;
        existedBefore[filePath] = true;
        continue;
      }
      const disk = await safeReadTextFile(ctx.root, filePath);
      currentFiles[filePath] = disk ?? '';
      existedBefore[filePath] = disk != null;
      try {
        const { assertFreshHash } = await import('./fileFreshness');
        assertFreshHash(ctx.readHashes?.get(filePath), hashContent(disk ?? ''), filePath);
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true, recoverable: true };
      }
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
      const primaryPath = normalizeContextPath(grouped.diagnostics[0]?.path ?? '');
      const repeatedFailureCount = primaryPath ? (ctx.editFailures.get(primaryPath)?.length ?? 0) : 0;
      return {
        content: buildEditFailureResponse('edit_file could not apply cleanly. Fix and retry:', grouped.diagnostics, currentFiles, edits, repeatedFailureCount),
        isError: true,
        recoverable: true,
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
        recoverable: true,
      };
    }

    const decision = this.decide('edit_file', ctx.autonomy);
    let applyToDisk = decision.permission === 'auto';
    if (!applyToDisk && decision.approvalRequired && ctx.autonomy !== 'suggest_only') {
      const parked = await this.parkApproval(call, ctx, 'edit_file', decision.reason);
      if (parked) return parked;
      applyToDisk = true;
    }

    const applied: string[] = [];
    for (const preview of grouped.previews) {
      const normalized = normalizeContextPath(preview.path);
      const stats = diffStats(preview.unifiedDiff);
      const patch = createPatchHistoryEntry(ctx, {
        filePath: normalized,
        mode: writeThisMode(applyToDisk, normalized),
        status: applyToDisk || isSuggestOnlySelectiveWritePath(normalized) ? 'applied' : 'pending',
        diff: preview.unifiedDiff,
        explanation: preview.explanation,
        added: stats.added,
        removed: stats.removed,
        hunks: stats.hunks,
      });
      // The verifier/test-writer may always write ephemeral test scripts under .agent/tests/, even
      // under suggest_only — they are throwaway artifacts, never user source files.
      const writeThisFile = applyToDisk || isSuggestOnlySelectiveWritePath(normalized);
      if (!writeThisFile) {
        await recordPatchHistory(ctx, patch);
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
          patchId: patch.patchId,
          batchId: patch.batchId,
          filePath: normalized,
          oldContent: originalBefore,
          newContent: preview.afterContent,
          explanation: preview.explanation,
          unifiedDiff: cumulativeDiff,
          autoApplied: false,
          added: stats.added,
          removed: stats.removed,
          hunks: stats.hunks,
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
      await recordPatchHistory(ctx, patch);
      await ctx.emit({
        type: 'file_applied',
        filePath: normalized,
        beforeContent: original,
        afterContent: preview.afterContent,
        explanation: preview.explanation,
        unifiedDiff: preview.unifiedDiff,
        hash: hashContent(preview.afterContent),
        patchId: patch.patchId,
        batchId: patch.batchId,
        added: patch.added,
        removed: patch.removed,
        hunks: patch.hunks,
      });
      await ctx.emitRuntime(existedBefore[normalized] ? 'file.updated' : 'file.created', { path: normalized });
      await ctx.emit({ type: 'lint_errors', filePath: normalized, errors: parseLintOutput(preview.afterContent, normalized) });
    }

    if (!applied.length) {
      return { content: `Proposed ${grouped.previews.length} edit(s) for review (autonomy "${ctx.autonomy}" does not auto-apply source files). Not written to disk — use read_file to see pending proposed content.` };
    }
    const windows = grouped.previews
      .filter((preview) => applied.includes(normalizeContextPath(preview.path)))
      .map((preview) => windowAroundChange(preview.path, preview.afterContent, preview.beforeContent));
    return { content: clip(`Applied edits to: ${applied.join(', ')}\n\n${windows.join('\n\n')}`) };
  }

  private async createFiles(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const rawFiles = Array.isArray(call.input.files) ? call.input.files : [];
    const files = rawFiles
      .filter((file): file is Record<string, unknown> => Boolean(file) && typeof file === 'object')
      .map((file) => ({
        path: normalizeContextPath(str(file.path)),
        content: str(file.content),
        reason: str(file.reason) || 'Create file',
      }))
      .filter((file) => file.path);
    if (!files.length) return { content: 'create_files requires a non-empty "files" array of {path, content, reason}.', isError: true, recoverable: true };

    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file.path)) return { content: `create_files received duplicate path: ${file.path}`, isError: true, recoverable: true };
      seen.add(file.path);
      if (ctx.proposedLedger.has(file.path) || (await safeReadTextFile(ctx.root, file.path)) != null) {
        return { content: `create_files refused to overwrite existing file: ${file.path}. Use edit_file for existing files.`, isError: true, recoverable: true };
      }
    }

    return this.editFile(
      {
        ...call,
        name: 'edit_file',
        input: {
          edits: files.map((file) => ({
            path: file.path,
            search: '',
            replace: file.content,
            reason: file.reason,
          })),
        },
      },
      ctx,
    );
  }

  private async createDirectory(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const target = normalizeContextPath(str(call.input.path));
    if (!target || target === '.') return { content: 'create_directory requires a non-root workspace-relative path.', isError: true, recoverable: true };
    const trackInGit = call.input.trackInGit !== false;
    const reason = str(call.input.reason) || 'Create directory';
    if (trackInGit) {
      return this.createFiles(
        {
          ...call,
          name: 'create_files',
          input: { files: [{ path: `${target}/.gitkeep`, content: '', reason: `${reason} (track directory in git)` }] },
        },
        ctx,
      );
    }

    const decision = this.decide('create_directory', ctx.autonomy);
    if (decision.permission === 'blocked') {
      return {
        content: formatAutonomyBlockedToolMessage('create_directory', ctx.autonomy, decision.reason),
        isError: true,
        recoverable: isAutonomyPolicyFailureRecoverable(ctx.autonomy, decision.permission),
      };
    }
    if (decision.permission === 'approval_required') {
      const parked = await this.parkApproval(call, ctx, 'create_directory', decision.reason);
      if (parked) return parked;
    }

    const dir = path.resolve(ctx.root, target);
    if (dir !== ctx.root && !dir.startsWith(`${ctx.root}${path.sep}`)) {
      return { content: 'create_directory path escapes workspace root.', isError: true, recoverable: true };
    }
    await fs.mkdir(dir, { recursive: true });
    ctx.createdDirectories ??= new Set<string>();
    ctx.createdDirectories.add(target);
    await ctx.emitRuntime('directory.created', { path: target, trackedInGit: false });
    return { content: `Created untracked directory: ${target}` };
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
    if (decision.permission === 'blocked') {
      return {
        content: formatAutonomyBlockedToolMessage('run_command', ctx.autonomy, decision.reason),
        isError: true,
        recoverable: isAutonomyPolicyFailureRecoverable(ctx.autonomy, decision.permission),
      };
    }
    if (decision.permission === 'approval_required') {
      const parked = await this.parkApproval(call, ctx, 'run_command', decision.reason);
      if (parked) return parked;
    }
    if (ctx.autonomy !== 'full_access_local' && isRiskyTerminalCommand(command)) {
      return { content: `Command "${commandName} ${args.join(' ')}" is gated by terminal policy and requires explicit approval. It was not run.`, isError: true };
    }

    if (call.input.background === true) {
      const job = startBackgroundJob([commandName, ...args].join(' '));
      const notify = str(call.input.notifyOnOutput);
      void ctx.terminal.runStreaming(command, ctx.root, (chunk) => {
        const next = appendJobOutput(job.jobId, chunk.chunk);
        if (next && matchNotifyPattern(next.output, notify)) {
          void ctx.emitRuntime('job.notify', { jobId: job.jobId, command: next.command });
        }
      }, ctx.signal, { allowRisky: ctx.autonomy === 'full_access_local' }).then(() => {
        completeJob(job.jobId);
      });
      return { content: `Started background job ${job.jobId}. Notify pattern: ${notify || '(none)'}.` };
    }

    const result = await ctx.terminal.run(command, ctx.root, ctx.signal, { allowRisky: ctx.autonomy === 'full_access_local' });
    const artifact = await writeAgentArtifact({ projectRoot: ctx.root, runId: ctx.runId, kind: 'terminal_log', content: result.output, summary: `${result.command}: ${result.status}` });
    ctx.artifacts.set(artifact.artifactId, artifact);
    ctx.contextLedger?.addArtifact('terminal', artifact, `${result.command}: ${result.status}`);
    const preview = result.output.length > MAX_TOOL_OUTPUT ? `${result.output.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated; read full output via read_artifact id=${artifact.artifactId}]` : result.output;
    return {
      content: `[${result.status}] ${result.command}\nartifactId: ${artifact.artifactId}\n\n${preview || 'Command succeeded with no output (exit 0).'}`,
      isError: result.status === 'failed',
      recoverable: result.status === 'failed' && isValidationLikeCommand(result.command, result.output),
      command: result.command,
      artifactId: artifact.artifactId,
    };
  }

  private async ensureTerminalDecision(toolName: string, ctx: CodeAgentContext, call?: ToolCall): Promise<ToolExecutionResult | null> {
    const decision = this.decide(toolName, ctx.autonomy);
    if (decision.permission === 'auto') return null;
    if (call && decision.permission === 'approval_required') return this.parkApproval(call, ctx, toolName, decision.reason);
    return {
      content: formatAutonomyBlockedToolMessage(toolName, ctx.autonomy, decision.reason),
      isError: true,
      recoverable: isAutonomyPolicyFailureRecoverable(ctx.autonomy, decision.permission),
    };
  }

  private async terminalStart(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const gated = await this.ensureTerminalDecision('terminal_start', ctx, call);
    if (gated) return gated;
    const cwdInput = str(call.input.cwd);
    const cwd = cwdInput ? path.resolve(ctx.root, cwdInput) : ctx.root;
    if (cwd !== ctx.root && !cwd.startsWith(`${ctx.root}${path.sep}`) && ctx.autonomy !== 'full_access_local') {
      return { content: 'terminal_start cwd escapes workspace root; use full_access_local for trusted broader access.', isError: true };
    }
    const session = createPtySession(cwd, Number(call.input.cols) || 100, Number(call.input.rows) || 30);
    await ctx.emitRuntime('terminal.started', { sessionId: session.id, cwd, shell: session.pty.process });
    ctx.contextLedger?.add({ kind: 'terminal', summary: `Started PTY session ${session.id}`, status: 'pending' });
    return { content: `Started terminal session ${session.id} (${session.pty.process}) in ${cwd}. Use terminal_write, terminal_read, terminal_wait, terminal_signal, and terminal_close.` };
  }

  private async terminalWrite(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const gated = await this.ensureTerminalDecision('terminal_write', ctx, call);
    if (gated) return gated;
    const sessionId = str(call.input.sessionId);
    const data = str(call.input.data);
    if (!writePtySession(sessionId, data)) return { content: `Unknown terminal session: ${sessionId}`, isError: true, recoverable: true };
    await ctx.emitRuntime('terminal.output', { sessionId, stream: 'stdin', chunk: data });
    return { content: `Wrote ${data.length} byte(s) to ${sessionId}.` };
  }

  private async terminalRead(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const sessionId = str(call.input.sessionId);
    const snapshot = readPtySession(sessionId, Number(call.input.maxChars) || MAX_TOOL_OUTPUT, call.input.clear === true);
    if (!snapshot) return { content: `Unknown terminal session: ${sessionId}`, isError: true, recoverable: true };
    const artifact = await writeAgentArtifact({ projectRoot: ctx.root, runId: ctx.runId, kind: 'terminal_log', content: snapshot.output, summary: `PTY ${sessionId}: ${snapshot.exited ? 'exited' : 'running'}` });
    ctx.artifacts.set(artifact.artifactId, artifact);
    ctx.contextLedger?.addArtifact('terminal', artifact);
    return { content: clip(`sessionId: ${sessionId}\nstatus: ${snapshot.exited ? `exited (${snapshot.exitCode ?? 'unknown'})` : 'running'}\nartifactId: ${artifact.artifactId}\n\n${snapshot.output || '(no output yet)'}`) };
  }

  private async terminalWait(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const sessionId = str(call.input.sessionId);
    const snapshot = await waitForPtySession(sessionId, {
      pattern: str(call.input.pattern) || undefined,
      timeoutMs: typeof call.input.timeoutMs === 'number' ? Math.max(250, Math.min(600_000, call.input.timeoutMs)) : 30_000,
    });
    if (!snapshot) return { content: `Unknown terminal session: ${sessionId}`, isError: true, recoverable: true };
    const artifact = await writeAgentArtifact({ projectRoot: ctx.root, runId: ctx.runId, kind: 'terminal_log', content: snapshot.output, summary: `PTY wait ${sessionId}: ${snapshot.matched ? 'matched' : snapshot.exited ? 'exited' : 'timeout'}` });
    ctx.artifacts.set(artifact.artifactId, artifact);
    ctx.contextLedger?.addArtifact('terminal', artifact);
    return { content: clip(`sessionId: ${sessionId}\nmatched: ${snapshot.matched}\nexited: ${snapshot.exited}\nexitCode: ${snapshot.exitCode ?? 'n/a'}\nartifactId: ${artifact.artifactId}\n\n${snapshot.output || '(no output)'}`), isError: !snapshot.matched && !snapshot.exited, recoverable: true };
  }

  private async terminalSignal(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const gated = await this.ensureTerminalDecision('terminal_signal', ctx, call);
    if (gated) return gated;
    const sessionId = str(call.input.sessionId);
    const signal = ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(str(call.input.signal)) ? (str(call.input.signal) as 'SIGINT' | 'SIGTERM' | 'SIGKILL') : 'SIGTERM';
    if (!signalPtySession(sessionId, signal)) return { content: `Unknown terminal session: ${sessionId}`, isError: true, recoverable: true };
    return { content: `Sent ${signal} to ${sessionId}.` };
  }

  private async terminalClose(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const sessionId = str(call.input.sessionId);
    disposePtySession(sessionId);
    await ctx.emitRuntime('terminal.exited', { sessionId, closedByAgent: true });
    return { content: `Closed terminal session ${sessionId}.` };
  }

  private browser(ctx: CodeAgentContext): BrowserController {
    if (!ctx.browser) ctx.browser = new BrowserController();
    return ctx.browser;
  }

  private browserDecision(toolName: string, ctx: CodeAgentContext): ToolExecutionResult | null {
    const decision = this.decide(toolName, ctx.autonomy);
    if (decision.permission !== 'auto') return { content: `${toolName} requires approval under autonomy "${ctx.autonomy}". ${decision.reason}`, isError: true };
    return null;
  }

  private async browserOpen(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const toolName = call.name === 'browser_preview_check' ? 'browser_preview_check' : 'browser_open';
    const gated = this.browserDecision(toolName, ctx);
    if (gated) return gated;
    const url = str(call.input.url);
    if (!url) return { content: `${toolName} requires url.`, isError: true, recoverable: true };
    await ctx.emitRuntime('browser.preview.started', { url, scenario: str(call.input.scenario) });
    const snapshot = await this.browser(ctx).open({
      root: ctx.root,
      runId: ctx.runId,
      url,
      viewport: {
        width: Number(call.input.width) || 1440,
        height: Number(call.input.height) || 1000,
      },
    });
    if (snapshot.screenshotArtifact) {
      ctx.artifacts.set(snapshot.screenshotArtifact.artifactId, snapshot.screenshotArtifact);
      ctx.contextLedger?.addArtifact('browser', snapshot.screenshotArtifact);
      await ctx.emitRuntime('browser.screenshot.created', { artifact: snapshot.screenshotArtifact, url: snapshot.url, title: snapshot.title });
    }
    return { content: this.formatBrowserSnapshot(snapshot) };
  }

  private async browserClick(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const gated = this.browserDecision('browser_click', ctx);
    if (gated) return gated;
    const snapshot = await this.browser(ctx).click(str(call.input.sessionId), str(call.input.selector));
    return snapshot ? { content: this.formatBrowserSnapshot(snapshot) } : { content: `Unknown browser session: ${str(call.input.sessionId)}`, isError: true, recoverable: true };
  }

  private async browserType(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const gated = this.browserDecision('browser_type', ctx);
    if (gated) return gated;
    const snapshot = await this.browser(ctx).type(str(call.input.sessionId), str(call.input.selector), str(call.input.text));
    return snapshot ? { content: this.formatBrowserSnapshot(snapshot) } : { content: `Unknown browser session: ${str(call.input.sessionId)}`, isError: true, recoverable: true };
  }

  private async browserScroll(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const gated = this.browserDecision('browser_scroll', ctx);
    if (gated) return gated;
    const snapshot = await this.browser(ctx).scroll(str(call.input.sessionId), Number(call.input.x) || 0, Number(call.input.y) || 600);
    return snapshot ? { content: this.formatBrowserSnapshot(snapshot) } : { content: `Unknown browser session: ${str(call.input.sessionId)}`, isError: true, recoverable: true };
  }

  private async browserScreenshot(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const gated = this.browserDecision('browser_screenshot', ctx);
    if (gated) return gated;
    const snapshot = await this.browser(ctx).screenshot(ctx.root, ctx.runId, str(call.input.sessionId), str(call.input.label) || 'screenshot');
    if (!snapshot) return { content: `Unknown browser session: ${str(call.input.sessionId)}`, isError: true, recoverable: true };
    if (snapshot.screenshotArtifact) {
      ctx.artifacts.set(snapshot.screenshotArtifact.artifactId, snapshot.screenshotArtifact);
      ctx.contextLedger?.addArtifact('browser', snapshot.screenshotArtifact);
      await ctx.emitRuntime('browser.screenshot.created', { artifact: snapshot.screenshotArtifact, url: snapshot.url, title: snapshot.title });
    }
    return { content: this.formatBrowserSnapshot(snapshot) };
  }

  private async browserEval(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const gated = this.browserDecision('browser_eval', ctx);
    if (gated) return gated;
    const output = await this.browser(ctx).eval(str(call.input.sessionId), str(call.input.expression));
    return output == null ? { content: `Unknown browser session: ${str(call.input.sessionId)}`, isError: true, recoverable: true } : { content: clip(output) };
  }

  private async browserConsole(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const snapshot = this.browser(ctx).console(str(call.input.sessionId));
    if (!snapshot) return { content: `Unknown browser session: ${str(call.input.sessionId)}`, isError: true, recoverable: true };
    for (const message of snapshot.consoleMessages.slice(-20)) await ctx.emitRuntime('browser.console.message', { message });
    for (const message of snapshot.networkErrors.slice(-20)) await ctx.emitRuntime('browser.network.error', { message });
    return { content: clip(formatBrowserDiagnostics(snapshot.consoleMessages, snapshot.networkErrors)) };
  }

  private async browserClose(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const ok = await this.browser(ctx).close(str(call.input.sessionId));
    return ok ? { content: `Closed browser session ${str(call.input.sessionId)}.` } : { content: `Unknown browser session: ${str(call.input.sessionId)}`, isError: true, recoverable: true };
  }

  private formatBrowserSnapshot(snapshot: { sessionId: string; url: string; title: string; consoleMessages: string[]; networkErrors: string[]; screenshotArtifact?: AgentArtifact }): string {
    return clip([
      `browserSessionId: ${snapshot.sessionId}`,
      `title: ${snapshot.title || '(untitled)'}`,
      `url: ${snapshot.url}`,
      snapshot.screenshotArtifact ? `screenshotArtifactId: ${snapshot.screenshotArtifact.artifactId}` : '',
      formatBrowserDiagnostics(snapshot.consoleMessages, snapshot.networkErrors),
    ].filter(Boolean).join('\n'));
  }

  private async restoreCheckpoint(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const ref = str(call.input.checkpointRef);
    const checkpoint = ctx.checkpoints.find((entry) => entry.id === ref);
    if (!checkpoint) return { content: `Unknown checkpointRef: ${ref}`, isError: true };
    const decision = this.decide('restore_checkpoint', ctx.autonomy);
    if (decision.permission === 'blocked') {
      return {
        content: formatAutonomyBlockedToolMessage('restore_checkpoint', ctx.autonomy, decision.reason),
        isError: true,
        recoverable: isAutonomyPolicyFailureRecoverable(ctx.autonomy, decision.permission),
      };
    }
    if (decision.permission === 'approval_required') {
      const parked = await this.parkApproval(call, ctx, 'restore_checkpoint', decision.reason);
      if (parked) return parked;
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

  private async parkApproval(call: ToolCall, ctx: CodeAgentContext, name: string, reason: string): Promise<ToolExecutionResult | null> {
    const { parkToolCall, waitForApproval } = await import('./pendingToolApproval');
    parkToolCall({
      toolCallId: call.id,
      runId: ctx.runId,
      name,
      input: call.input as Record<string, unknown>,
      createdAt: Date.now(),
    });
    await ctx.emitRuntime('tool.parked', { toolCallId: call.id, tool: name, reason });
    await ctx.emitRuntime('tool.approval.required', { tool: name, reason, toolCallId: call.id });
    const verdict = await waitForApproval(call.id, ctx.signal);
    if (verdict !== 'approved') return { content: `User rejected ${name}.`, isError: true, recoverable: true };
    return null;
  }

  private todoWrite(call: ToolCall, ctx: CodeAgentContext): ToolExecutionResult {
    const todos = Array.isArray(call.input.todos) ? call.input.todos : [];
    const written = ctx.todoBoard?.write(
      todos
        .filter((item): item is { text: string; id?: string; done?: boolean } => Boolean(item && typeof item === 'object' && 'text' in item))
        .map((item) => ({ id: typeof item.id === 'string' ? item.id : undefined, text: String(item.text), done: Boolean(item.done) })),
    ) ?? [];
    for (const todo of written) {
      void ctx.emit({ type: 'todo_created', todo: { id: todo.id, text: todo.text, done: todo.done } });
    }
    return { content: ctx.todoBoard?.format() || 'todo_write requires a live todo board.' };
  }

  private todoUpdate(call: ToolCall, ctx: CodeAgentContext): ToolExecutionResult {
    const updated = ctx.todoBoard?.update(str(call.input.id), { text: str(call.input.text) || undefined, done: typeof call.input.done === 'boolean' ? call.input.done : undefined });
    if (!updated) return { content: `Unknown todo ${str(call.input.id)}`, isError: true, recoverable: true };
    void ctx.emit({ type: 'todo_updated', todoId: updated.id, done: updated.done });
    return { content: ctx.todoBoard?.format() || updated.text };
  }

  private readSkill(call: ToolCall): ToolExecutionResult {
    const body = readSkillBody(str(call.input.id));
    return body ? { content: body } : { content: `Unknown skill ${str(call.input.id)}`, isError: true, recoverable: true };
  }

  private async proposeWorkGraph(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const packages = Array.isArray(call.input.packages) ? call.input.packages : [];
    try {
      for (const [index, raw] of packages.entries()) {
        const pkg = raw as { id?: string; role?: string; task?: string; independent?: boolean; dependencies?: string[] };
        assertPersistableWorkPackage({
          id: pkg.id || `work:${ctx.runId}:${index + 1}`,
          role: (pkg.role || 'explorer') as import('./subagentRunner').SubagentRole,
          title: pkg.task || 'package',
          task: pkg.task || '',
          readOnly: true,
          maxToolCalls: 20,
          dependencies: pkg.dependencies ?? [],
          independent: pkg.independent,
          depth: 0,
          reason: 'model-authored',
        });
      }
      const graphPackages = packages.map((raw, index) => {
        const pkg = raw as { id?: string; role?: string; task?: string; independent?: boolean; dependencies?: string[] };
        return {
          id: pkg.id || `work:${ctx.runId}:${index + 1}`,
          role: (pkg.role || 'explorer') as import('./subagentRunner').SubagentRole,
          title: pkg.task || 'package',
          task: pkg.task || '',
          readOnly: true,
          maxToolCalls: 20,
          dependencies: pkg.dependencies ?? [],
          independent: pkg.independent,
          depth: 0,
          reason: 'model-authored',
        };
      });
      const persisted = ctx.persistWorkGraph ? await ctx.persistWorkGraph(graphPackages) : `${packages.length} package(s) accepted in-memory`;
      return { content: `Accepted ${packages.length} model-authored work package(s). ${persisted}` };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true, recoverable: true };
    }
  }

  private consultAdvisor(call: ToolCall): ToolExecutionResult {
    return {
      content: buildAdvisorPacket({
        goal: str(call.input.goal),
        recentTools: Array.isArray(call.input.recentTools) ? call.input.recentTools.map(String) : [],
        failingTests: Array.isArray(call.input.failingTests) ? call.input.failingTests.map(String) : [],
      }),
    };
  }

  private readLints(call: ToolCall, ctx: CodeAgentContext): ToolExecutionResult {
    const files = Array.isArray(call.input.files) ? call.input.files.map(String) : [...ctx.ledger.keys()];
    const diagnostics = parseLintOutput(str(call.input.output), files[0]);
    void ctx.emit({ type: 'lint_errors', filePath: files[0] || 'workspace', errors: diagnostics });
    return { content: diagnostics.length ? diagnostics.map((item) => `${item.file}:${item.line}:${item.col} ${item.severity} ${item.message}`).join('\n') : 'No lint diagnostics parsed.' };
  }

  private async gitCommit(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const message = str(call.input.message);
    if (!message) return { content: 'git_commit requires message.', isError: true };
    const decision = this.decide('run_command', ctx.autonomy);
    if (decision.permission === 'blocked') return { content: formatAutonomyBlockedToolMessage('git_commit', ctx.autonomy, decision.reason), isError: true };
    if (decision.permission === 'approval_required') {
      const parked = await this.parkApproval(call, ctx, 'git_commit', decision.reason);
      if (parked) return parked;
    }
    await this.git(['add', '-A'], ctx);
    return this.git(['commit', '-m', message], ctx);
  }

  private async createPullRequest(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const decision = this.decide('run_command', ctx.autonomy);
    if (decision.permission === 'blocked') return { content: formatAutonomyBlockedToolMessage('create_pull_request', ctx.autonomy, decision.reason), isError: true };
    if (decision.permission === 'approval_required') {
      const parked = await this.parkApproval(call, ctx, 'create_pull_request', decision.reason);
      if (parked) return parked;
    }
    return this.git(['push', '-u', 'origin', 'HEAD'], ctx).then(async (push) => {
      if (push.isError) return push;
      const title = str(call.input.title);
      const body = str(call.input.body);
      return ctx.terminal.run(
        { kind: 'shell', command: 'gh', args: ['pr', 'create', '--title', title, '--body', body || title], cwd: ctx.root, reason: 'Create pull request.', timeoutMs: 60_000 },
        ctx.root,
        ctx.signal,
      ).then((result) => ({ content: result.output || 'gh pr create completed.', isError: result.status === 'failed' }));
    });
  }

  private async searchWithRipgrep(root: string, query: string, glob: string, mode: 'files' | 'content'): Promise<string | null> {
    const { spawnSync } = await import('node:child_process');
    const args = mode === 'files' ? ['-l', '-i', query] : ['-n', '-i', query];
    if (glob) args.push('-g', glob);
    const result = spawnSync('rg', args, { cwd: root, encoding: 'utf8' });
    if (result.error || result.status === 127) return null;
    return result.stdout?.trim() || (result.status === 1 ? `No matches for "${query}".` : null);
  }

  private toolSearch(call: ToolCall): ToolExecutionResult {
    const query = str(call.input.query).toLowerCase();
    const names = CODE_MODE_TOOL_SPECS.map((spec) => spec.name).filter((name) => !query || name.includes(query));
    return { content: names.length ? `Matching tools: ${names.join(', ')}` : `No tools matched "${query}".` };
  }

  private async invokeMcp(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const parsed = parseMcpToolName(call.name);
    if (!parsed) return { content: `Invalid MCP tool name ${call.name}.`, isError: true, recoverable: true };
    const config = await loadMcpConfig(ctx.root);
    const content = await invokeMcpTool(config, parsed.server, str(call.input.tool) || parsed.tool, call.input.arguments);
    return { content };
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

function diffStats(diff: string): { added: number; removed: number; hunks: number } {
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) hunks += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed, hunks: Math.max(1, hunks) };
}

function createPatchHistoryEntry(
  ctx: CodeAgentContext,
  input: Omit<PatchHistoryEntry, 'patchId' | 'batchId' | 'createdAt'>,
): PatchHistoryEntry {
  const createdAt = Date.now();
  const index = (ctx.patchHistory?.length ?? 0) + 1;
  return {
    ...input,
    patchId: `patch:${ctx.runId}:${index}`,
    batchId: `batch:${ctx.runId}:${index}`,
    createdAt,
  };
}

async function recordPatchHistory(ctx: CodeAgentContext, patch: PatchHistoryEntry): Promise<void> {
  if (!ctx.patchHistory) ctx.patchHistory = [];
  ctx.patchHistory.push(patch);
  ctx.implementationContract = addPatchCoverage(ctx.implementationContract, patch);
  await ctx.emit({ type: 'patch_history', patch });
  if (ctx.implementationContract) {
    await ctx.emit({ type: 'coverage_updated', contract: ctx.implementationContract });
  }
  await ctx.emitRuntime('patch.proposed', {
    patchId: patch.patchId,
    batchId: patch.batchId,
    path: patch.filePath,
    mode: patch.mode,
    status: patch.status,
    added: patch.added,
    removed: patch.removed,
    hunks: patch.hunks,
  });
}

function windowAroundChange(filePath: string, after: string, before: string): string {
  const afterLines = after.split('\n');
  const beforeLines = before.split('\n');
  let start = 0;
  while (start < afterLines.length && start < beforeLines.length && afterLines[start] === beforeLines[start]) start += 1;
  const from = Math.max(0, start - 8);
  const to = Math.min(afterLines.length, start + 92);
  const numbered = afterLines.slice(from, to).map((line, offset) => `${from + offset + 1}: ${line}`).join('\n');
  return `${filePath} (window ${from + 1}-${to}):\n${numbered}`;
}

function writeThisMode(applyToDisk: boolean, filePath: string): PatchHistoryEntry['mode'] {
  if (filePath.startsWith('.agent/tests/')) return 'repaired';
  return applyToDisk ? 'applied' : 'proposed';
}

function isValidationLikeCommand(command: string, output: string): boolean {
  const combined = `${command}\n${output}`;
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|test|typecheck|build|verify|check|compile|format)(?:\b|:)/i.test(command) ||
    /\b(?:eslint|tsc|vitest|jest|mocha|pytest|ruff|mypy|go\s+test|cargo\s+test|cargo\s+check)\b/i.test(command) ||
    /\b(?:error|warning)\s+['"`]?[^'"`\n]+['"`]?\s+(?:is\s+)?(?:defined|assigned|never|not|missing|unexpected|invalid)/i.test(combined) ||
    /\b(?:prefer-const|no-unused-vars|@typescript-eslint\/|TS\d{4}|SyntaxError|TypeError|AssertionError)\b/i.test(combined)
  );
}

function formatBrowserDiagnostics(consoleMessages: string[], networkErrors: string[]): string {
  return [
    `consoleMessages: ${consoleMessages.length}`,
    ...consoleMessages.slice(-10).map((message) => `console: ${message}`),
    `networkErrors: ${networkErrors.length}`,
    ...networkErrors.slice(-10).map((message) => `network: ${message}`),
  ].join('\n');
}

function matchesGlob(file: string, glob: string): boolean {
  // Minimal glob: supports **, *, and literal segments. Anchored to full path.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_STAR__/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(file) || new RegExp(escaped).test(file);
  } catch {
    return file.includes(glob.replace(/\*/g, ''));
  }
}

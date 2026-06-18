import type { ProviderSession, ToolSpec } from '@/lib/agent/providers';
import type { AutonomyLevel } from '@/lib/code-space/domain';
import { CodeAgentLoop } from './codeAgentLoop';
import { CODE_MODE_TOOL_SPECS, ToolExecutor, type CodeAgentContext, type LedgerEntry } from './toolExecutor';
import { createDefaultToolRegistry } from './toolRegistry';
import { PermissionManager } from './permissionManager';
import { TerminalRunner } from './terminalRunner';
import { ToolBudget, isReadOnlyTool } from './toolBudget';

export type SubagentRole = 'explorer' | 'critic' | 'docs-reader' | 'test-writer' | 'verifier';

const READ_ONLY_ROLES: SubagentRole[] = ['explorer', 'critic', 'docs-reader'];
const KNOWN_ROLES: SubagentRole[] = ['explorer', 'critic', 'docs-reader', 'test-writer', 'verifier'];

export interface SubagentSpawnRequest {
  role: string;
  task: string;
  allowedTools?: string[];
  readOnly?: boolean;
  maxToolCalls?: number;
}

export interface SubagentResult {
  role: string;
  summary: string;
  success: boolean;
  toolCalls: number;
}

function normalizeRole(role: string): SubagentRole {
  const lower = role.trim().toLowerCase().replace(/\s+/g, '-');
  return (KNOWN_ROLES as string[]).includes(lower) ? (lower as SubagentRole) : 'explorer';
}

function specByName(name: string): ToolSpec | undefined {
  return CODE_MODE_TOOL_SPECS.find((spec) => spec.name === name);
}

/** Role-scoped tool allow-list. Read-only roles never receive mutating tools. */
function resolveRoleTools(role: SubagentRole, readOnly: boolean, allowedTools?: string[]): ToolSpec[] {
  const readSpecs = CODE_MODE_TOOL_SPECS.filter((spec) => isReadOnlyTool(spec.name));
  const completion = specByName('attempt_completion');
  const specs: ToolSpec[] = [...readSpecs];
  if (!readOnly && (role === 'test-writer' || role === 'verifier')) {
    for (const name of ['edit_file', 'run_command']) {
      const spec = specByName(name);
      if (spec) specs.push(spec);
    }
  }
  if (completion) specs.push(completion);
  if (allowedTools?.length) {
    const allow = new Set([...allowedTools, 'attempt_completion']);
    return specs.filter((spec) => allow.has(spec.name));
  }
  return specs;
}

function buildSubagentSystemPrompt(role: SubagentRole, projectName: string): string {
  const roleBrief: Record<SubagentRole, string> = {
    explorer: 'Investigate the repository and report concrete findings (files, symbols, call sites). Do not edit anything.',
    critic: 'Critically review the current changes/approach and report risks, gaps, and concrete improvement suggestions. Do not edit anything.',
    'docs-reader': 'Read documentation, READMEs, and comments and report the conventions and constraints that apply. Do not edit anything.',
    'test-writer': 'Write focused, runnable test scripts under the .agent/tests/ folder for the changes, run them, and report results honestly. Do not modify source files.',
    verifier: 'Verify the changes by running validation commands and inspecting output. Report exact failures. Do not modify source files outside .agent/tests/.',
  };
  return [
    `You are a ${role} subagent collaborating on the "${projectName}" repository with an isolated, fresh context window.`,
    roleBrief[role],
    'Work efficiently within your tool budget. When finished, call attempt_completion with a concise, factual summary (success=false only if blocked).',
  ].join('\n');
}

function buildSubagentSeedMessage(task: string): string {
  return ['Subtask:', task, '', 'Use your tools to complete this subtask, then call attempt_completion.'].join('\n');
}

/**
 * Spawns isolated subagents that share the workspace root and parent event stream but run on a
 * fresh conversation thread + budget partition. Mutating subagents' ledger/proposals/artifacts are
 * merged back into the parent context after completion so the supervisor can reconcile them.
 */
export class SubagentRunner {
  constructor(
    private readonly parentCtx: CodeAgentContext,
    private readonly session: ProviderSession,
    private readonly projectName: string,
  ) {}

  async spawn(request: SubagentSpawnRequest): Promise<SubagentResult> {
    const role = normalizeRole(request.role);
    const readOnly = request.readOnly ?? READ_ONLY_ROLES.includes(role);
    const tools = resolveRoleTools(role, readOnly, request.allowedTools);
    const maxToolCalls = Math.max(1, Math.min(40, request.maxToolCalls ?? 14));
    const autonomy: AutonomyLevel = readOnly ? 'suggest_only' : 'auto_safe_tools';

    const childCtx: CodeAgentContext = {
      root: this.parentCtx.root,
      runId: this.parentCtx.runId,
      projectId: this.parentCtx.projectId,
      sessionId: this.parentCtx.sessionId,
      autonomy,
      emit: this.parentCtx.emit,
      emitRuntime: this.parentCtx.emitRuntime,
      ledger: new Map<string, LedgerEntry>(),
      patchHistory: [],
      implementationContract: this.parentCtx.implementationContract,
      proposedFiles: new Set<string>(),
      proposedLedger: new Map(),
      editFailures: new Map(),
      readFiles: new Set<string>(),
      artifacts: new Map(),
      checkpoints: [],
      registry: createDefaultToolRegistry(),
      permission: new PermissionManager(),
      terminal: new TerminalRunner(),
      onCheckpoint: this.parentCtx.onCheckpoint,
      signal: this.parentCtx.signal,
      // No nested spawning — subagents cannot recursively spawn.
    };

    const budget = new ToolBudget(maxToolCalls, maxToolCalls * 2 + 4);
    const loop = new CodeAgentLoop(new ToolExecutor(childCtx.registry, childCtx.permission));
    loop.seed(buildSubagentSystemPrompt(role, this.projectName), buildSubagentSeedMessage(request.task));

    await this.parentCtx.emitRuntime('subagent.started', { role, task: request.task, readOnly });
    const result = await loop.run(childCtx, { session: this.session, budget, signal: this.parentCtx.signal, tools });
    await this.parentCtx.emitRuntime('subagent.completed', { role, success: result.success !== false, summary: result.summary });

    // Merge subagent contributions into the parent context for supervisor reconciliation.
    for (const [path, entry] of childCtx.ledger) if (!this.parentCtx.ledger.has(path)) this.parentCtx.ledger.set(path, entry);
    for (const path of childCtx.proposedFiles) this.parentCtx.proposedFiles.add(path);
    for (const [path, entry] of childCtx.proposedLedger) this.parentCtx.proposedLedger.set(path, entry);
    for (const [id, artifact] of childCtx.artifacts) this.parentCtx.artifacts.set(id, artifact);
    for (const checkpoint of childCtx.checkpoints) this.parentCtx.checkpoints.push(checkpoint);
    if (childCtx.patchHistory?.length) {
      this.parentCtx.patchHistory = [...(this.parentCtx.patchHistory ?? []), ...childCtx.patchHistory];
    }
    if (childCtx.implementationContract) this.parentCtx.implementationContract = childCtx.implementationContract;

    return { role, summary: result.summary, success: result.success !== false, toolCalls: budget.turnsUsed };
  }
}

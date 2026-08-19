import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentOrchestrator } from '../agentOrchestrator';
import { assertPersistableWorkGraph } from '../workGraphPolicy';
import { acquireWorkspaceLock, releaseWorkspaceLock, workspaceLockOwner } from '../workspaceLock';
import { abortRun, registerRunAbort } from '../runAbortRegistry';
import { SpendMeter, parseProviderUsage } from '../spendMeter';
import { buildStablePrefix } from '../contextAssembler';
import { applyLayeredCompact } from '../compactionEngine';
import { buildCleanCriticPrompt } from '../cleanCritic';
import { modelForRole, shouldSwitchModel } from '../roleRouting';
import { wrapSandboxedCommand } from '../sandboxRuntime';
import { invokeMcpTool, parseMcpToolName, shouldUseToolSearch } from '../mcpRuntime';
import { enqueueSteer, drainSteerQueue } from '../steerQueue';
import { assertFreshHash } from '../fileFreshness';
import { parkToolCall, resolveApproval, takeParkedToolCall, waitForApproval } from '../pendingToolApproval';
import { ExecutionScheduler } from '../executionScheduler';
import { RunWorker } from '../runWorker';
import { JsonCodeSpaceStore } from '../serverStore';
import { ToolExecutor, type CodeAgentContext } from '../toolExecutor';
import { createDefaultToolRegistry } from '../toolRegistry';
import { PermissionManager } from '../permissionManager';
import { TerminalRunner } from '../terminalRunner';
import { DelegationPlanner } from '../delegationPlanner';
import { withRetry } from '@/lib/agent/providers/retry';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-ledger-harness-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function context(events: AgentSSEEvent[] = []): CodeAgentContext {
  return {
    root: tmpDir,
    runId: 'run-harness',
    projectId: 'proj',
    sessionId: 'sess',
    autonomy: 'auto_safe_tools',
    emit: (event) => {
      events.push(event);
    },
    emitRuntime: async () => {},
    ledger: new Map(),
    proposedFiles: new Set(),
    proposedLedger: new Map(),
    editFailures: new Map(),
    readFiles: new Set(),
    artifacts: new Map(),
    checkpoints: [],
    registry: createDefaultToolRegistry(),
    permission: new PermissionManager(),
    terminal: new TerminalRunner(),
    readHashes: new Map(),
  };
}

describe('ledger-steered harness', () => {
  it('does not auto-graph short tasks and rejects empty deps', () => {
    const graph = new AgentOrchestrator('deep').buildWorkGraph({
      runId: 'run:short',
      prompt: 'Fix a typo',
      context: { selectedFiles: ['a.ts'], testCandidates: [], missingContextWarnings: [] } as never,
      validationCommands: [],
      mode: 'code',
    });
    expect(graph.packages).toEqual([]);
    expect(new DelegationPlanner().plan({
      mode: 'code',
      prompt: 'Comprehensively review everything',
      context: { selectedFiles: Array.from({ length: 24 }, (_, i) => `f${i}.ts`) } as never,
      validationCommands: [],
    }).required).toBe(false);
    expect(() =>
      assertPersistableWorkGraph({
        ...graph,
        packages: [{
          id: 'work:1',
          role: 'explorer',
          title: 'x',
          task: 'x',
          readOnly: true,
          maxToolCalls: 4,
          dependencies: [],
          depth: 0,
          reason: 'x',
        }],
      }),
    ).toThrow(/independent/);
  });

  it('keeps a cache-stable prefix when only the tail changes', () => {
    const prefix = buildStablePrefix({
      projectName: 'Demo',
      mode: 'code',
      autonomyGuidance: 'auto',
      toolNames: ['read_file', 'edit_file'],
      skillCatalog: [{ id: 'tdd', title: 'TDD', description: 'test first' }],
    });
    expect(prefix).toBe(buildStablePrefix({
      projectName: 'Demo',
      mode: 'code',
      autonomyGuidance: 'auto',
      toolNames: ['read_file', 'edit_file'],
      skillCatalog: [{ id: 'tdd', title: 'TDD', description: 'test first' }],
    }));
  });

  it('defaults read_file to a 100-line window', async () => {
    await writeFile(path.join(tmpDir, 'big.ts'), Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n'), 'utf8');
    const executor = new ToolExecutor();
    const result = await executor.execute({ id: 'r1', name: 'read_file', input: { path: 'big.ts' } }, context());
    const numbered = result.content.split('\n').filter((line) => /^\d+\t/.test(line));
    expect(numbered.length).toBeLessThanOrEqual(120);
    expect(numbered.length).toBeGreaterThan(10);
  });

  it('fails closed on stale hash apply', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n', 'utf8');
    const ctx = context();
    const executor = new ToolExecutor();
    await executor.execute({ id: 'r1', name: 'read_file', input: { path: 'a.ts' } }, ctx);
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 99;\n', 'utf8');
    const result = await executor.execute({
      id: 'e1',
      name: 'edit_file',
      input: { edits: [{ path: 'a.ts', search: 'export const x = 1;', replace: 'export const x = 2;', reason: 'bump' }] },
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/STALE_FILE/);
    expect(await readFile(path.join(tmpDir, 'a.ts'), 'utf8')).toContain('x = 99');
  });

  it('parks then executes after resolveApproval', async () => {
    parkToolCall({ toolCallId: 'tc-1', runId: 'run-harness', name: 'run_command', input: { command: 'echo' }, createdAt: Date.now() });
    const pending = waitForApproval('tc-1');
    expect(resolveApproval('tc-1', 'approved')).toBe(true);
    await expect(pending).resolves.toBe('approved');
    expect(takeParkedToolCall('tc-1')?.name).toBe('run_command');
  });

  it('cancels the registered abort signal', () => {
    const controller = registerRunAbort('run-abort');
    expect(controller.signal.aborted).toBe(false);
    expect(abortRun('run-abort')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('excludes a second writer via workspace lock', () => {
    acquireWorkspaceLock(tmpDir, 'run-a');
    expect(workspaceLockOwner(tmpDir)).toBe('run-a');
    expect(() => acquireWorkspaceLock(tmpDir, 'run-b')).toThrow(/locked/);
    releaseWorkspaceLock(tmpDir, 'run-a');
    acquireWorkspaceLock(tmpDir, 'run-b');
    releaseWorkspaceLock(tmpDir, 'run-b');
  });

  it('hard-stops spend and parses provider usage', () => {
    const meter = new SpendMeter({ maxUsd: 0.0001, maxTokens: 20 });
    meter.record(parseProviderUsage({ usage: { prompt_tokens: 12, completion_tokens: 12 } }));
    expect(meter.exhausted()).toBe(true);
    expect(meter.snapshot().calls).toBe(1);
  });

  it('caps provider retries', async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts += 1;
      const err = new Error('500 boom') as Error & { status: number };
      err.status = 500;
      throw err;
    }, { maxAttempts: 2, baseDelayMs: 1, capDelayMs: 2 })).rejects.toThrow(/500/);
    expect(attempts).toBeLessThanOrEqual(3);
  });

  it('drains scheduled work after heartbeat requeue', async () => {
    const store = new JsonCodeSpaceStore(path.join(tmpDir, 'store.json'));
    const graph = new AgentOrchestrator('standard').buildWorkGraph({
      runId: 'run-w',
      prompt: 'x',
      context: { selectedFiles: [] } as never,
      validationCommands: [],
      mode: 'ask',
    });
    const pkg = {
      id: 'pkg-1',
      role: 'explorer' as const,
      title: 'explore',
      task: 'look',
      readOnly: true,
      maxToolCalls: 2,
      dependencies: [],
      independent: true,
      depth: 0,
      reason: 'test',
      status: 'ready' as const,
      goal: 'look',
      acceptanceCriteria: ['ok'],
      validation: [],
      risk: 'low' as const,
      expectedArtifacts: [],
      blockerCriteria: [],
      ownership: { ownerRole: 'explorer' as const, allowedPaths: [], forbiddenPaths: [], requiresReview: false },
      updatedAt: Date.now(),
    };
    await store.upsert('workGraphs', {
      id: 'g1',
      runId: 'run-w',
      graph: { ...graph, packages: [pkg] },
      packages: [pkg],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const scheduler = new ExecutionScheduler(store);
    await scheduler.enqueue('run-w', [pkg]);
    const worker = new RunWorker(store, scheduler);
    const results = await worker.drain('run-w', {
      executePackage: async (item) => ({ role: item.role, summary: 'ok', success: true, toolCalls: 0, advisory: true }),
    });
    expect(results).toHaveLength(1);
  });

  it('wipes old tool results during layered compact', () => {
    const compacted = applyLayeredCompact([
      { role: 'system', content: 'prefix' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'tool' as const, content: '', toolResults: [{ toolCallId: `t${i}`, content: 'x'.repeat(400) }] })),
    ], 'Task: keep going');
    expect(compacted.flushed).toBe(true);
    expect(compacted.messages[0]?.content).toBe('prefix');
  });

  it('drains steer at the next boundary', () => {
    enqueueSteer('run-s', 'do not recreate rejected span', 'queue');
    const drained = drainSteerQueue('run-s');
    expect(drained[0]?.text).toMatch(/rejected span/);
    expect(drainSteerQueue('run-s')).toEqual([]);
  });

  it('assertFreshHash fails closed', () => {
    expect(() => assertFreshHash('abc', 'def', 'a.ts')).toThrow(/STALE_FILE/);
  });

  it('requeues stale running work on crash-wake', async () => {
    const store = new JsonCodeSpaceStore(path.join(tmpDir, 'wake-store.json'));
    const scheduler = new ExecutionScheduler(store);
    const pkg = {
      id: 'pkg-wake',
      role: 'explorer' as const,
      title: 'explore',
      task: 'look',
      readOnly: true,
      maxToolCalls: 2,
      dependencies: [],
      independent: true,
      depth: 0,
      reason: 'test',
      status: 'ready' as const,
      goal: 'look',
      acceptanceCriteria: ['ok'],
      validation: [],
      risk: 'low' as const,
      expectedArtifacts: [],
      blockerCriteria: [],
      ownership: { ownerRole: 'explorer' as const, allowedPaths: [], forbiddenPaths: [], requiresReview: false },
      updatedAt: Date.now(),
    };
    await scheduler.enqueue('run-wake', [pkg]);
    await scheduler.mark('run-wake', 'pkg-wake', 'running', 'crashed mid-flight');
    const worker = new RunWorker(store, scheduler);
    expect(await worker.requeueStale('run-wake', 0)).toBe(1);
    const batch = await scheduler.nextBatch('run-wake');
    expect(batch[0]?.packageId).toBe('pkg-wake');
  });

  it('keeps prefix before constitution-style compact summary', () => {
    const compacted = applyLayeredCompact([
      { role: 'system', content: 'stable-prefix' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'tool' as const, content: '', toolResults: [{ toolCallId: `t${i}`, content: 'x'.repeat(400) }] })),
    ], 'Task: keep going');
    expect(compacted.messages[0]?.content).toBe('stable-prefix');
    expect(compacted.messages.some((message) => message.content.includes('Task: keep going'))).toBe(true);
  });

  it('builds a clean-context critic prompt without the writer transcript', () => {
    const prompt = buildCleanCriticPrompt({ diff: '--- a\n+++ b\n+bug', acceptance: ['keep reserve false'], tests: ['npm test'] });
    expect(prompt).toContain('--- a');
    expect(prompt).toContain('do not inherit');
    expect(prompt).not.toMatch(/role":"assistant"|Previous conversation/i);
  });

  it('routes explore to the cheap model only at compact boundaries', () => {
    expect(modelForRole('explore', 'frontier', 'cheap')).toBe('cheap');
    expect(modelForRole('implement', 'frontier', 'cheap')).toBe('frontier');
    expect(shouldSwitchModel(false)).toBe(false);
    expect(shouldSwitchModel(true)).toBe(true);
  });

  it('wraps commands only when the OS sandbox is enabled', () => {
    const previous = process.env.CODE_SPACE_SANDBOX;
    delete process.env.CODE_SPACE_SANDBOX;
    expect(wrapSandboxedCommand('node', ['-e', '1'], tmpDir).command).toBe('node');
    process.env.CODE_SPACE_SANDBOX = '1';
    const wrapped = wrapSandboxedCommand('node', ['-e', '1'], tmpDir);
    if (process.platform === 'darwin') expect(wrapped.command).toBe('sandbox-exec');
    else expect(wrapped.command).toBe('node');
    if (previous === undefined) delete process.env.CODE_SPACE_SANDBOX;
    else process.env.CODE_SPACE_SANDBOX = previous;
  });

  it('parses MCP tool names and refuses unconfigured servers', async () => {
    expect(parseMcpToolName('mcp__docs__invoke')).toEqual({ server: 'docs', tool: 'invoke' });
    expect(shouldUseToolSearch(8)).toBe(false);
    await expect(invokeMcpTool({}, 'docs', 'search', {})).resolves.toMatch(/not configured/);
  });
});

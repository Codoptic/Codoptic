import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentOrchestrator, type WorkGraph, type WorkPackage } from '../agentOrchestrator';
import { ContextLedger } from '../contextLedger';
import { CoworkingRunManager } from '../coworkingRunManager';
import type { SubagentDeliverable } from '../coworkingTypes';
import { ExecutionScheduler } from '../executionScheduler';
import { HookRunner } from '../hookRunner';
import { JsonCodeSpaceStore } from '../serverStore';
import { SubagentGovernor } from '../subagentGovernor';
import type { CodeAgentContext } from '../toolExecutor';

let tmpDir: string | null = null;

afterEach(async () => {
  if (!tmpDir) return;
  const base = path.basename(tmpDir);
  if (!base.startsWith('.tmp-coworking-')) {
    throw new Error(`Refusing to clean unexpected temp directory: ${tmpDir}`);
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('coworking runtime v2', () => {
  it('persists coworking run, governed graph, scheduler queue, ledger, and run artifacts', async () => {
    const projectRoot = await makeTmpDir('persist');
    const store = new JsonCodeSpaceStore(path.join(projectRoot, 'store.json'));
    const manager = new CoworkingRunManager(store);
    const run = await manager.create({
      runId: 'run:test:1',
      sessionId: 'session:test',
      projectId: 'Project',
      projectRoot,
      prompt: 'Implement a complex UI and validation change.',
      scaleProfile: 'massive',
    });
    const graph = sampleGraph('run:test:1');

    const persistedGraph = await manager.persistGraph(run, graph);
    const ledger = new ContextLedger('run:test:1', 'massive');
    ledger.add({ kind: 'decision', summary: 'Planner split the work into governed packages.', status: 'completed' });
    await manager.persistLedger('run:test:1', ledger);

    const data = await store.read();
    expect(data.coworkingRuns).toHaveLength(1);
    expect(data.workGraphs[0]?.packages).toHaveLength(2);
    expect(data.scheduledWork.map((entry) => entry.status)).toEqual(['queued', 'sleeping']);
    expect(data.contextLedgerEntries).toHaveLength(1);
    expect(persistedGraph.packages[0]?.acceptanceCriteria.length).toBeGreaterThan(0);
    await expect(fs.stat(path.join(projectRoot, '.agent', 'runs', 'run:test:1', 'PLAN.md'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(projectRoot, '.agent', 'runs', 'run:test:1', 'STATUS.md'))).resolves.toBeTruthy();
  });

  it('schedules only profile-bounded ready packages', async () => {
    const projectRoot = await makeTmpDir('schedule');
    const store = new JsonCodeSpaceStore(path.join(projectRoot, 'store.json'));
    const scheduler = new ExecutionScheduler(store, { maxConcurrent: 1, maxAttempts: 2, maxWallClockMs: 1000 });
    const packages = sampleGraph('run:test:2').packages.map((pkg) => new SubagentGovernor().governPackage(pkg, sampleGraph('run:test:2')));
    await scheduler.enqueue('run:test:2', packages);

    const first = await scheduler.nextBatch('run:test:2');
    expect(first).toHaveLength(1);
    await scheduler.mark('run:test:2', first[0]!.packageId, 'running', 'Started by test.');
    expect(await scheduler.nextBatch('run:test:2')).toHaveLength(0);
  });

  it('validates subagent deliverables against package ownership and evidence policy', () => {
    const governor = new SubagentGovernor();
    const graph = sampleGraph('run:test:3');
    const pkg = governor.governPackage(graph.packages[0]!, graph);
    const goodDeliverable: SubagentDeliverable = {
      packageId: pkg.id,
      role: pkg.role,
      status: 'done',
      changedFiles: [],
      evidence: [{ kind: 'review', summary: 'Inspected runtime files.' }],
      blockers: [],
      handoffNotes: 'Ready for integration.',
      validationRequested: [],
      confidence: 'high',
    };
    const badDeliverable = { ...goodDeliverable, changedFiles: ['.git/config'], evidence: [] };

    expect(governor.validateDeliverable(pkg, goodDeliverable).ok).toBe(true);
    const bad = governor.validateDeliverable(pkg, badDeliverable);
    expect(bad.ok).toBe(false);
    expect(bad.issues.join(' ')).toContain('forbidden');
    expect(bad.issues.join(' ')).toContain('no evidence');
  });

  it('blocks UI completion without browser evidence and passes after evidence is recorded', () => {
    const ctx = {
      ledger: new Map([['components/code-space/MissionBoard.tsx', { beforeContent: '', afterContent: 'x', deleted: false, existedBefore: true }]]),
      proposedFiles: new Set<string>(),
      editFailures: new Map(),
      contextLedger: new ContextLedger('run:test:4', 'deep'),
    } as unknown as CodeAgentContext;
    const hooks = new HookRunner();

    expect(hooks.afterUiEdit(ctx, ['components/code-space/MissionBoard.tsx']).status).toBe('blocked');
    ctx.contextLedger?.add({ kind: 'browser', summary: 'Desktop screenshot and console check passed.', status: 'passed' });
    expect(hooks.afterUiEdit(ctx, ['components/code-space/MissionBoard.tsx']).status).toBe('passed');
    expect(hooks.beforeCompletion(ctx).status).toBe('passed');
  });
});

async function makeTmpDir(prefix: string): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `.tmp-coworking-${prefix}-`));
  return tmpDir;
}

function sampleGraph(runId: string): WorkGraph {
  const packages: WorkPackage[] = [
    {
      id: `work:${runId}:1:explorer`,
      role: 'explorer',
      title: 'Explore runtime files',
      task: 'Inspect lib/code-space/runtime/agentRuntime.ts and lib/code-space/runtime/subagentRunner.ts.',
      readOnly: true,
      maxToolCalls: 20,
      dependencies: [],
      independent: true,
      depth: 0,
      reason: 'repository investigation',
    },
    {
      id: `work:${runId}:2:verifier`,
      role: 'verifier',
      title: 'Verify runtime behavior',
      task: 'Run npm run test -- --run lib/code-space/runtime.',
      readOnly: true,
      maxToolCalls: 20,
      dependencies: [`work:${runId}:1:explorer`],
      depth: 1,
      reason: 'validation review',
    },
  ];
  return {
    runId,
    profile: 'massive',
    packages,
    createdAt: Date.now(),
    limits: new AgentOrchestrator('massive').buildWorkGraph({
      runId,
      prompt: 'simple',
      context: { selectedFiles: [], testCandidates: [], missingContextWarnings: [] } as never,
      validationCommands: [],
      mode: 'ask',
    }).limits,
  };
}

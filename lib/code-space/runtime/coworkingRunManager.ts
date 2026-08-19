import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getCodeSpaceStore, type JsonCodeSpaceStore } from './serverStore';
import type { ContextLedger } from './contextLedger';
import type { WorkGraph } from './agentOrchestrator';
import { ContextLedgerStore } from './contextLedgerStore';
import { ExecutionScheduler } from './executionScheduler';
import { runtimeScaleLimits, type RuntimeScaleProfile } from './scaleProfile';
import { SubagentGovernor } from './subagentGovernor';
import { WorkGraphStore } from './workGraphStore';
import type {
  CoworkingPhase,
  CoworkingRun,
  CoworkingSyncMode,
  GovernedWorkPackage,
  PersistedWorkGraph,
  SubagentDeliverable,
} from './coworkingTypes';
import { assertPersistableWorkGraph } from './workGraphPolicy';

export interface CoworkingRunCreateInput {
  runId: string;
  sessionId: string;
  projectId: string;
  projectRoot: string;
  prompt: string;
  scaleProfile: RuntimeScaleProfile;
  syncMode?: CoworkingSyncMode;
}

export class CoworkingRunManager {
  constructor(
    private readonly store: JsonCodeSpaceStore = getCodeSpaceStore(),
    private readonly workGraphs = new WorkGraphStore(store),
    private readonly ledgers = new ContextLedgerStore(store),
    private readonly governor = new SubagentGovernor(),
  ) {}

  async create(input: CoworkingRunCreateInput): Promise<CoworkingRun> {
    const now = Date.now();
    const run: CoworkingRun = {
      id: `cowork:${input.runId}`,
      runId: input.runId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      prompt: input.prompt,
      phase: 'intake',
      scaleProfile: input.scaleProfile,
      syncMode: input.syncMode ?? 'ask_before_risky_decisions',
      latestPlanSummary: 'Intake started.',
      openBlockers: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsert('coworkingRuns', run);
    await this.writeRunArtifacts(run, undefined, []);
    return run;
  }

  async transition(runId: string, phase: CoworkingPhase, summary?: string, blockers: string[] = []): Promise<CoworkingRun | null> {
    let updated: CoworkingRun | null = null;
    await this.store.update((data) => {
      const run = data.coworkingRuns.find((entry) => entry.runId === runId);
      if (!run) return;
      run.phase = phase;
      run.latestPlanSummary = summary ?? run.latestPlanSummary;
      run.openBlockers = blockers;
      run.updatedAt = Date.now();
      updated = run;
    });
    if (updated) await this.writeRunArtifacts(updated, await this.workGraphs.getByRun(runId), await this.ledgers.list(runId));
    return updated;
  }

  async persistGraph(run: CoworkingRun, graph: WorkGraph): Promise<PersistedWorkGraph> {
    assertPersistableWorkGraph(graph);
    const packages: GovernedWorkPackage[] = graph.packages.map((pkg) => this.governor.governPackage(pkg, graph));
    const now = Date.now();
    const persisted: PersistedWorkGraph = {
      id: `workgraph:${graph.runId}`,
      runId: graph.runId,
      graph,
      packages,
      createdAt: now,
      updatedAt: now,
    };
    await this.workGraphs.save(persisted);
    await this.store.update((data) => {
      const runRecord = data.coworkingRuns.find((entry) => entry.runId === run.runId);
      if (!runRecord) return;
      runRecord.workGraphId = persisted.id;
      runRecord.phase = 'workgraph_ready';
      runRecord.latestPlanSummary = `Work graph ready with ${packages.length} governed package(s).`;
      runRecord.updatedAt = Date.now();
    });
    const limits = runtimeScaleLimits(run.scaleProfile, 'code');
    await new ExecutionScheduler(this.store, {
      maxConcurrent: limits.maxSubagentConcurrency,
      maxAttempts: limits.repeatedFailureLimit,
      maxWallClockMs: limits.maxWallClockMs,
    }).enqueue(run.runId, packages);
    await this.writeRunArtifacts(
      { ...run, workGraphId: persisted.id, phase: 'workgraph_ready', latestPlanSummary: `Work graph ready with ${packages.length} governed package(s).` },
      persisted,
      await this.ledgers.list(run.runId),
    );
    return persisted;
  }

  async persistLedger(runId: string, ledger: ContextLedger): Promise<void> {
    await this.ledgers.persistLedger(runId, ledger);
    const run = await this.get(runId);
    if (run) await this.writeRunArtifacts(run, await this.workGraphs.getByRun(runId), await this.ledgers.list(runId));
  }

  async recordDeliverable(runId: string, deliverable: SubagentDeliverable): Promise<void> {
    await this.store.upsert('subagentDeliverables', {
      id: `deliverable:${runId}:${deliverable.packageId}:${Date.now()}`,
      runId,
      createdAt: Date.now(),
      ...deliverable,
    });
  }

  async get(runId: string): Promise<CoworkingRun | null> {
    const data = await this.store.read();
    return data.coworkingRuns.find((run) => run.runId === runId) ?? null;
  }

  private async writeRunArtifacts(
    run: CoworkingRun,
    graph?: PersistedWorkGraph | null,
    ledgerEntries: Array<{ kind: string; summary: string; status?: string; artifactId?: string }> = [],
  ): Promise<void> {
    const dir = path.join(run.projectRoot, '.agent', 'runs', sanitizeRunId(run.runId));
    await fs.mkdir(dir, { recursive: true });
    const packages = graph?.packages ?? [];
    await fs.writeFile(
      path.join(dir, 'PLAN.md'),
      [
        `# Coworking Plan: ${run.runId}`,
        '',
        `Prompt: ${run.prompt}`,
        `Scale profile: ${run.scaleProfile}`,
        `Sync mode: ${run.syncMode}`,
        '',
        '## Work Packages',
        packages.length
          ? packages.map((pkg) => `- [${pkg.status}] ${pkg.id} (${pkg.role}) - ${pkg.goal}`).join('\n')
          : '- Work graph not created yet.',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'STATUS.md'),
      [
        `# Coworking Status: ${run.runId}`,
        '',
        `Phase: ${run.phase}`,
        `Updated: ${new Date(run.updatedAt).toISOString()}`,
        `Summary: ${run.latestPlanSummary}`,
        '',
        '## Blockers',
        run.openBlockers.length ? run.openBlockers.map((item) => `- ${item}`).join('\n') : '- None',
        '',
        '## Recent Evidence',
        ledgerEntries.length
          ? ledgerEntries.slice(-20).map((entry) => `- ${entry.kind}${entry.status ? `/${entry.status}` : ''}: ${entry.summary}${entry.artifactId ? ` (${entry.artifactId})` : ''}`).join('\n')
          : '- No ledger evidence persisted yet.',
        '',
      ].join('\n'),
      'utf8',
    );
    const decisionLines = ledgerEntries.filter((entry) => entry.kind === 'decision').map((entry) => `- ${entry.summary}`);
    await fs.writeFile(
      path.join(dir, 'DECISIONS.md'),
      [
        `# Coworking Decisions: ${run.runId}`,
        '',
        ...(decisionLines.length ? decisionLines : ['- No durable decisions recorded yet.']),
        '',
      ].join('\n'),
      'utf8',
    );
  }

  async appendDecision(runId: string, decision: string): Promise<void> {
    const run = await this.get(runId);
    if (!run) return;
    const filePath = path.join(run.projectRoot, '.agent', 'runs', sanitizeRunId(run.runId), 'DECISIONS.md');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `- ${new Date().toISOString()} ${decision}\n`, 'utf8');
  }
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_.:-]+/g, '-');
}

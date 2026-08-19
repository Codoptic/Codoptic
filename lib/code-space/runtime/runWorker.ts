import type { SubagentResult } from './subagentRunner';
import type { WorkPackage } from './agentOrchestrator';
import { ExecutionScheduler } from './executionScheduler';
import { WorkGraphStore } from './workGraphStore';
import { getCodeSpaceStore, type JsonCodeSpaceStore } from './serverStore';

const STALE_HEARTBEAT_MS = 45_000;

export interface RunWorkerOptions {
  executePackage: (pkg: WorkPackage) => Promise<SubagentResult>;
  heartbeatMs?: number;
}

export class RunWorker {
  constructor(
    private readonly store: JsonCodeSpaceStore = getCodeSpaceStore(),
    private readonly scheduler = new ExecutionScheduler(store),
    private readonly graphs = new WorkGraphStore(store),
  ) {}

  async requeueStale(runId: string, staleMs = STALE_HEARTBEAT_MS): Promise<number> {
    const now = Date.now();
    let count = 0;
    await this.store.update((data) => {
      for (const record of data.scheduledWork) {
        if (record.runId !== runId || record.status !== 'running') continue;
        if ((record.heartbeatAt ?? 0) + staleMs >= now) continue;
        record.status = 'queued';
        record.reason = 'Stale heartbeat; requeued after crash.';
        record.updatedAt = now;
        count += 1;
      }
    });
    return count;
  }

  async drain(runId: string, options: RunWorkerOptions): Promise<SubagentResult[]> {
    await this.requeueStale(runId);
    const graph = await this.graphs.getByRun(runId);
    const results: SubagentResult[] = [];
    if (!graph) return results;

    let batch = await this.scheduler.nextBatch(runId);
    while (batch.length) {
      for (const record of batch) {
        const pkg = graph.packages.find((item) => item.id === record.packageId);
        if (!pkg) {
          await this.scheduler.mark(runId, record.packageId, 'failed', 'Package missing from work graph.');
          continue;
        }
        await this.scheduler.mark(runId, record.packageId, 'running', 'Worker started package.');
        const heartbeat = setInterval(() => {
          void this.scheduler.heartbeat(runId, record.packageId);
        }, options.heartbeatMs ?? 10_000);
        try {
          const result = await options.executePackage(pkg);
          results.push(result);
          await this.scheduler.mark(runId, record.packageId, result.success ? 'completed' : 'failed', result.summary);
          await this.graphs.updatePackageStatus(runId, record.packageId, result.success ? 'done' : 'blocked');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.scheduler.mark(runId, record.packageId, 'failed', message);
        } finally {
          clearInterval(heartbeat);
        }
      }
      batch = await this.scheduler.nextBatch(runId);
    }
    return results;
  }
}

export async function wakeRun(runId: string, store: JsonCodeSpaceStore = getCodeSpaceStore()): Promise<number> {
  const now = Date.now();
  let count = 0;
  await store.update((data) => {
    for (const record of data.scheduledWork) {
      if (record.runId !== runId) continue;
      if (record.status !== 'sleeping' && record.status !== 'queued') continue;
      record.status = 'queued';
      record.runAfter = now;
      record.reason = 'Woken by user or worker.';
      record.updatedAt = now;
      count += 1;
    }
  });
  return count;
}

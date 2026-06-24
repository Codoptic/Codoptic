import { getCodeSpaceStore, type JsonCodeSpaceStore } from './serverStore';
import type { GovernedWorkPackage, ScheduledWorkRecord } from './coworkingTypes';

export interface SchedulerLimits {
  maxConcurrent: number;
  maxAttempts: number;
  maxWallClockMs: number;
}

export class ExecutionScheduler {
  constructor(
    private readonly store: JsonCodeSpaceStore = getCodeSpaceStore(),
    private readonly limits: SchedulerLimits = { maxConcurrent: 3, maxAttempts: 3, maxWallClockMs: 30 * 60_000 },
  ) {}

  async enqueue(runId: string, packages: GovernedWorkPackage[]): Promise<ScheduledWorkRecord[]> {
    const now = Date.now();
    const records = packages.map((pkg) => ({
      id: `schedule:${runId}:${pkg.id}`,
      runId,
      packageId: pkg.id,
      status: pkg.status === 'ready' ? 'queued' : 'sleeping',
      attempts: 0,
      reason: pkg.status === 'ready' ? 'Ready for execution.' : 'Waiting for dependencies.',
      runAfter: now,
      heartbeatAt: now,
      updatedAt: now,
    }) satisfies ScheduledWorkRecord);
    await this.store.update((data) => {
      const retained = data.scheduledWork.filter((entry) => entry.runId !== runId);
      data.scheduledWork = [...retained, ...records];
    });
    return records;
  }

  async nextBatch(runId: string): Promise<ScheduledWorkRecord[]> {
    const data = await this.store.read();
    const running = data.scheduledWork.filter((item) => item.runId === runId && item.status === 'running').length;
    const available = Math.max(0, this.limits.maxConcurrent - running);
    if (available === 0) return [];
    const now = Date.now();
    return data.scheduledWork
      .filter((item) => item.runId === runId && item.status === 'queued' && (item.runAfter ?? 0) <= now && item.attempts < this.limits.maxAttempts)
      .sort((a, b) => (a.runAfter ?? 0) - (b.runAfter ?? 0))
      .slice(0, available);
  }

  async mark(runId: string, packageId: string, status: ScheduledWorkRecord['status'], reason: string): Promise<void> {
    await this.store.update((data) => {
      const record = data.scheduledWork.find((item) => item.runId === runId && item.packageId === packageId);
      if (!record) return;
      record.status = status;
      record.reason = reason;
      record.updatedAt = Date.now();
      record.heartbeatAt = Date.now();
      if (status === 'running') record.attempts += 1;
    });
  }

  async heartbeat(runId: string, packageId: string): Promise<void> {
    await this.store.update((data) => {
      const record = data.scheduledWork.find((item) => item.runId === runId && item.packageId === packageId);
      if (!record) return;
      record.heartbeatAt = Date.now();
      record.updatedAt = Date.now();
    });
  }
}

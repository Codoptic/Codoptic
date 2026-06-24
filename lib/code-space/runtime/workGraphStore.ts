import { getCodeSpaceStore, type JsonCodeSpaceStore } from './serverStore';
import type { PersistedWorkGraph } from './coworkingTypes';

export class WorkGraphStore {
  constructor(private readonly store: JsonCodeSpaceStore = getCodeSpaceStore()) {}

  async save(graph: PersistedWorkGraph): Promise<void> {
    await this.store.upsert('workGraphs', graph);
  }

  async getByRun(runId: string): Promise<PersistedWorkGraph | null> {
    const data = await this.store.read();
    return data.workGraphs.find((entry) => entry.runId === runId) ?? null;
  }

  async updatePackageStatus(runId: string, packageId: string, status: PersistedWorkGraph['packages'][number]['status']): Promise<PersistedWorkGraph | null> {
    let updated: PersistedWorkGraph | null = null;
    await this.store.update((data) => {
      const graph = data.workGraphs.find((entry) => entry.runId === runId);
      if (!graph) return;
      graph.packages = graph.packages.map((pkg) => (pkg.id === packageId ? { ...pkg, status, updatedAt: Date.now() } : pkg));
      graph.updatedAt = Date.now();
      updated = graph;
    });
    return updated;
  }
}

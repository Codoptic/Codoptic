import type { WorkGraph, WorkPackage } from './agentOrchestrator';

export function assertPersistableWorkGraph(graph: WorkGraph): void {
  for (const pkg of graph.packages) {
    assertPersistableWorkPackage(pkg);
  }
}

export function assertPersistableWorkPackage(pkg: WorkPackage): void {
  const hasDeps = Array.isArray(pkg.dependencies) && pkg.dependencies.length > 0;
  if (!hasDeps && !pkg.independent) {
    throw new Error(`Work package ${pkg.id} must set dependencies or independent: true.`);
  }
}

export function normalizeProposedPackage(pkg: WorkPackage): WorkPackage {
  const hasDeps = Array.isArray(pkg.dependencies) && pkg.dependencies.length > 0;
  return {
    ...pkg,
    independent: hasDeps ? false : pkg.independent === true,
  };
}

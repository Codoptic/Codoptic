import type { ContextGraphResult } from './contextGraphEngine';
import type { TerminalCommand } from './terminalPolicy';
import type { SubagentResult, SubagentRole } from './subagentRunner';
import { runtimeScaleLimits, type RuntimeScaleLimits, type RuntimeScaleProfile } from './scaleProfile';

export interface WorkPackage {
  id: string;
  role: SubagentRole;
  title: string;
  task: string;
  readOnly: boolean;
  maxToolCalls: number;
  dependencies: string[];
  /** Required when dependencies are empty so the scheduler can start the package. */
  independent?: boolean;
  depth: number;
  reason: string;
}

export interface WorkGraph {
  runId: string;
  profile: RuntimeScaleProfile;
  packages: WorkPackage[];
  createdAt: number;
  limits: RuntimeScaleLimits;
}

export interface ReconciliationReport {
  graph: WorkGraph;
  results: SubagentResult[];
  reconciled: boolean;
  continuationNeeded: boolean;
  continuationReason?: string;
}

export class AgentOrchestrator {
  constructor(profile: RuntimeScaleProfile | unknown = 'deep', ..._legacyArgs: unknown[]) {
    this.profile = typeof profile === 'string' ? (profile as RuntimeScaleProfile) : 'deep';
  }

  private readonly profile: RuntimeScaleProfile;

  async run(_run: unknown, _projectRoot: string, _projectName: string, _options: { openTabs?: string[] } = {}): Promise<void> {
    // Legacy RunManager compatibility. The modern app route uses AgentRuntime directly; this class
    // now owns scalable work-graph orchestration rather than full streaming execution.
  }

  buildWorkGraph(input: {
    runId: string;
    prompt: string;
    context: ContextGraphResult;
    validationCommands: TerminalCommand[];
    mode: 'ask' | 'plan' | 'code';
  }): WorkGraph {
    const limits = runtimeScaleLimits(this.profile, input.mode);
    // Automatic heuristic spawn is off. The parent may spawn_subagent or propose_work_graph.
    return { runId: input.runId, profile: this.profile, packages: [], createdAt: Date.now(), limits };
  }

  reconcile(graph: WorkGraph, results: SubagentResult[]): ReconciliationReport {
    const completedIds = new Set(results.map((_, index) => graph.packages[index]?.id).filter((id): id is string => Boolean(id)));
    const missing = graph.packages.filter((pkg) => !completedIds.has(pkg.id));
    const failed = results.filter((result) => !result.success);
    const continuationNeeded = missing.length > 0;
    return {
      graph,
      results,
      reconciled: missing.length === 0,
      continuationNeeded,
      continuationReason: continuationNeeded ? `${missing.length} work package(s) remain queued for continuation.` : failed.length ? `${failed.length} subagent(s) reported failure.` : undefined,
    };
  }
}

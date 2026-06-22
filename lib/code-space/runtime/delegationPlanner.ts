import type { ContextGraphResult } from './contextGraphEngine';
import type { TerminalCommand } from './terminalPolicy';
import type { SubagentResult, SubagentRole, SubagentSpawnRequest } from './subagentRunner';
import { AgentOrchestrator, type WorkGraph } from './agentOrchestrator';
import { normalizeRuntimeScaleProfile, type RuntimeScaleProfile } from './scaleProfile';

export interface DelegationTask {
  id: string;
  role: SubagentRole;
  task: string;
  readOnly: boolean;
  maxToolCalls: number;
  reason: string;
}

export interface DelegationPlan {
  required: boolean;
  reasons: string[];
  tasks: DelegationTask[];
  workGraph?: WorkGraph;
}

export interface DelegationReport {
  plan: DelegationPlan;
  results: SubagentResult[];
  reconciled: boolean;
}

export class DelegationPlanner {
  constructor(private readonly profile: RuntimeScaleProfile = 'deep') {}

  plan(input: {
    runId?: string;
    prompt: string;
    context: ContextGraphResult;
    validationCommands: TerminalCommand[];
    mode: 'ask' | 'plan' | 'code';
    scaleProfile?: RuntimeScaleProfile;
  }): DelegationPlan {
    if (input.mode !== 'code') return { required: false, reasons: [], tasks: [] };
    const scaleProfile = normalizeRuntimeScaleProfile(input.scaleProfile ?? this.profile, input.mode);
    const graph = new AgentOrchestrator(scaleProfile).buildWorkGraph({
      runId: input.runId ?? 'auto',
      prompt: input.prompt,
      context: input.context,
      validationCommands: input.validationCommands,
      mode: input.mode,
    });
    if (!graph.packages.length) return { required: false, reasons: [], tasks: [], workGraph: graph };

    const reasons = Array.from(new Set(graph.packages.map((pkg) => pkg.reason)));
    const tasks: DelegationTask[] = graph.packages.map((pkg) => ({
      id: pkg.id,
      role: pkg.role,
      readOnly: pkg.readOnly,
      maxToolCalls: pkg.maxToolCalls,
      reason: pkg.reason,
      task: pkg.task,
    }));

    return {
      required: true,
      reasons,
      tasks,
      workGraph: graph,
    };
  }
}

export function formatDelegationReport(report?: DelegationReport): string {
  if (!report || !report.plan.required) return 'Automatic delegation: not required for this run.';
  const results = report.results.length
    ? report.results.map((result) => `- ${result.role}: ${result.success ? 'completed' : 'failed'} — ${result.summary}`).join('\n')
    : '- No subagent results were produced.';
  return [
    `Automatic delegation ran ${report.results.length}/${report.plan.tasks.length} subagent(s).`,
    `Reasons: ${report.plan.reasons.join('; ')}.`,
    'Subagent findings for parent reconciliation:',
    results,
    report.reconciled ? 'Parent reconciliation: complete.' : 'Parent reconciliation: pending.',
  ].join('\n');
}

export function toSubagentRequest(task: DelegationTask): SubagentSpawnRequest {
  return {
    role: task.role,
    task: task.task,
    readOnly: task.readOnly,
    maxToolCalls: task.maxToolCalls,
  };
}

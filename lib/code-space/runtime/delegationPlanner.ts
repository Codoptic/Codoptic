import type { ContextGraphResult } from './contextGraphEngine';
import type { TerminalCommand } from './terminalPolicy';
import type { SubagentResult, SubagentRole, SubagentSpawnRequest } from './subagentRunner';

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
}

export interface DelegationReport {
  plan: DelegationPlan;
  results: SubagentResult[];
  reconciled: boolean;
}

const MAX_AUTOMATIC_SUBAGENTS = 3;

export class DelegationPlanner {
  plan(input: {
    prompt: string;
    context: ContextGraphResult;
    validationCommands: TerminalCommand[];
    mode: 'ask' | 'plan' | 'code';
  }): DelegationPlan {
    if (input.mode !== 'code') return { required: false, reasons: [], tasks: [] };

    const prompt = input.prompt.toLowerCase();
    const reasons: string[] = [];
    const selected = input.context.selectedFiles.length;
    const testCandidates = input.context.testCandidates.length;
    const validationHeavy =
      testCandidates >= 3 ||
      /\b(test(?:ing)?|validation|verify|e2e|build|typecheck|lint|ci|regression)\b/.test(prompt);
    const docsHeavy = /\b(docs?|readme|research|convention|migration|api|sdk|workflow|memory|subagent|agent)\b/.test(prompt);

    if (selected >= 18) reasons.push(`large context set (${selected} selected files)`);
    if (testCandidates >= 3 || validationHeavy) reasons.push('validation-heavy task');
    if (docsHeavy) reasons.push('docs/research-heavy task');
    if (/\b(complex|comprehensively|deep|review|architecture|workflow|orchestrat|multi[-\s]?file|across)\b/.test(prompt)) reasons.push('explicit complex/deep-review request');
    if (input.context.missingContextWarnings.length) reasons.push('ambiguous integration surface');

    if (!reasons.length) return { required: false, reasons: [], tasks: [] };

    const tasks: DelegationTask[] = [
      {
        id: 'auto:explorer',
        role: 'explorer',
        readOnly: true,
        maxToolCalls: 10,
        reason: 'independent repository investigation',
        task: [
          'Independently inspect the repository surfaces relevant to this task and report concrete files, symbols, call sites, and risks.',
          `Task: ${input.prompt}`,
          `Initial selected files: ${input.context.selectedFiles.slice(0, 16).join(', ') || '(none)'}.`,
          'Do not edit files. Keep the summary factual and concise.',
        ].join('\n'),
      },
    ];

    if (docsHeavy) {
      tasks.push({
        id: 'auto:docs-reader',
        role: 'docs-reader',
        readOnly: true,
        maxToolCalls: 8,
        reason: 'documentation and conventions scan',
        task: [
          'Read project documentation, instruction files, and nearby comments that constrain this task.',
          `Task: ${input.prompt}`,
          'Report conventions, constraints, and any durable context the parent agent should honor. Do not edit files.',
        ].join('\n'),
      });
    }

    tasks.push({
      id: 'auto:critic',
      role: validationHeavy ? 'verifier' : 'critic',
      readOnly: true,
      maxToolCalls: 8,
      reason: validationHeavy ? 'independent validation risk review' : 'independent implementation critique',
      task: [
        validationHeavy
          ? 'Review the likely validation/test risks for this task and recommend exact checks the parent should run.'
          : 'Critically review the likely implementation plan and identify gaps, regressions, or missing test/docs surfaces.',
        `Task: ${input.prompt}`,
        `Relevant validation commands: ${input.validationCommands.map((command) => [command.command, ...command.args].join(' ')).join(', ') || '(none detected)'}.`,
        'Do not edit files. Return blockers and concrete recommendations only.',
      ].join('\n'),
    });

    return {
      required: true,
      reasons,
      tasks: tasks.slice(0, MAX_AUTOMATIC_SUBAGENTS),
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

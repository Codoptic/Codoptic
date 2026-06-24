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
    if (input.mode !== 'code') {
      return { runId: input.runId, profile: this.profile, packages: [], createdAt: Date.now(), limits };
    }

    const prompt = input.prompt.toLowerCase();
    const selected = input.context.selectedFiles.length;
    const validationHeavy = input.context.testCandidates.length >= 3 || /\b(test(?:ing)?|validation|verify|e2e|build|typecheck|lint|ci|regression)\b/.test(prompt);
    const docsHeavy = /\b(docs?|readme|research|convention|migration|api|sdk|workflow|memory|subagent|agent)\b/.test(prompt);
    const uiHeavy = /\b(ui|ux|browser|preview|layout|responsive|click|scroll|screenshot|website|web app|frontend)\b/.test(prompt);
    const securityHeavy = /\b(security|secret|permission|sandbox|approval|policy|risk|destructive|auth)\b/.test(prompt);
    const massive = selected >= 18 || /\b(complex|comprehensively|deep|massive|huge|large|architecture|workflow|orchestrat|multi[-\s]?file|across|refactor)\b/.test(prompt);
    const needsDelegation = massive || validationHeavy || docsHeavy || uiHeavy || securityHeavy || input.context.missingContextWarnings.length > 0;
    if (!needsDelegation) {
      return { runId: input.runId, profile: this.profile, packages: [], createdAt: Date.now(), limits };
    }

    const packages: WorkPackage[] = [];
    const add = (role: SubagentRole, title: string, task: string, reason: string, readOnly = true, depth = 0) => {
      if (packages.length >= limits.maxWorkPackages || depth > limits.maxDepth) return;
      packages.push({
        id: `work:${input.runId}:${packages.length + 1}:${role}`,
        role,
        title,
        task,
        readOnly,
        dependencies: [],
        depth,
        reason,
        maxToolCalls: limits.maxSubagentToolCalls,
      });
    };

    add(
      'explorer',
      'Repository exploration',
      [
        'Independently inspect relevant repository surfaces and report concrete files, symbols, call sites, risks, and missing evidence.',
        `Task: ${input.prompt}`,
        `Initial selected files: ${input.context.selectedFiles.slice(0, 24).join(', ') || '(none)'}.`,
        'This helper is advisory: do not edit files. The parent Code-mode implementer may still apply source changes after reconciling your findings.',
      ].join('\n'),
      'independent repository investigation',
    );
    if (docsHeavy || this.profile !== 'standard') {
      add(
        'docs-reader',
        'Documentation and convention scan',
        `Read instructions, docs, README files, and nearby comments that constrain this task.\nTask: ${input.prompt}\nThis helper is advisory: do not edit files. The parent Code-mode implementer may still apply source changes after reconciling your findings.`,
        'documentation and conventions scan',
      );
    }
    add(
      validationHeavy ? 'verifier' : 'critic',
      validationHeavy ? 'Validation risk review' : 'Implementation critique',
      [
        validationHeavy ? 'Review likely validation/test risks and recommend exact checks.' : 'Critically review the likely implementation plan and identify gaps.',
        `Task: ${input.prompt}`,
        `Relevant validation commands: ${input.validationCommands.map((command) => [command.command, ...command.args].join(' ')).join(', ') || '(none detected)'}.`,
        validationHeavy
          ? 'Run non-destructive validation commands when useful and report exact output. Do not edit source files.'
          : 'This helper is advisory: do not edit source files. The parent Code-mode implementer may still apply source changes after reconciling your findings.',
      ].join('\n'),
      validationHeavy ? 'independent validation risk review' : 'independent implementation critique',
      validationHeavy ? false : true,
    );
    if (uiHeavy) add('ui-reviewer', 'Browser and UI review', `Inspect likely browser/UI risks for this task and recommend preview interactions/screenshots.\nTask: ${input.prompt}`, 'browser/UI review');
    if (securityHeavy) add('security-reviewer', 'Security and permission review', `Inspect permission, terminal, sandbox, secret, and risky-command implications.\nTask: ${input.prompt}`, 'security review');
    if (massive && this.profile !== 'standard') add('planner', 'Work breakdown', `Break the task into implementation-safe packages, dependencies, and validation gates.\nTask: ${input.prompt}`, 'large task decomposition');
    if (massive && (this.profile === 'massive' || this.profile === 'full_access_local')) {
      add('integration-owner', 'Integration ownership review', `Identify cross-cutting integration seams and final reconciliation gates.\nTask: ${input.prompt}`, 'integration ownership');
      add('refactorer', 'Refactor risk scan', `Find refactor blast-radius risks and call sites that must move together.\nTask: ${input.prompt}`, 'refactor blast-radius scan');
    }

    return { runId: input.runId, profile: this.profile, packages: packages.slice(0, limits.maxAutomaticSubagents), createdAt: Date.now(), limits };
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

import type { SubagentRole } from './subagentRunner';
import type { GovernedWorkPackage, RolePolicy, SubagentDeliverable } from './coworkingTypes';
import type { WorkGraph, WorkPackage } from './agentOrchestrator';

const READ_TOOLS = ['read_file', 'list_files', 'search_text', 'repo_map', 'dependency_trace', 'git_status', 'git_diff', 'read_artifact', 'grep_artifact'];
const REVIEW_TOOLS = [...READ_TOOLS, 'run_command', 'browser_open', 'browser_screenshot', 'browser_console'];

export const ROLE_POLICIES: Record<SubagentRole, RolePolicy> = {
  planner: {
    role: 'planner',
    allowedTools: [...READ_TOOLS, 'harness_context', 'research_web'],
    forbiddenTools: ['edit_file', 'restore_checkpoint'],
    expectedOutputs: ['status', 'evidence', 'handoffNotes', 'confidence'],
    maxAutonomy: 'suggest_only',
    escalationTriggers: ['ambiguous scope', 'missing product decision', 'dependency conflict'],
    requiresEvidence: true,
  },
  explorer: {
    role: 'explorer',
    allowedTools: READ_TOOLS,
    forbiddenTools: ['edit_file', 'run_command'],
    expectedOutputs: ['status', 'evidence', 'handoffNotes', 'confidence'],
    maxAutonomy: 'suggest_only',
    escalationTriggers: ['missing files', 'unreadable dependency'],
    requiresEvidence: true,
  },
  critic: {
    role: 'critic',
    allowedTools: READ_TOOLS,
    forbiddenTools: ['edit_file'],
    expectedOutputs: ['status', 'evidence', 'blockers', 'confidence'],
    maxAutonomy: 'suggest_only',
    escalationTriggers: ['unreviewed risk', 'partial implementation'],
    requiresEvidence: true,
  },
  'docs-reader': {
    role: 'docs-reader',
    allowedTools: [...READ_TOOLS, 'harness_context', 'research_web'],
    forbiddenTools: ['edit_file'],
    expectedOutputs: ['status', 'evidence', 'handoffNotes'],
    maxAutonomy: 'suggest_only',
    escalationTriggers: ['conflicting docs', 'missing instructions'],
    requiresEvidence: true,
  },
  'test-writer': {
    role: 'test-writer',
    allowedTools: [...READ_TOOLS, 'edit_file', 'run_command'],
    forbiddenTools: ['restore_checkpoint'],
    expectedOutputs: ['status', 'changedFiles', 'evidence', 'validationRequested'],
    maxAutonomy: 'auto_safe_tools',
    escalationTriggers: ['test cannot be isolated', 'fixture unavailable'],
    requiresEvidence: true,
  },
  verifier: {
    role: 'verifier',
    allowedTools: REVIEW_TOOLS,
    forbiddenTools: ['edit_file', 'restore_checkpoint'],
    expectedOutputs: ['status', 'evidence', 'blockers', 'validationRequested'],
    maxAutonomy: 'auto_safe_tools',
    escalationTriggers: ['validation cannot run', 'same failure repeated'],
    requiresEvidence: true,
  },
  implementer: {
    role: 'implementer',
    allowedTools: [...READ_TOOLS, 'edit_file', 'run_command'],
    forbiddenTools: ['restore_checkpoint'],
    expectedOutputs: ['status', 'changedFiles', 'evidence', 'handoffNotes'],
    maxAutonomy: 'auto_safe_tools',
    escalationTriggers: ['cross-package edit', 'ownership conflict', 'destructive action'],
    requiresEvidence: true,
  },
  refactorer: {
    role: 'refactorer',
    allowedTools: READ_TOOLS,
    forbiddenTools: ['edit_file'],
    expectedOutputs: ['status', 'evidence', 'blockers', 'handoffNotes'],
    maxAutonomy: 'suggest_only',
    escalationTriggers: ['large blast radius', 'public API change'],
    requiresEvidence: true,
  },
  'ui-reviewer': {
    role: 'ui-reviewer',
    allowedTools: REVIEW_TOOLS,
    forbiddenTools: ['edit_file'],
    expectedOutputs: ['status', 'evidence', 'blockers'],
    maxAutonomy: 'auto_safe_tools',
    escalationTriggers: ['missing browser evidence', 'accessibility regression'],
    requiresEvidence: true,
  },
  'security-reviewer': {
    role: 'security-reviewer',
    allowedTools: READ_TOOLS,
    forbiddenTools: ['edit_file', 'run_command'],
    expectedOutputs: ['status', 'evidence', 'blockers'],
    maxAutonomy: 'suggest_only',
    escalationTriggers: ['secret exposure', 'unsafe command', 'permission expansion'],
    requiresEvidence: true,
  },
  'integration-owner': {
    role: 'integration-owner',
    allowedTools: REVIEW_TOOLS,
    forbiddenTools: ['restore_checkpoint'],
    expectedOutputs: ['status', 'evidence', 'blockers', 'handoffNotes'],
    maxAutonomy: 'auto_safe_tools',
    escalationTriggers: ['dependency conflict', 'unreconciled package', 'missing validation'],
    requiresEvidence: true,
  },
};

export class SubagentGovernor {
  policyFor(role: SubagentRole): RolePolicy {
    return ROLE_POLICIES[role] ?? ROLE_POLICIES.explorer;
  }

  governPackage(pkg: WorkPackage, graph: WorkGraph): GovernedWorkPackage {
    const highRisk = pkg.role === 'implementer' || pkg.role === 'refactorer' || graph.profile === 'full_access_local';
    const validation = pkg.role === 'verifier' || pkg.role === 'test-writer' ? ['Run package-specific validation and report exact output.'] : [];
    return {
      ...pkg,
      status: pkg.dependencies.length ? 'queued' : 'ready',
      goal: pkg.title || pkg.reason || pkg.task.slice(0, 120),
      acceptanceCriteria: [
        'Return a typed deliverable with status, evidence, blockers, handoff notes, requested validation, and confidence.',
        pkg.readOnly ? 'Do not edit source files.' : 'Edit only package-owned files.',
      ],
      validation,
      risk: highRisk ? 'high' : pkg.role === 'ui-reviewer' || pkg.role === 'security-reviewer' ? 'medium' : 'low',
      expectedArtifacts: this.policyFor(pkg.role).requiresEvidence ? ['evidence'] : [],
      blockerCriteria: this.policyFor(pkg.role).escalationTriggers,
      ownership: {
        ownerRole: pkg.role,
        allowedPaths: inferAllowedPaths(pkg.task),
        forbiddenPaths: ['.git/**', 'node_modules/**', '.next/**', 'package-lock.json'],
        requiresReview: highRisk,
        reviewerRole: highRisk ? 'integration-owner' : undefined,
      },
      updatedAt: Date.now(),
    };
  }

  readyPackages(packages: GovernedWorkPackage[]): GovernedWorkPackage[] {
    const done = new Set(packages.filter((pkg) => pkg.status === 'done').map((pkg) => pkg.id));
    return packages.filter((pkg) => pkg.status === 'ready' || (pkg.status === 'queued' && pkg.dependencies.every((dependency) => done.has(dependency))));
  }

  validateDeliverable(pkg: GovernedWorkPackage, deliverable: SubagentDeliverable): { ok: boolean; issues: string[] } {
    const issues: string[] = [];
    if (deliverable.packageId !== pkg.id) issues.push(`Deliverable package ${deliverable.packageId} does not match ${pkg.id}.`);
    if (deliverable.role !== pkg.role) issues.push(`Deliverable role ${deliverable.role} does not match owner ${pkg.role}.`);
    if (this.policyFor(pkg.role).requiresEvidence && deliverable.evidence.length === 0) issues.push('Deliverable has no evidence.');
    for (const file of deliverable.changedFiles) {
      if (isForbidden(file, pkg.ownership.forbiddenPaths)) issues.push(`Changed file is forbidden for this package: ${file}`);
      if (!isAllowed(file, pkg.ownership.allowedPaths)) issues.push(`Changed file is outside package ownership: ${file}`);
    }
    if (deliverable.status === 'done' && deliverable.blockers.length) issues.push('Done deliverables cannot include unresolved blockers.');
    return { ok: issues.length === 0, issues };
  }
}

function inferAllowedPaths(task: string): string[] {
  const matches = task.match(/(?:^|[\s`'"])([A-Za-z0-9_.@/-]+\.(?:ts|tsx|js|jsx|css|scss|md|json|py|yml|yaml))(?:$|[\s`'",.])/g) ?? [];
  const paths = matches.map((match) => match.trim().replace(/^[`'"]|[`'",.]$/g, ''));
  return paths.length ? paths : ['**'];
}

function isForbidden(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -3)) : file === pattern);
}

function isAllowed(file: string, patterns: string[]): boolean {
  return patterns.includes('**') || patterns.some((pattern) => file === pattern || file.startsWith(pattern.replace(/\*\*$/, '')));
}

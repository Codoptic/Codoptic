import type { CoherenceFinding } from './integrationVerifier';
import type { ValidationRunResult } from './validationRunner';
import type { SubagentResult } from './subagentRunner';
import type { ImplementationContract } from '@/lib/code-space/core';
import { contractBlockers } from './implementationContract';

export interface SupervisorVerdict {
  status: 'verified' | 'needs_review';
  blockers: string[];
  summary: string;
}

export interface SupervisorInput {
  ledgerSize: number;
  coherence: CoherenceFinding[];
  validationRuns: ValidationRunResult[];
  unresolvedEditFailures: string;
  subagentResults?: SubagentResult[];
  delegationRequired?: boolean;
  delegationReconciled?: boolean;
  implementationContract?: ImplementationContract;
  browserEvidenceRequired?: boolean;
  browserEvidenceCount?: number;
}

/**
 * Reconcile-before-confirm gate. The run is only `verified` when EVERY gate passes:
 * concrete changes exist, no validation stage failed, integration review is clean, no
 * unresolved edit failures, and no required subagent reported failure. Advisory helper
 * failures that only reflect optional tooling or scoped read-only policy stay as
 * reconciliation notes rather than blocking the parent implementation run.
 */
export class Supervisor {
  reconcile(input: SupervisorInput): SupervisorVerdict {
    const blockers: string[] = [];

    if (input.ledgerSize === 0) {
      blockers.push('No files were changed — implementation runs must produce concrete changes.');
    }

    const failedValidation = input.validationRuns.filter((run) => run.status === 'failed');
    if (failedValidation.length) {
      blockers.push(`Validation failed: ${failedValidation.map((run) => run.command).join(', ')}.`);
    }

    const skippedValidation = input.validationRuns.filter((run) => run.status === 'skipped');
    const onlyManualValidationSkipped =
      skippedValidation.length === input.validationRuns.length &&
      skippedValidation.length === 1 &&
      /manual review/i.test(skippedValidation[0]?.command ?? '');
    if (skippedValidation.length && !onlyManualValidationSkipped) {
      blockers.push(`Validation skipped: ${skippedValidation.map((run) => run.command).join(', ')}.`);
    }

    if (input.coherence.length) {
      const preview = input.coherence.slice(0, 5).map((finding) => `${finding.path} (${finding.kind})`).join(', ');
      blockers.push(`Integration review found ${input.coherence.length} issue(s): ${preview}.`);
    }

    if (input.unresolvedEditFailures.trim()) {
      blockers.push('Unresolved edit_file failures remain on at least one file.');
    }

    const failedSubagents = (input.subagentResults ?? []).filter((result) => !result.success && !isNonBlockingAdvisoryFailure(result));
    if (failedSubagents.length) {
      blockers.push(`Subagent(s) reported failure: ${failedSubagents.map((result) => result.role).join(', ')}.`);
    }
    if (input.delegationRequired && !input.delegationReconciled) {
      blockers.push('Automatic subagent delegation was required but not reconciled by the parent agent.');
    }
    if (input.browserEvidenceRequired && !input.browserEvidenceCount) {
      blockers.push('Browser/UI work requires preview evidence: at least one screenshot plus console/network inspection.');
    }

    blockers.push(...contractBlockers(input.implementationContract));

    const status: SupervisorVerdict['status'] = blockers.length ? 'needs_review' : 'verified';
    return {
      status,
      blockers,
      summary: status === 'verified' ? 'All gates passed: changes applied, integration review clean, validation green.' : blockers.join(' '),
    };
  }
}

function isNonBlockingAdvisoryFailure(result: SubagentResult): boolean {
  if (!result.advisory) return false;
  return /not a git repository|not git-managed|policy[- ]blocked|read[- ]only|do not edit|cannot modify|forbids tool execution|requires explicit approval|unavailable|not installed|missing optional/i.test(result.summary);
}

import type { CoverageEvidence, ImplementationContract } from '@/lib/code-space/core';

export interface RequirementEvidenceTarget {
  requirementIds: string[];
  evidence: CoverageEvidence;
}

export function emptyRequirementEvidenceTarget(contract: ImplementationContract, evidence: CoverageEvidence): RequirementEvidenceTarget {
  return {
    requirementIds: contract.requirements.length === 1 ? [contract.requirements[0]!.id] : [],
    evidence,
  };
}

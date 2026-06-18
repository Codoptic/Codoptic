import { createHash } from 'node:crypto';
import type {
  CoverageEvidence,
  CoverageEvidenceKind,
  ImplementationContract,
  PatchHistoryEntry,
  PlanRequirement,
} from '@/lib/code-space/core';
import type { ValidationRunResult } from './validationRunner';

const MAX_REQUIREMENTS = 24;

export function createImplementationContract(prompt: string, planMarkdown = ''): ImplementationContract {
  const now = Date.now();
  const requirements = [
    ...extractRequirementTexts(prompt, 'original_intent'),
    ...extractRequirementTexts(planMarkdown, 'plan'),
  ];
  const deduped = dedupeRequirements(requirements).slice(0, MAX_REQUIREMENTS);
  return {
    id: `contract:${hashText(`${prompt}\n${planMarkdown}`).slice(0, 12)}`,
    sourcePromptHash: hashText(prompt),
    createdAt: now,
    updatedAt: now,
    requirements: deduped.map((item, index) => ({
      id: `req:${index + 1}`,
      text: item.text,
      source: item.source,
      status: 'pending',
      evidence: [],
    })),
  };
}

export function addCoverageEvidence(
  contract: ImplementationContract | undefined,
  evidence: Omit<CoverageEvidence, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
): ImplementationContract | undefined {
  if (!contract) return undefined;
  const now = evidence.createdAt ?? Date.now();
  const normalized: CoverageEvidence = {
    ...evidence,
    id: evidence.id ?? `evidence:${now}:${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
  };
  const requirements = contract.requirements.map((requirement) => ({
    ...requirement,
    status: requirement.status === 'blocked' ? requirement.status : 'covered' as const,
    evidence: [...requirement.evidence, normalized],
  }));
  return { ...contract, requirements, updatedAt: now };
}

export function addPatchCoverage(contract: ImplementationContract | undefined, patch: PatchHistoryEntry): ImplementationContract | undefined {
  return addCoverageEvidence(contract, {
    kind: 'patch',
    summary: `${patch.mode} ${patch.filePath} (+${patch.added}/-${patch.removed})`,
    filePath: patch.filePath,
    status: patch.status === 'applied' ? 'applied' : 'pending',
  });
}

export function addValidationCoverage(contract: ImplementationContract | undefined, result: ValidationRunResult): ImplementationContract | undefined {
  return addCoverageEvidence(contract, {
    kind: 'validation',
    summary: `${result.command}: ${result.status}`,
    command: result.command,
    status: result.status,
  });
}

export function contractBlockers(contract: ImplementationContract | undefined): string[] {
  if (!contract || contract.requirements.length === 0) return [];
  const uncovered = contract.requirements.filter((requirement) => requirement.status === 'pending' || requirement.evidence.length === 0);
  if (!uncovered.length) return [];
  return [
    `Implementation contract has ${uncovered.length} uncovered requirement(s): ${uncovered
      .slice(0, 5)
      .map((requirement) => requirement.id)
      .join(', ')}.`,
  ];
}

export function summarizeContract(contract: ImplementationContract | undefined): string {
  if (!contract || contract.requirements.length === 0) return 'No explicit implementation requirements were extracted.';
  const covered = contract.requirements.filter((requirement) => requirement.status === 'covered').length;
  const blocked = contract.requirements.filter((requirement) => requirement.status === 'blocked').length;
  return `${covered}/${contract.requirements.length} requirement(s) covered${blocked ? `, ${blocked} blocked` : ''}.`;
}

function extractRequirementTexts(source: string, kind: PlanRequirement['source']): Array<Pick<PlanRequirement, 'text' | 'source'>> {
  if (!source.trim()) return [];
  const lines = source.split(/\r?\n/);
  const requirements: Array<Pick<PlanRequirement, 'text' | 'source'>> = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const checkbox = line.match(/^[-*]\s+\[[ xX]\]\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    const text = checkbox?.[1] ?? bullet?.[1] ?? numbered?.[1] ?? heading?.[1] ?? '';
    if (!text) continue;
    if (isNoiseRequirement(text)) continue;
    requirements.push({ text: cleanRequirement(text), source: kind });
  }

  if (!requirements.length && kind === 'original_intent') {
    const compact = cleanRequirement(source).slice(0, 280);
    if (compact) requirements.push({ text: compact, source: kind });
  }
  return requirements;
}

function dedupeRequirements(requirements: Array<Pick<PlanRequirement, 'text' | 'source'>>): Array<Pick<PlanRequirement, 'text' | 'source'>> {
  const seen = new Set<string>();
  const out: Array<Pick<PlanRequirement, 'text' | 'source'>> = [];
  for (const requirement of requirements) {
    const key = requirement.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(requirement);
  }
  return out;
}

function cleanRequirement(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/^`|`$/g, '').trim();
}

function isNoiseRequirement(text: string): boolean {
  return /^(summary|assumptions|test plan|key changes|interfaces and types|research basis)$/i.test(text.trim());
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function coverageEvidence(kind: CoverageEvidenceKind, summary: string): CoverageEvidence {
  const createdAt = Date.now();
  return { id: `evidence:${createdAt}:${Math.random().toString(36).slice(2, 8)}`, kind, summary, createdAt };
}

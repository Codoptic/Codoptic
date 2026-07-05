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
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'that',
  'this',
  'then',
  'than',
  'must',
  'should',
  'could',
  'will',
  'have',
  'has',
  'are',
  'was',
  'were',
  'been',
  'code',
  'space',
]);

type CoverageInput = Omit<CoverageEvidence, 'id' | 'createdAt'> & {
  id?: string;
  createdAt?: number;
  /** Optional explicit requirement targeting for future plan-contract execution. */
  requirementIds?: string[];
};

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
  evidence: CoverageInput,
): ImplementationContract | undefined {
  if (!contract) return undefined;
  const now = evidence.createdAt ?? Date.now();
  const normalized: CoverageEvidence = {
    ...evidence,
    id: evidence.id ?? `evidence:${now}:${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
  };
  const targetIds = resolveEvidenceTargets(contract, normalized, evidence.requirementIds);
  if (!targetIds.size) return contract;

  const requirements = contract.requirements.map((requirement) => {
    if (!targetIds.has(requirement.id)) return requirement;
    return {
      ...requirement,
      status: nextRequirementStatus(requirement.status, normalized),
      evidence: [...requirement.evidence, normalized],
    };
  });

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

function resolveEvidenceTargets(
  contract: ImplementationContract,
  evidence: CoverageEvidence,
  explicitRequirementIds?: string[],
): Set<string> {
  const requirementIds = new Set(contract.requirements.map((requirement) => requirement.id));
  const explicit = (explicitRequirementIds ?? []).filter((id) => requirementIds.has(id));
  if (explicit.length) return new Set(explicit);

  if (contract.requirements.length === 1) return new Set([contract.requirements[0]!.id]);

  const directMatches = contract.requirements.filter((requirement) => evidenceMatchesRequirement(requirement, evidence));
  if (directMatches.length) return new Set(directMatches.map((requirement) => requirement.id));

  if (evidence.kind === 'validation' && evidence.status === 'passed') {
    const patched = contract.requirements.filter((requirement) =>
      requirement.evidence.some((item) => item.kind === 'patch' && item.status === 'applied'),
    );
    if (patched.length) return new Set(patched.map((requirement) => requirement.id));
  }

  return new Set();
}

function evidenceMatchesRequirement(requirement: PlanRequirement, evidence: CoverageEvidence): boolean {
  const requirementText = requirement.text.toLowerCase();
  const evidenceText = [evidence.summary, evidence.filePath, evidence.command].filter(Boolean).join(' ').toLowerCase();
  if (!evidenceText.trim()) return false;

  if (evidence.filePath && pathMatchesRequirement(requirementText, evidence.filePath)) return true;
  if (evidence.command && commandMatchesRequirement(requirementText, evidence.command)) return true;

  const requirementTokens = tokenizeForMatching(requirement.text);
  const evidenceTokens = tokenizeForMatching(evidenceText);
  const overlap = Array.from(evidenceTokens).filter((token) => requirementTokens.has(token));
  return overlap.length >= 2 || overlap.some((token) => token.length >= 10);
}

function pathMatchesRequirement(requirementText: string, filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
  if (requirementText.includes(normalizedPath)) return true;

  const basename = normalizedPath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? normalizedPath;
  const pathTokens = tokenizeForMatching([normalizedPath, basename, splitIdentifier(basename)].join(' '));
  const requirementTokens = tokenizeForMatching(requirementText);
  const overlap = Array.from(pathTokens).filter((token) => requirementTokens.has(token));
  return overlap.length >= 2 || overlap.some((token) => token.length >= 10);
}

function commandMatchesRequirement(requirementText: string, command: string): boolean {
  const commandTokens = tokenizeForMatching(command);
  const requirementTokens = tokenizeForMatching(requirementText);
  const overlap = Array.from(commandTokens).filter((token) => requirementTokens.has(token));
  return overlap.length >= 2;
}

function nextRequirementStatus(
  current: PlanRequirement['status'],
  evidence: CoverageEvidence,
): PlanRequirement['status'] {
  if (current === 'blocked') return current;
  if (evidence.kind === 'blocker') return 'blocked';
  if (evidence.kind === 'patch') return evidence.status === 'applied' ? 'covered' : current;
  if (evidence.kind === 'validation') return evidence.status === 'passed' ? 'covered' : current;
  if (evidence.status === 'passed' || evidence.status === 'applied') return 'covered';
  return current;
}

function tokenizeForMatching(value: string): Set<string> {
  const expanded = splitIdentifier(value);
  const tokens = expanded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

function splitIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
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

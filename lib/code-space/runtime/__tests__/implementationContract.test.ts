import { describe, expect, it } from 'vitest';
import {
  addPatchCoverage,
  addValidationCoverage,
  contractBlockers,
  createImplementationContract,
} from '../implementationContract';
import type { PatchHistoryEntry } from '@/lib/code-space/core';
import type { ValidationRunResult } from '../validationRunner';

function patch(filePath: string, status: PatchHistoryEntry['status'] = 'applied'): PatchHistoryEntry {
  return {
    patchId: `patch:${filePath}`,
    batchId: 'batch:test',
    filePath,
    mode: status === 'applied' ? 'applied' : 'proposed',
    status,
    added: 8,
    removed: 2,
    diff: '',
    createdAt: 1,
  };
}

function validation(status: ValidationRunResult['status'] = 'passed'): ValidationRunResult {
  return {
    kind: 'test',
    command: 'npm test',
    status,
    output: '',
    durationMs: 1,
  };
}

describe('implementation contract coverage', () => {
  it('covers only the requirement matched by a patch path', () => {
    const contract = createImplementationContract([
      '- Fix implementation contract coverage mapping',
      '- Add Code Space UI coverage panel',
    ].join('\n'));

    const updated = addPatchCoverage(contract, patch('lib/code-space/runtime/implementationContract.ts'))!;

    const contractRequirement = updated.requirements.find((item) => item.text.includes('implementation contract'))!;
    const uiRequirement = updated.requirements.find((item) => item.text.includes('UI coverage'))!;

    expect(contractRequirement.status).toBe('covered');
    expect(contractRequirement.evidence).toHaveLength(1);
    expect(uiRequirement.status).toBe('pending');
    expect(uiRequirement.evidence).toHaveLength(0);
    expect(contractBlockers(updated)).toEqual(['Implementation contract has 1 uncovered requirement(s): req:2.']);
  });

  it('maps validation evidence to requirements that already have applied patches', () => {
    const contract = createImplementationContract([
      '- Fix implementation contract coverage mapping',
      '- Add Code Space UI coverage panel',
    ].join('\n'));
    const patched = addPatchCoverage(contract, patch('lib/code-space/runtime/implementationContract.ts'))!;

    const updated = addValidationCoverage(patched, validation('passed'))!;

    const contractRequirement = updated.requirements.find((item) => item.text.includes('implementation contract'))!;
    const uiRequirement = updated.requirements.find((item) => item.text.includes('UI coverage'))!;

    expect(contractRequirement.evidence.map((item) => item.kind)).toEqual(['patch', 'validation']);
    expect(contractRequirement.status).toBe('covered');
    expect(uiRequirement.evidence).toHaveLength(0);
    expect(uiRequirement.status).toBe('pending');
  });

  it('keeps unrelated patch evidence from covering every requirement', () => {
    const contract = createImplementationContract([
      '- Fix implementation contract coverage mapping',
      '- Add Code Space UI coverage panel',
    ].join('\n'));

    const updated = addPatchCoverage(contract, patch('docs/readme.md'))!;

    expect(updated.requirements.every((item) => item.status === 'pending')).toBe(true);
    expect(updated.requirements.every((item) => item.evidence.length === 0)).toBe(true);
    expect(contractBlockers(updated)).toEqual(['Implementation contract has 2 uncovered requirement(s): req:1, req:2.']);
  });

  it('keeps a single-requirement fallback for small implementation tasks', () => {
    const contract = createImplementationContract('Update the Code Space implementation contract.');

    const updated = addPatchCoverage(contract, patch('lib/code-space/runtime/implementationContract.ts'))!;

    expect(updated.requirements).toHaveLength(1);
    expect(updated.requirements[0]?.status).toBe('covered');
    expect(contractBlockers(updated)).toEqual([]);
  });
});

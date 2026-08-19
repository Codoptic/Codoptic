import { describe, expect, it } from 'vitest';
import { addCoverageEvidence, contractBlockers, coverRequirement, createImplementationContract } from '../implementationContract';

describe('implementation contract', () => {
  it('extracts checklist requirements and blocks uncovered contracts', () => {
    const contract = createImplementationContract('', '- Add live feed\n- Stream terminal output');

    expect(contract.requirements.map((requirement) => requirement.text)).toEqual([
      'Add live feed',
      'Stream terminal output',
    ]);
    expect(contractBlockers(contract).join(' ')).toContain('uncovered requirement');
  });

  it('does not cover a requirement from patch-only evidence', () => {
    const contract = createImplementationContract('', '- Add live feed');
    const patched = addCoverageEvidence(contract, { kind: 'patch', summary: 'Added feed UI', filePath: 'feed.tsx' });

    expect(patched?.requirements[0]?.status).toBe('pending');
    expect(contractBlockers(patched).join(' ')).toContain('uncovered');
  });

  it('covers only the matching requirement when validation passes', () => {
    const contract = createImplementationContract('', '- Add live feed\n- Stream terminal output');
    const covered = coverRequirement(contract, 'req:1', { kind: 'validation', summary: 'live feed tests', command: 'npm test', status: 'passed' });

    expect(covered?.requirements[0]?.status).toBe('covered');
    expect(covered?.requirements[1]?.status).toBe('pending');
    expect(contractBlockers(covered).join(' ')).toContain('req:2');
  });

  it('covers a patched requirement only after follow-on validation passes', () => {
    const contract = createImplementationContract('Update answer in src.ts');
    const patched = addCoverageEvidence(contract, { kind: 'patch', summary: 'edit src.ts', filePath: 'src.ts' });
    const validated = addCoverageEvidence(patched, { kind: 'validation', summary: 'node: passed', command: 'node', status: 'passed' });
    expect(patched?.requirements[0]?.status).toBe('pending');
    expect(validated?.requirements[0]?.status).toBe('covered');
    expect(contractBlockers(validated)).toEqual([]);
  });
});

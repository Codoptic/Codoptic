import { describe, expect, it } from 'vitest';
import { addCoverageEvidence, contractBlockers, createImplementationContract } from '../implementationContract';

describe('implementation contract', () => {
  it('extracts checklist requirements and blocks uncovered contracts', () => {
    const contract = createImplementationContract('', '- Add live feed\n- Stream terminal output');

    expect(contract.requirements.map((requirement) => requirement.text)).toEqual([
      'Add live feed',
      'Stream terminal output',
    ]);
    expect(contractBlockers(contract).join(' ')).toContain('uncovered requirement');
  });

  it('marks requirements covered when evidence is recorded', () => {
    const contract = createImplementationContract('', '- Add live feed');
    const covered = addCoverageEvidence(contract, { kind: 'patch', summary: 'Added feed UI' });

    expect(contractBlockers(covered)).toEqual([]);
    expect(covered?.requirements[0]?.status).toBe('covered');
    expect(covered?.requirements[0]?.evidence[0]?.summary).toBe('Added feed UI');
  });
});

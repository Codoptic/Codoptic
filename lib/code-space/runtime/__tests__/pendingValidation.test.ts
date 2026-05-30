import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadPendingValidation,
  removePendingValidation,
  savePendingValidation,
  type PendingValidationRecord,
} from '../pendingValidation';

function makeRecord(runId: string): PendingValidationRecord {
  return {
    runId,
    sessionId: 'sess-1',
    projectRoot: '/tmp/project',
    projectName: 'demo',
    prompt: 'fix the oversell bug',
    instructionPaths: ['AGENTS.md'],
    isGit: true,
    unifiedDiff: '--- a/src/inventory.mjs\n+++ b/src/inventory.mjs\n@@ -1,1 +1,1 @@\n-old\n+new\n',
    createdAt: Date.now(),
    files: [
      { path: 'src/inventory.mjs', beforeContent: 'old', afterContent: 'new', deleted: false, existedBefore: true },
    ],
  };
}

describe('pendingValidation persistence (pre-validation diff gate state)', () => {
  let storePath: string;

  beforeEach(async () => {
    storePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'codoptic-pv-')), 'pending.json');
    process.env.CODE_SPACE_PENDING_VALIDATION_PATH = storePath;
  });

  afterEach(async () => {
    delete process.env.CODE_SPACE_PENDING_VALIDATION_PATH;
    await fs.rm(path.dirname(storePath), { recursive: true, force: true });
  });

  it('round-trips a record through save → load', async () => {
    const record = makeRecord('run-a');
    await savePendingValidation(record);
    const loaded = await loadPendingValidation('run-a');
    expect(loaded).not.toBeNull();
    expect(loaded?.runId).toBe('run-a');
    expect(loaded?.unifiedDiff).toContain('+new');
    expect(loaded?.files).toHaveLength(1);
    expect(loaded?.files[0]?.path).toBe('src/inventory.mjs');
  });

  it('returns null for unknown runs and after removal', async () => {
    expect(await loadPendingValidation('missing')).toBeNull();
    await savePendingValidation(makeRecord('run-b'));
    await removePendingValidation('run-b');
    expect(await loadPendingValidation('run-b')).toBeNull();
  });

  it('keeps independent records keyed by runId', async () => {
    await savePendingValidation(makeRecord('run-c'));
    await savePendingValidation({ ...makeRecord('run-d'), isGit: false });
    expect((await loadPendingValidation('run-c'))?.isGit).toBe(true);
    expect((await loadPendingValidation('run-d'))?.isGit).toBe(false);
    await removePendingValidation('run-c');
    expect(await loadPendingValidation('run-c')).toBeNull();
    expect(await loadPendingValidation('run-d')).not.toBeNull();
  });
});

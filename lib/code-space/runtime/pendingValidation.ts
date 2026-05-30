import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Pre-validation diff gate state.
 *
 * Motivation vs Logic: the agent's SSE run stream closes when `AgentRuntime.run`
 * returns, so a "pause for the user to confirm the full diff before validation"
 * gate cannot be held in memory across the closed stream. We persist the minimal,
 * non-secret run state needed to (a) revert on cancel and (b) reconstruct a
 * validation context on confirm. Provider credentials are NOT stored — the resume
 * request supplies them again, exactly like the original agent request.
 */
export interface PendingValidationFile {
  path: string;
  beforeContent: string;
  afterContent: string;
  deleted: boolean;
  existedBefore: boolean;
}

export interface PendingValidationRecord {
  runId: string;
  sessionId: string;
  projectRoot: string;
  projectName: string;
  prompt: string;
  instructionPaths: string[];
  isGit: boolean;
  unifiedDiff: string;
  createdAt: number;
  files: PendingValidationFile[];
}

function storePath(): string {
  return process.env.CODE_SPACE_PENDING_VALIDATION_PATH ?? path.join(os.tmpdir(), 'codoptic-pending-validations.json');
}

async function readAll(): Promise<Record<string, PendingValidationRecord>> {
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    return JSON.parse(raw) as Record<string, PendingValidationRecord>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return {};
  }
}

let writeQueue: Promise<unknown> = Promise.resolve();

async function writeAll(records: Record<string, PendingValidationRecord>): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(storePath()), { recursive: true });
    await fs.writeFile(storePath(), JSON.stringify(records, null, 2), 'utf8');
  });
  await writeQueue;
}

export async function savePendingValidation(record: PendingValidationRecord): Promise<void> {
  const records = await readAll();
  records[record.runId] = record;
  await writeAll(records);
}

export async function loadPendingValidation(runId: string): Promise<PendingValidationRecord | null> {
  const records = await readAll();
  return records[runId] ?? null;
}

export async function removePendingValidation(runId: string): Promise<void> {
  const records = await readAll();
  if (records[runId]) {
    delete records[runId];
    await writeAll(records);
  }
}

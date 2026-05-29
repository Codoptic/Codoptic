import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationVerifier } from '../integrationVerifier';
import { progressiveOrder } from '../validationRunner';
import type { TerminalCommand } from '../terminalPolicy';
import type { TerminalRunner } from '../terminalRunner';
import { createDefaultToolRegistry } from '../toolRegistry';
import { PermissionManager } from '../permissionManager';
import type { CodeAgentContext, LedgerEntry } from '../toolExecutor';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-verifier-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// Hermetic terminal: pretend git diff is unavailable so we test syntax findings deterministically.
const fakeTerminal = { run: async () => ({ command: 'git diff', status: 'failed' as const, output: '', durationMs: 0 }) } as unknown as TerminalRunner;

function entry(afterContent: string): LedgerEntry {
  return { beforeContent: '', afterContent, deleted: false, existedBefore: false };
}

function makeContext(ledger: Map<string, LedgerEntry>): CodeAgentContext {
  return {
    root: tmpDir,
    runId: 'run-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    autonomy: 'auto_safe_tools',
    emit: () => {},
    emitRuntime: async () => {},
    ledger,
    proposedFiles: new Set(),
    proposedLedger: new Map(),
    editFailures: new Map(),
    readFiles: new Set(),
    artifacts: new Map(),
    checkpoints: [],
    registry: createDefaultToolRegistry(),
    permission: new PermissionManager(),
    terminal: fakeTerminal,
  };
}

describe('IntegrationVerifier.reviewDiffCoherence', () => {
  it('flags a syntactically broken edited file and passes a clean one', async () => {
    const ledger = new Map<string, LedgerEntry>([
      ['bad.json', entry('{ "x": ')],
      ['good.ts', entry('export const x = 1;\n')],
    ]);
    const verifier = new IntegrationVerifier();
    const report = await verifier.reviewDiffCoherence(makeContext(ledger));

    expect(report.findings.some((finding) => finding.path === 'bad.json' && finding.kind === 'syntax')).toBe(true);
    expect(report.findings.some((finding) => finding.path === 'good.ts')).toBe(false);
  });
});

describe('progressiveOrder', () => {
  it('orders structural gates before behavioral gates before build', () => {
    const cmd = (kind: TerminalCommand['kind']): TerminalCommand => ({ kind, command: kind, args: [], reason: kind });
    const ordered = progressiveOrder([cmd('build'), cmd('test'), cmd('lint'), cmd('typecheck'), cmd('syntax')]);
    expect(ordered.map((command) => command.kind)).toEqual(['syntax', 'typecheck', 'lint', 'test', 'build']);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '@/lib/agent/providers';
import { ToolExecutor, type CodeAgentContext } from '../toolExecutor';
import { createDefaultToolRegistry } from '../toolRegistry';
import { PermissionManager } from '../permissionManager';
import { TerminalRunner } from '../terminalRunner';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import type { AutonomyLevel } from '@/lib/code-space/domain';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-tool-exec-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeContext(events: AgentSSEEvent[], autonomy: AutonomyLevel = 'auto_safe_tools'): CodeAgentContext {
  return {
    root: tmpDir,
    runId: 'run-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    autonomy,
    emit: (event) => {
      events.push(event);
    },
    emitRuntime: async () => {},
    ledger: new Map(),
    proposedFiles: new Set(),
    proposedLedger: new Map(),
    editFailures: new Map(),
    readFiles: new Set(),
    artifacts: new Map(),
    checkpoints: [],
    registry: createDefaultToolRegistry(),
    permission: new PermissionManager(),
    terminal: new TerminalRunner(),
  };
}

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `${name}-1`, name, input };
}

describe('ToolExecutor.edit_file', () => {
  it('applies a clean edit to disk and records a checkpoint', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n', 'utf8');
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const executor = new ToolExecutor();

    const result = await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'export const x = 1;', replace: 'export const x = 2;', reason: 'bump' }] }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(await readFile(path.join(tmpDir, 'a.ts'), 'utf8')).toContain('x = 2');
    expect(ctx.checkpoints.length).toBe(1);
    expect(events.some((event) => event.type === 'file_applied')).toBe(true);
  });

  it('returns an actionable diagnostic (not a throw) when the search block does not match', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n', 'utf8');
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const executor = new ToolExecutor();

    const result = await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'NONEXISTENT LINE', replace: 'whatever', reason: 'x' }] }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/could not apply|SEARCH/i);
    expect(result.content).toMatch(/Current state of a\.ts/);
    expect(result.content).toMatch(/Repair protocol:/);
    expect(ctx.editFailures.get('a.ts')?.length).toBeGreaterThan(0);
    expect(await readFile(path.join(tmpDir, 'a.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(ctx.checkpoints.length).toBe(0);
  });

  it('creates a missing file with an empty search block', async () => {
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const executor = new ToolExecutor();

    const result = await executor.execute(
      call('edit_file', {
        edits: [
          {
            path: 'docs/milestones/m3/deliverables.md',
            search: '',
            replace: '# Deliverables\n\n- Review patch creation flow.\n',
            reason: 'add milestone deliverables',
          },
        ],
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(await readFile(path.join(tmpDir, 'docs/milestones/m3/deliverables.md'), 'utf8')).toBe('# Deliverables\n\n- Review patch creation flow.\n');
    expect(ctx.ledger.get('docs/milestones/m3/deliverables.md')?.existedBefore).toBe(false);
    expect(events.some((event) => event.type === 'file_applied')).toBe(true);
  });

  it('does not treat an existing blank file as a create target', async () => {
    await writeFile(path.join(tmpDir, 'blank.md'), '', 'utf8');
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const executor = new ToolExecutor();

    const result = await executor.execute(
      call('edit_file', { edits: [{ path: 'blank.md', search: '', replace: '# Title\n', reason: 'replace blank file' }] }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/can only be empty when creating/i);
    expect(await readFile(path.join(tmpDir, 'blank.md'), 'utf8')).toBe('');
    expect(ctx.ledger.size).toBe(0);
  });

  it('proposes instead of writing under suggest_only autonomy', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n', 'utf8');
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events, 'suggest_only');
    const executor = new ToolExecutor();

    await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'export const x = 1;', replace: 'export const x = 2;', reason: 'bump' }] }),
      ctx,
    );

    expect(await readFile(path.join(tmpDir, 'a.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(events.some((event) => event.type === 'diff_proposed')).toBe(true);
    expect(events.some((event) => event.type === 'file_applied')).toBe(false);
    expect(ctx.proposedFiles.has('a.ts')).toBe(true);
    expect(ctx.proposedLedger.get('a.ts')?.afterContent).toContain('x = 2');
    expect(ctx.ledger.size).toBe(0);
  });

  it('proposes a missing file creation with explicit nonexistence metadata', async () => {
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events, 'suggest_only');
    const executor = new ToolExecutor();

    const result = await executor.execute(
      call('edit_file', { edits: [{ path: 'new.md', search: '', replace: 'hello\n', reason: 'add doc' }] }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(ctx.proposedLedger.get('new.md')).toMatchObject({ beforeContent: '', afterContent: 'hello\n', existedBefore: false });
    await expect(readFile(path.join(tmpDir, 'new.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid Python proposals under suggest_only instead of surfacing them for review', async () => {
    const target = path.join(tmpDir, 'backend/api/config.py');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      ['class Config:', '    def __init__(self):', '        self.value = 1', ''].join('\n'),
      'utf8',
    );
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events, 'suggest_only');
    const executor = new ToolExecutor();

    const result = await executor.execute(
      call('edit_file', {
        edits: [
          {
            path: 'backend/api/config.py',
            search: '        self.value = 1',
            replace: '    def broken(self):\n        pass\n        self.value = 1',
            reason: 'bad indent',
          },
        ],
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/syntax pre-validation/i);
    expect(events.some((event) => event.type === 'diff_proposed')).toBe(false);
    expect(ctx.proposedFiles.size).toBe(0);
    expect(ctx.proposedLedger.size).toBe(0);
    expect(ctx.editFailures.get('backend/api/config.py')?.length).toBeGreaterThan(0);
  });

  it('stacks sequential proposals to one file into a single cumulative, conflict-free proposal', async () => {
    const original = 'export const x = 1;\nexport const y = 1;\n';
    await writeFile(path.join(tmpDir, 'a.ts'), original, 'utf8');
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events, 'suggest_only');
    const executor = new ToolExecutor();

    await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'export const x = 1;', replace: 'export const x = 2;', reason: 'bump x' }] }),
      ctx,
    );
    await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'export const y = 1;', replace: 'export const y = 2;', reason: 'bump y' }] }),
      ctx,
    );

    const proposals = events.filter((event) => event.type === 'diff_proposed');
    expect(proposals.length).toBe(2);
    // Stable diffId so the UI replaces the prior card instead of stacking stale baselines.
    const ids = new Set(proposals.map((event) => (event as Extract<AgentSSEEvent, { type: 'diff_proposed' }>).diffId));
    expect(ids.size).toBe(1);

    const latest = proposals[proposals.length - 1] as Extract<AgentSSEEvent, { type: 'diff_proposed' }>;
    expect(latest.oldContent).toBe(original);
    expect(latest.newContent).toContain('x = 2');
    expect(latest.newContent).toContain('y = 2');

    const ledger = ctx.proposedLedger.get('a.ts');
    expect(ledger?.beforeContent).toBe(original);
    expect(ledger?.afterContent).toContain('x = 2');
    expect(ledger?.afterContent).toContain('y = 2');
    // Disk is untouched under suggest_only.
    expect(await readFile(path.join(tmpDir, 'a.ts'), 'utf8')).toBe(original);
  });

  it('read_file serves pending proposed content after a proposal', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n', 'utf8');
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events, 'suggest_only');
    const executor = new ToolExecutor();

    await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'export const x = 1;', replace: 'export const x = 2;', reason: 'bump' }] }),
      ctx,
    );
    const read = await executor.execute(call('read_file', { path: 'a.ts' }), ctx);

    expect(read.content).toMatch(/pending proposed content/i);
    expect(read.content).toContain('x = 2');
  });

  it('clears editFailures after a successful retry on the same file', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n', 'utf8');
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const executor = new ToolExecutor();

    await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'NONEXISTENT LINE', replace: 'whatever', reason: 'x' }] }),
      ctx,
    );
    expect(ctx.editFailures.get('a.ts')?.length).toBeGreaterThan(0);

    const result = await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'export const x = 1;', replace: 'export const x = 2;', reason: 'bump' }] }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(ctx.editFailures.has('a.ts')).toBe(false);
  });
});

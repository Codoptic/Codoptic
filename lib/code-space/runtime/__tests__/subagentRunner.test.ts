import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantTurn } from '@/lib/agent/providers';
import { chatTurnWithTools } from '@/lib/agent/providers';
import { SubagentRunner } from '../subagentRunner';
import { createDefaultToolRegistry } from '../toolRegistry';
import { PermissionManager } from '../permissionManager';
import { TerminalRunner } from '../terminalRunner';
import type { CodeAgentContext, LedgerEntry } from '../toolExecutor';

vi.mock('@/lib/agent/providers', () => {
  const chatTurnWithTools = vi.fn();
  return {
    chatTurnWithTools,
    chatTurnWithToolsStream: async function* (...args: unknown[]) {
      const turn = await chatTurnWithTools(...args);
      if (turn.text) yield { type: 'text_delta', delta: turn.text };
      yield { type: 'final', turn };
    },
  };
});

const mockedTurn = vi.mocked(chatTurnWithTools);

function turn(partial: Partial<AssistantTurn>): AssistantTurn {
  return { text: '', toolCalls: [], stopReason: 'tool_use', ...partial };
}

let tmpDir: string;
let runtimeEvents: Array<{ type: string; payload: unknown }>;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-subagent-'));
  runtimeEvents = [];
  mockedTurn.mockReset();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeParent(): CodeAgentContext {
  return {
    root: tmpDir,
    runId: 'run-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    autonomy: 'auto_safe_tools',
    emit: () => {},
    emitRuntime: async (type, payload) => {
      runtimeEvents.push({ type, payload });
    },
    ledger: new Map<string, LedgerEntry>(),
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

describe('SubagentRunner', () => {
  it('runs a read-only explorer in isolation and emits subagent lifecycle events', async () => {
    await writeFile(path.join(tmpDir, 'src.ts'), 'export const x = 1;\n', 'utf8');
    mockedTurn
      .mockResolvedValueOnce(turn({ toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'src.ts' } }] }))
      .mockResolvedValueOnce(turn({ stopReason: 'end_turn', toolCalls: [{ id: 't2', name: 'attempt_completion', input: { success: true, summary: 'src.ts exports x.' } }] }));

    const parent = makeParent();
    const runner = new SubagentRunner(parent, { id: 'openai', model: 'test', apiKey: '' }, 'demo');
    const result = await runner.spawn({ role: 'explorer', task: 'Inspect src.ts' });

    expect(result.role).toBe('explorer');
    expect(result.success).toBe(true);
    expect(parent.ledger.size).toBe(0);
    expect(runtimeEvents.some((event) => event.type === 'subagent.started')).toBe(true);
    expect(runtimeEvents.some((event) => event.type === 'subagent.completed')).toBe(true);
  });

  it('merges a mutating subagent\'s ledger back into the parent context', async () => {
    const testFile = path.join(tmpDir, '.agent', 'tests', 'run-1', 't.ts');
    await mkdir(path.dirname(testFile), { recursive: true });
    await writeFile(testFile, 'old\n', 'utf8');

    mockedTurn
      .mockResolvedValueOnce(turn({ toolCalls: [{ id: 't1', name: 'edit_file', input: { edits: [{ path: '.agent/tests/run-1/t.ts', search: 'old', replace: 'new', reason: 'add test' }] } }] }))
      .mockResolvedValueOnce(turn({ stopReason: 'end_turn', toolCalls: [{ id: 't2', name: 'attempt_completion', input: { success: true, completedOriginalRequest: true, summary: 'Wrote a test.' } }] }));

    const parent = makeParent();
    const runner = new SubagentRunner(parent, { id: 'openai', model: 'test', apiKey: '' }, 'demo');
    const result = await runner.spawn({ role: 'test-writer', task: 'Write a test under .agent/tests/run-1/' });

    expect(result.success).toBe(true);
    expect(parent.ledger.has('.agent/tests/run-1/t.ts')).toBe(true);
  });
});

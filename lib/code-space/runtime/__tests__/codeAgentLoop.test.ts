import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantTurn } from '@/lib/agent/providers';
import { chatTurnWithTools } from '@/lib/agent/providers';
import { CodeAgentLoop } from '../codeAgentLoop';
import { ToolBudget } from '../toolBudget';
import type { CodeAgentContext } from '../toolExecutor';
import { createDefaultToolRegistry } from '../toolRegistry';
import { PermissionManager } from '../permissionManager';
import { TerminalRunner } from '../terminalRunner';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';

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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-code-loop-'));
  mockedTurn.mockReset();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function turn(partial: Partial<AssistantTurn>): AssistantTurn {
  return { text: '', toolCalls: [], stopReason: 'tool_use', ...partial };
}

function makeContext(events: AgentSSEEvent[]): CodeAgentContext {
  return {
    root: tmpDir,
    runId: 'run-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    autonomy: 'auto_safe_tools',
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

describe('CodeAgentLoop', () => {
  it('drives read → edit → complete, applies the edit to disk, and writes no workspace markdown', async () => {
    await writeFile(path.join(tmpDir, 'src.ts'), 'export const answer = 1;\n', 'utf8');

    mockedTurn
      .mockResolvedValueOnce(turn({ text: 'Reading the file.', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'src.ts' } }] }))
      .mockResolvedValueOnce(turn({
        text: 'Updating the constant.',
        toolCalls: [{
          id: 't2',
          name: 'edit_file',
          input: { edits: [{ path: 'src.ts', search: 'export const answer = 1;', replace: 'export const answer = 42;', reason: 'bump' }] },
        }],
      }))
      .mockResolvedValueOnce(turn({ stopReason: 'end_turn', toolCalls: [{ id: 't3', name: 'attempt_completion', input: { success: true, completedOriginalRequest: true, summary: 'Bumped answer to 42.' } }] }));

    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const loop = new CodeAgentLoop();
    loop.seed('system', 'Change answer to 42 in src.ts');

    const result = await loop.run(ctx, { session: { id: 'openai', model: 'test', apiKey: '' }, budget: new ToolBudget(10, 40) });

    expect(result.completed).toBe(true);
    expect(result.success).toBe(true);
    expect(await readFile(path.join(tmpDir, 'src.ts'), 'utf8')).toContain('answer = 42');
    expect(ctx.ledger.get('src.ts')?.afterContent).toContain('answer = 42');
    expect(events.some((event) => event.type === 'file_applied' && event.filePath === 'src.ts')).toBe(true);
    expect(events.some((event) => event.type === 'agent_reasoning_delta')).toBe(true);

    const recoveryDir = path.join(tmpDir, '.agent', 'recovery');
    await expect(readdir(recoveryDir)).rejects.toThrow();
  });

  it('returns an honest failure and writes no file when the model cannot finish', async () => {
    mockedTurn.mockResolvedValueOnce(turn({
      stopReason: 'end_turn',
      toolCalls: [{ id: 't1', name: 'attempt_completion', input: { success: false, summary: 'The required module does not exist; cannot proceed.' } }],
    }));

    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const loop = new CodeAgentLoop();
    loop.seed('system', 'Do something impossible');

    const result = await loop.run(ctx, { session: { id: 'openai', model: 'test', apiKey: '' }, budget: new ToolBudget(10, 40) });

    expect(result.completed).toBe(true);
    expect(result.success).toBe(false);
    expect(ctx.ledger.size).toBe(0);
    expect(events.some((event) => event.type === 'file_applied')).toBe(false);
    await expect(readdir(path.join(tmpDir, '.agent'))).rejects.toThrow();
  });

  it('rejects successful completion in a mutating run when no edit was applied or proposed', async () => {
    mockedTurn
      .mockResolvedValueOnce(turn({
        stopReason: 'end_turn',
        toolCalls: [{ id: 't1', name: 'attempt_completion', input: { success: true, summary: 'Done.' } }],
      }))
      .mockResolvedValueOnce(turn({
        stopReason: 'end_turn',
        toolCalls: [{ id: 't2', name: 'attempt_completion', input: { success: false, summary: 'No matching target file was found.' } }],
      }));

    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const loop = new CodeAgentLoop();
    loop.seed('system', 'Change missing.ts');

    const result = await loop.run(ctx, { session: { id: 'openai', model: 'test', apiKey: '' }, budget: new ToolBudget(10, 40) });

    expect(result.completed).toBe(true);
    expect(result.success).toBe(false);
    expect(loop.messages.some((message) => message.role === 'tool' && message.toolResults?.some((entry) => entry.isError && entry.content.includes('Cannot complete successfully')))).toBe(true);
  });

  it('rejects successful completion after edits until the original request is explicitly checked', async () => {
    await writeFile(path.join(tmpDir, 'src.ts'), 'export const answer = 1;\n', 'utf8');

    mockedTurn
      .mockResolvedValueOnce(turn({
        toolCalls: [{
          id: 't1',
          name: 'edit_file',
          input: { edits: [{ path: 'src.ts', search: 'export const answer = 1;', replace: 'export const answer = 2;', reason: 'bump' }] },
        }],
      }))
      .mockResolvedValueOnce(turn({
        stopReason: 'end_turn',
        toolCalls: [{ id: 't2', name: 'attempt_completion', input: { success: true, summary: 'Updated answer.' } }],
      }))
      .mockResolvedValueOnce(turn({
        stopReason: 'end_turn',
        toolCalls: [{ id: 't3', name: 'attempt_completion', input: { success: true, completedOriginalRequest: true, summary: 'Updated answer.' } }],
      }));

    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const loop = new CodeAgentLoop();
    loop.seed('system', 'Update answer in src.ts and verify the request is complete');

    const result = await loop.run(ctx, { session: { id: 'openai', model: 'test', apiKey: '' }, budget: new ToolBudget(10, 40) });

    expect(result.completed).toBe(true);
    expect(result.success).toBe(true);
    expect(loop.messages.some((message) => message.role === 'tool' && message.toolResults?.some((entry) => entry.isError && entry.content.includes('completedOriginalRequest=true')))).toBe(true);
  });

  it('stops at the hard turn cap without completing', async () => {
    mockedTurn.mockResolvedValue(turn({ toolCalls: [{ id: 'loop', name: 'read_file', input: { path: 'missing.ts' } }] }));

    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const loop = new CodeAgentLoop();
    loop.seed('system', 'Keep reading forever');

    const result = await loop.run(ctx, { session: { id: 'openai', model: 'test', apiKey: '' }, budget: new ToolBudget(10, 4) });

    expect(result.completed).toBe(false);
    expect(result.stopReason).toBe('turns_exhausted');
  });

  it('refuses attempt_completion after edit failure and completes after a corrected edit', async () => {
    await writeFile(path.join(tmpDir, 'config.py'), ['class Config:', '    def __init__(self):', '        self.value = 1', ''].join('\n'), 'utf8');

    mockedTurn
      .mockResolvedValueOnce(turn({
        toolCalls: [{
          id: 't1',
          name: 'edit_file',
          input: {
            edits: [{
              path: 'config.py',
              search: '        self.value = 1',
              replace: '    def broken(self):\n        pass\n        self.value = 1',
              reason: 'bad indent',
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(turn({
        toolCalls: [{ id: 't2', name: 'attempt_completion', input: { success: false, summary: 'Syntax pre-validation blocked the edit.' } }],
      }))
      .mockResolvedValueOnce(turn({
        toolCalls: [{
          id: 't3',
          name: 'edit_file',
          input: {
            edits: [{
              path: 'config.py',
              search: '        self.value = 1',
              replace: '        self.value = 2',
              reason: 'fix value',
            }],
          },
        }],
      }))
      .mockResolvedValueOnce(turn({
        toolCalls: [{ id: 't4', name: 'attempt_completion', input: { success: true, completedOriginalRequest: true, summary: 'Updated config value.' } }],
      }));

    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const loop = new CodeAgentLoop();
    loop.seed('system', 'Update config.py value');

    const budget = new ToolBudget(10, 40);
    const result = await loop.run(ctx, { session: { id: 'openai', model: 'test', apiKey: '' }, budget });

    expect(result.completed).toBe(true);
    expect(result.success).toBe(true);
    expect(await readFile(path.join(tmpDir, 'config.py'), 'utf8')).toContain('self.value = 2');
    expect(budget.mutationsUsed).toBe(1);
    expect(loop.messages.some((message) => message.role === 'tool' && message.toolResults?.some((entry) => entry.isError && entry.content.includes('Cannot complete')))).toBe(true);
  });

  it('replans after a recoverable verification command failure instead of emitting it as final error', async () => {
    await writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { 'verify:career': 'node check.js' } }), 'utf8');
    await writeFile(
      path.join(tmpDir, 'check.js'),
      [
        "const fs = require('node:fs');",
        "const source = fs.readFileSync('src.ts', 'utf8');",
        "if (!source.includes('fixed')) {",
        "  console.error('src.ts:1:1 error prefer-const verification failed');",
        '  process.exit(1);',
        '}',
        "console.log('verification passed');",
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(path.join(tmpDir, 'src.ts'), 'export const status = "broken";\n', 'utf8');

    mockedTurn
      .mockResolvedValueOnce(turn({
        toolCalls: [{ id: 't1', name: 'run_command', input: { command: 'npm', args: ['run', 'verify:career'], reason: 'Verify career flow.' } }],
      }))
      .mockResolvedValueOnce(turn({
        toolCalls: [{ id: 't2', name: 'attempt_completion', input: { success: false, summary: '[failed] npm run verify:career artifactId: artifact:run-1:terminal_log:abc' } }],
      }))
      .mockResolvedValueOnce(turn({
        toolCalls: [{
          id: 't3',
          name: 'edit_file',
          input: { edits: [{ path: 'src.ts', search: 'export const status = "broken";', replace: 'export const status = "fixed";', reason: 'Fix verification failure.' }] },
        }],
      }))
      .mockResolvedValueOnce(turn({
        toolCalls: [{ id: 't4', name: 'run_command', input: { command: 'npm', args: ['run', 'verify:career'], reason: 'Re-run verification.' } }],
      }))
      .mockResolvedValueOnce(turn({
        toolCalls: [{ id: 't5', name: 'attempt_completion', input: { success: true, completedOriginalRequest: true, summary: 'Fixed verification failure.' } }],
      }));

    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const loop = new CodeAgentLoop();
    loop.seed('system', 'Fix career verification');

    const result = await loop.run(ctx, { session: { id: 'openai', model: 'test', apiKey: '' }, budget: new ToolBudget(10, 40) });

    const failedCommandEvent = events.find((event) => event.type === 'tool_result' && event.toolCallId === 't1');
    expect(result.success).toBe(true);
    expect(await readFile(path.join(tmpDir, 'src.ts'), 'utf8')).toContain('"fixed"');
    expect(failedCommandEvent && failedCommandEvent.type === 'tool_result' ? failedCommandEvent.error : undefined).toBeUndefined();
    expect(events.some((event) => event.type === 'agent_status' && /replanning automatically/i.test(event.status.title))).toBe(true);
    expect(loop.messages.some((message) => message.role === 'tool' && message.toolResults?.some((entry) => entry.isError && entry.content.includes('a validation or verification command failed')))).toBe(true);
    expect(ctx.recoverableFailures?.size ?? 0).toBe(0);
  });

  it('does not charge mutation budget for failed edit_file', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n', 'utf8');

    mockedTurn
      .mockResolvedValueOnce(turn({
        toolCalls: [{
          id: 't1',
          name: 'edit_file',
          input: { edits: [{ path: 'a.ts', search: 'NONEXISTENT', replace: 'x', reason: 'fail' }] },
        }],
      }))
      .mockResolvedValueOnce(turn({ stopReason: 'end_turn', text: 'Stopped after failed edit.', toolCalls: [] }));

    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const loop = new CodeAgentLoop();
    loop.seed('system', 'Edit a.ts');

    const budget = new ToolBudget(10, 40);
    await loop.run(ctx, { session: { id: 'openai', model: 'test', apiKey: '' }, budget });

    expect(budget.mutationsUsed).toBe(0);
  });
});

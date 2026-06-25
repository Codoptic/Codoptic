import { describe, expect, it } from 'vitest';
import { buildAgentTimeline } from '../agentTimeline';
import { splitUnifiedDiffIntoHunks } from '../diffHunks';
import type { CodeSpaceAgentSession } from '@/lib/code-space/core';

function createSession(): CodeSpaceAgentSession {
  const now = 1_800_000_000_000;
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Timeline session',
    status: 'running',
    mode: 'code',
    messages: [
      { id: 'user-1', role: 'user', content: 'Fix proposal reset.', createdAt: now },
      { id: 'assistant-1', role: 'assistant', content: "I'll trace proposal state.", createdAt: now + 10 },
    ],
    toolCalls: [
      {
        id: 'tool-1',
        name: 'read_file',
        status: 'success',
        summary: 'Completed',
        input: { path: 'backend/reset.py' },
        output: 'ok',
        createdAt: now + 20,
        updatedAt: now + 21,
      },
      {
        id: 'tool-2',
        name: 'search_text',
        status: 'success',
        summary: 'Completed',
        input: { query: 'proposal state' },
        output: 'ok',
        createdAt: now + 22,
        updatedAt: now + 23,
      },
    ],
    plan: [],
    clarifyingQuestions: [],
    todos: [],
    changesets: [],
    verificationResults: [
      { id: 'verify-1', command: 'npm run typecheck', status: 'failed', output: 'Type error' },
    ],
    createdAt: now,
    updatedAt: now + 40,
    archived: false,
    localCacheVersion: 0,
    toolBudget: 50,
    toolCallCount: 2,
    filesChanged: [],
    agentChangesets: [],
  };
}

describe('buildAgentTimeline', () => {
  it('orders prompt, narration, exploration, patches, review gate, and validation inline', () => {
    const session = createSession();
    const unifiedDiff = '@@ -1 +1 @@\n-old\n+new';
    const items = buildAgentTimeline({
      session,
      pendingDiffs: [
        {
          diffId: 'diff-1',
          filePath: 'backend/reset.py',
          oldContent: 'old',
          newContent: 'new',
          unifiedDiff,
          hunks: splitUnifiedDiffIntoHunks(unifiedDiff, 'old', 'new'),
          hunkStatus: {},
        },
      ],
      appliedDiffs: [],
    });

    expect(items.map((item) => item.kind)).toEqual([
      'user_prompt',
      'assistant_text',
      'exploration_summary',
      'patch_card',
      'review_gate',
      'validation_summary',
    ]);
    expect(items.find((item) => item.kind === 'exploration_summary')).toMatchObject({
      text: 'Explored 1 file, 1 search',
      filePaths: ['backend/reset.py'],
      searches: [{ query: 'proposal state' }],
    });
    expect(items.find((item) => item.kind === 'patch_card')).toMatchObject({
      title: 'reset.py',
      added: 1,
      removed: 1,
      status: 'pending',
    });
  });

  it('collapses repeated reads and searches into one exploration line', () => {
    const session = createSession();
    session.toolCalls.push(
      {
        id: 'tool-3',
        name: 'read_file',
        status: 'success',
        summary: 'Completed',
        input: { path: 'backend/reset.py' },
        output: 'ok',
        createdAt: session.updatedAt + 1,
        updatedAt: session.updatedAt + 1,
      },
      {
        id: 'tool-4',
        name: 'read_file',
        status: 'success',
        summary: 'Completed',
        input: { path: 'backend/jobs.py' },
        output: 'ok',
        createdAt: session.updatedAt + 2,
        updatedAt: session.updatedAt + 2,
      },
      {
        id: 'tool-5',
        name: 'search_text',
        status: 'success',
        summary: 'Completed',
        input: { query: 'clear all versions', glob: '*.py' },
        output: 'ok',
        createdAt: session.updatedAt + 3,
        updatedAt: session.updatedAt + 3,
      },
    );

    const items = buildAgentTimeline({ session, pendingDiffs: [], appliedDiffs: [] });
    expect(items.find((item) => item.kind === 'exploration_summary')).toMatchObject({
      text: 'Explored 2 files, 2 searches',
      filePaths: ['backend/reset.py', 'backend/jobs.py'],
      searches: [{ query: 'proposal state' }, { query: 'clear all versions', glob: '*.py' }],
    });
  });

  it('hides internal tool errors and noisy model-turn status while keeping live progress', () => {
    const session = createSession();
    session.messages = [{ id: 'user-1', role: 'user', content: 'Fix the agent bar.', createdAt: session.createdAt }];
    session.toolCalls = [];
    session.verificationResults = [];
    session.runFeed = [
      {
        id: 'status-1',
        kind: 'progress',
        title: 'Waiting for model turn.',
        status: 'running',
        createdAt: session.createdAt + 1,
      },
      {
        id: 'tool-1',
        kind: 'tool',
        title: 'read_file failed',
        detail: 'File not found or unreadable: .agent/tests/run:1/result.test.ts',
        status: 'error',
        createdAt: session.createdAt + 2,
      },
      {
        id: 'status-2',
        kind: 'progress',
        title: 'Reviewing the agent timeline renderer.',
        status: 'running',
        createdAt: session.createdAt + 3,
      },
    ];

    const items = buildAgentTimeline({ session, pendingDiffs: [], appliedDiffs: [] });

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'assistant_text', content: 'Reviewing the agent timeline renderer.' }),
      ]),
    );
    expect(items.some((item) => item.kind === 'error')).toBe(false);
    expect(items.some((item) => 'content' in item && item.content === 'Waiting for model turn.')).toBe(false);
    expect(items.some((item) => 'text' in item && item.text.includes('File not found'))).toBe(false);
  });

  it('cleans repeated blocked-run catch-up messages into one plain blocker', () => {
    const session = createSession();
    session.toolCalls = [];
    session.verificationResults = [];
    session.messages = [
      { id: 'user-1', role: 'user', content: 'Fix the agent panel.', createdAt: session.createdAt },
      {
        id: 'assistant-1',
        role: 'assistant',
        content:
          'attempt_completion(success=false, summary="Read the approved plan, but validation was blocked because npm run typecheck failed with spawn ... ENOENT. No source files were modified.")',
        createdAt: session.createdAt + 1,
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content:
          'I couldn’t complete verification because the workspace command runner is nonfunctional here: every attempted command fails with spawn ... ENOENT. No source files were modified.',
        createdAt: session.createdAt + 2,
      },
      {
        id: 'assistant-3',
        role: 'assistant',
        content: 'The workspace is still unable to spawn commands, so I cannot make or verify any repository change. No files were modified.',
        createdAt: session.createdAt + 3,
      },
      {
        id: 'assistant-4',
        role: 'assistant',
        content:
          'Subagent failed: refactorer: Reviewed the current workspace evidence, but this run is constrained to suggest-only review and source edits are blocked.',
        createdAt: session.createdAt + 4,
      },
    ];

    const items = buildAgentTimeline({ session, pendingDiffs: [], appliedDiffs: [] });
    const text = items.map((item) => ('content' in item ? item.content : 'text' in item ? item.text : '')).join('\n');

    expect(text).toContain('The run is blocked because commands cannot start in this workspace. No files were changed.');
    expect(text).toContain('Refactorer could only inspect the repo; it could not make changes in this run.');
    expect(text).not.toMatch(/attempt_completion|success=false|summary=/);
    expect((text.match(/commands cannot start in this workspace/g) ?? [])).toHaveLength(1);
    expect((text.match(/No files were changed/g) ?? [])).toHaveLength(1);
  });
});

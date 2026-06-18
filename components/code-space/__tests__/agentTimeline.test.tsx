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
      'status_summary',
      'patch_card',
      'review_gate',
      'validation_summary',
    ]);
    expect(items.find((item) => item.kind === 'status_summary')).toMatchObject({
      text: 'Explored 1 file, 1 search',
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
        input: { query: 'clear all versions' },
        output: 'ok',
        createdAt: session.updatedAt + 3,
        updatedAt: session.updatedAt + 3,
      },
    );

    const items = buildAgentTimeline({ session, pendingDiffs: [], appliedDiffs: [] });
    expect(items.find((item) => item.kind === 'status_summary')).toMatchObject({
      text: 'Explored 2 files, 2 searches',
    });
  });
});

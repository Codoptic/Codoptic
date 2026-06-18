import { describe, expect, it } from 'vitest';
import { appendPatchHistory, appendRunFeedEvent } from '../agentRunFeed';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import type { AgentRunFeedEntry } from '@/lib/code-space/core';

describe('agentRunFeed', () => {
  it('projects progress, patch, terminal, and validation events into feed entries', () => {
    const patchEvent: AgentSSEEvent = {
      type: 'patch_history',
      patch: {
        patchId: 'patch-1',
        batchId: 'batch-1',
        filePath: 'src/app.ts',
        mode: 'applied',
        status: 'applied',
        added: 2,
        removed: 1,
        hunks: 1,
        diff: '@@ -1 +1 @@\n-old\n+new',
        createdAt: 10,
      },
    };

    const events: AgentSSEEvent[] = [
      { type: 'agent_status', status: { id: 'status-1', title: 'Tracing files', status: 'running', createdAt: 1 } },
      patchEvent,
      { type: 'terminal_chunk', chunk: 'npm test\n', stream: 'stdout', command: 'npm test' },
      { type: 'validation_result', id: 'v1', command: 'npm test', status: 'passed', output: 'ok' },
    ];
    const feed = events.reduce<AgentRunFeedEntry[]>((current, event, index) => appendRunFeedEvent(current, event, index + 1), []);

    expect(feed.map((entry) => entry.kind)).toEqual(['progress', 'patch', 'terminal', 'validation']);
    expect(feed[1]).toMatchObject({ filePath: 'src/app.ts', added: 2, removed: 1 });
    expect(appendPatchHistory([], patchEvent)).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { buildAgentRuntimeHistory } from '../agentRuntimeHistory';
import type { CodeSpaceMessage } from '@/lib/code-space/core';

describe('buildAgentRuntimeHistory', () => {
  it('drops UI-only reasoning messages before sending clarification follow-up history to the runtime', () => {
    const messages: CodeSpaceMessage[] = [
      { id: 'user-1', role: 'user', content: 'Plan this workflow.', createdAt: 1 },
      { id: 'thinking-1', role: 'reasoning', content: 'Internal planner reasoning.', createdAt: 2 },
      { id: 'assistant-1', role: 'assistant', content: 'Answer these questions.', createdAt: 3 },
      { id: 'user-2', role: 'user', content: 'Plan clarification answers: A', createdAt: 4 },
    ];

    const history = buildAgentRuntimeHistory(messages, 'user-2', 'Plan clarification answers: A', 'Always verify first.');

    expect(history).toEqual([
      {
        role: 'user',
        content: 'Plan this workflow.\n\nAdditional user instructions:\nAlways verify first.',
      },
      { role: 'assistant', content: 'Answer these questions.' },
      {
        role: 'user',
        content: 'Plan clarification answers: A\n\nAdditional user instructions:\nAlways verify first.',
      },
    ]);
  });
});

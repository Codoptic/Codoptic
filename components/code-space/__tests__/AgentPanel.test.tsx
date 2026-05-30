import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPanel } from '../AgentPanel';
import { splitUnifiedDiffIntoHunks } from '../diffHunks';
import type { CodeSpaceAgentSession } from '@/lib/code-space/core';
import type { CodeSpaceAgentMode } from '@/lib/code-space/agentModes';
import type { CodeSpaceExecutionPolicy } from '@/lib/code-space/executionPolicy';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function createSession(): CodeSpaceAgentSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Plan session',
    status: 'planning',
    mode: 'plan',
    messages: [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'Plan ready.',
        createdAt: Date.now(),
      },
    ],
    toolCalls: [],
    plan: [],
    clarifyingQuestions: [],
    planMarkdown: {
      filePath: '.agent/plans/session-1.md',
      content: '# Plan',
      createdAt: Date.now(),
      buildStatus: 'available',
    },
    todos: [],
    changesets: [],
    verificationResults: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archived: false,
    localCacheVersion: 0,
    toolBudget: 50,
    toolCallCount: 0,
    filesChanged: [],
    agentChangesets: [],
  };
}

function renderPanel(
  onOpenPlanFile = vi.fn(),
  overrides: Partial<React.ComponentProps<typeof AgentPanel>> = {},
) {
  const session = createSession();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <AgentPanel
        session={session}
        sessions={[session]}
        isRunning={false}
        toolBudget={50}
        pendingDiffs={[]}
        appliedDiffs={[]}
        providerSummary="foundry/gpt-5-mini"
        agentMode={'plan' as CodeSpaceAgentMode}
        executionPolicy={'manual' as CodeSpaceExecutionPolicy}
        onOpenModelConfig={vi.fn()}
        onGenerateDiagram={vi.fn()}
        onOpenAppPlanner={vi.fn()}
        onAgentModeChange={vi.fn()}
        onExecutionPolicyChange={vi.fn()}
        canGenerateDiagram={false}
        onSelectSession={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onCancelRun={vi.fn()}
        onAcceptDiff={vi.fn()}
        onRejectDiff={vi.fn()}
        onOpenPlanFile={onOpenPlanFile}
        {...overrides}
      />,
    );
  });

  return { container, onOpenPlanFile };
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('AgentPanel', () => {
  it('forwards View plan clicks to the open-plan handler', () => {
    const { container, onOpenPlanFile } = renderPanel();
    const viewPlanButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('View plan...'),
    );

    act(() => {
      viewPlanButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenPlanFile).toHaveBeenCalledWith('.agent/plans/session-1.md');
  });

  it('hides the build button once the plan has been built', () => {
    const session = createSession();
    session.planMarkdown = { ...session.planMarkdown!, buildStatus: 'completed' };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <AgentPanel
          session={session}
          sessions={[session]}
          isRunning={false}
          toolBudget={50}
          pendingDiffs={[]}
          appliedDiffs={[]}
          providerSummary="foundry/gpt-5-mini"
          agentMode={'plan' as CodeSpaceAgentMode}
          executionPolicy={'manual' as CodeSpaceExecutionPolicy}
          onOpenModelConfig={vi.fn()}
          onGenerateDiagram={vi.fn()}
          onOpenAppPlanner={vi.fn()}
          onAgentModeChange={vi.fn()}
          onExecutionPolicyChange={vi.fn()}
          canGenerateDiagram={false}
          onSelectSession={vi.fn()}
          onRenameSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onSubmitPrompt={vi.fn()}
          onCancelRun={vi.fn()}
          onAcceptDiff={vi.fn()}
          onRejectDiff={vi.fn()}
          onOpenPlanFile={vi.fn()}
        />,
      );
    });

    const buildButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Build'));
    expect(buildButton).toBeUndefined();
  });



  it('opens changed file when clicking diff file button', () => {
    const onOpenDiffFile = vi.fn();
    const unifiedDiff = '@@ -1 +1 @@\n-a\n+b';
    const pendingDiffs = [
      {
        diffId: 'd1',
        filePath: 'src/example.ts',
        oldContent: 'a',
        newContent: 'b',
        unifiedDiff,
        hunks: splitUnifiedDiffIntoHunks(unifiedDiff, 'a', 'b'),
        hunkStatus: {},
      },
    ];
    const { container } = renderPanel(vi.fn(), { pendingDiffs, onOpenDiffFile });
    const fileButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('src/example.ts'));
    act(() => {
      fileButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenDiffFile).toHaveBeenCalledWith('src/example.ts');
  });

  it('shows Accept and Reject actions in confirm mode for pending changes', () => {
    const unifiedDiff = '@@ -1 +1 @@\n-a\n+b';
    const pendingDiffs = [
      {
        diffId: 'd1',
        filePath: 'src/example.ts',
        oldContent: 'a',
        newContent: 'b',
        unifiedDiff,
        hunks: splitUnifiedDiffIntoHunks(unifiedDiff, 'a', 'b'),
        hunkStatus: {},
      },
    ];
    const { container } = renderPanel(vi.fn(), { pendingDiffs, executionPolicy: 'manual' as CodeSpaceExecutionPolicy });
    expect(container.textContent).toContain('Accept');
    expect(container.textContent).toContain('Reject');
    expect(container.textContent).toContain('+1');
    expect(container.textContent).toContain('-1');
    expect(container.textContent).toContain('1 patch');
  });

  it('keeps applied patch containers visible in the code changes rail', () => {
    const appliedDiffs = [
      {
        filePath: 'components/example.tsx',
        beforeContent: 'old',
        afterContent: 'new',
        acceptedAt: Date.now(),
      },
    ];
    const { container } = renderPanel(vi.fn(), { appliedDiffs });
    expect(container.textContent).toContain('Code changes');
    expect(container.textContent).toContain('components/example.tsx');
    expect(container.textContent).toContain('Applied change');
  });
});

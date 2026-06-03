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

function openSection(container: HTMLDivElement, title: string): void {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(title));
  if (!button) return;
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
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
        onEditPrompt={vi.fn()}
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
          onEditPrompt={vi.fn()}
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

  it('renders icon-only planner shortcuts with hover labels', () => {
    const { container } = renderPanel();
    const buttons = Array.from(container.querySelectorAll('button'));
    const generateDiagramButton = buttons.find((button) => button.getAttribute('aria-label') === 'Generate Diagram');
    const appPlannerButton = buttons.find((button) => button.getAttribute('aria-label') === 'App Planner');

    expect(generateDiagramButton).toBeDefined();
    expect(generateDiagramButton?.textContent?.trim()).toBe('');
    expect(generateDiagramButton?.getAttribute('title')).toBe('Generate Diagram');
    expect(appPlannerButton).toBeDefined();
    expect(appPlannerButton?.textContent?.trim()).toBe('');
    expect(appPlannerButton?.getAttribute('title')).toBe('App Planner');
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

  it('shows a cursor-style activity summary for file and search tool calls', () => {
    const session = createSession();
    session.toolCalls = [
      {
        id: 'tool-1',
        name: 'read_file',
        status: 'success',
        summary: 'Completed in 9ms',
        input: { path: 'components/code-space/BottomPanel.tsx', startLine: 1, endLine: 80 },
        output: 'ok',
        createdAt: Date.now() - 2_000,
        updatedAt: Date.now() - 1_900,
      },
      {
        id: 'tool-2',
        name: 'search_text',
        status: 'success',
        summary: 'Completed in 12ms',
        input: { query: 'Explored x files, y searches', glob: '*.tsx' },
        output: 'ok',
        createdAt: Date.now() - 1_000,
        updatedAt: Date.now() - 900,
      },
    ];

    const { container } = renderPanel(vi.fn(), { session, sessions: [session] });
    openSection(container, 'Explored 1 file, 1 search');

    expect(container.textContent).toContain('Explored 1 file, 1 search');
    expect(container.textContent).toContain('Read BottomPanel.tsx L1-80');
    expect(container.textContent).toContain('Searched Explored x files, y searches');
  });

  it('keeps raw tool JSON out of the session subtitle', () => {
    const session = createSession();
    session.messages = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'Thinking through the plan.',
        createdAt: Date.now() - 2_000,
      },
      {
        id: 'msg-2',
        role: 'tool',
        content: 'Started read_file: { "path": "components/code-space/BottomPanel.tsx" }',
        createdAt: Date.now() - 1_000,
      },
    ];

    const { container } = renderPanel(vi.fn(), { session, sessions: [session] });
    openSection(container, 'Session');

    expect(container.textContent).toContain('Thinking through the plan.');
    expect(container.textContent).not.toContain('Started read_file: {');
  });

  it('renders mention links in chat messages as chips', () => {
    const session = createSession();
    session.messages = [
      {
        id: 'msg-1',
        role: 'user',
        content: 'Fully refactor the agentic workflow in [app/](system/app) so the project makes decisions.',
        createdAt: Date.now(),
      },
    ];

    const { container } = renderPanel(vi.fn(), { session, sessions: [session] });
    const chip = container.querySelector('[data-mention-chip="true"]');

    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe('app/');
    expect(chip?.getAttribute('title')).toBe('system/app');
    expect(chip?.getAttribute('data-mention-path')).toBe('system/app');
  });

  it('shows copy and edit actions below user prompts', async () => {
    const session = createSession();
    session.messages = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Refactor this prompt',
        createdAt: Date.now(),
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Working on it.',
        createdAt: Date.now(),
      },
    ];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const onEditPrompt = vi.fn();
    const { container } = renderPanel(vi.fn(), { session, sessions: [session], onEditPrompt });

    const copyButton = Array.from(container.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === 'Copy prompt');
    const editButton = Array.from(container.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === 'Edit prompt and rewind context');

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(writeText).toHaveBeenCalledWith('Refactor this prompt');
    expect(onEditPrompt).toHaveBeenCalledWith('user-1');
  });
});

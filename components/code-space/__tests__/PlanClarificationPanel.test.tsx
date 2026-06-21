import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanClarificationPanel } from '../PlanClarificationPanel';
import type { CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const questions: CodeSpaceClarifyingQuestion[] = [
  {
    id: 'scope',
    question: 'What scope should the implementation plan optimize for?',
    choices: ['Smallest safe change', 'Production-ready feature pass'],
  },
  {
    id: 'validation',
    question: 'What validation should be treated as the acceptance gate?',
    choices: ['Typecheck and unit tests', 'Full build and browser verification'],
  },
];

function TestHarness(props: Partial<React.ComponentProps<typeof PlanClarificationPanel>> = {}) {
  const [answers, setAnswers] = React.useState<Record<string, string[]>>(props.answers ?? {});
  const onSubmitAnswers = props.onSubmitAnswers ?? vi.fn();
  return (
    <PlanClarificationPanel
      questions={props.questions ?? questions}
      answers={answers}
      onAnswersChange={setAnswers}
      disabled={props.disabled ?? false}
      onSubmitAnswers={onSubmitAnswers}
    />
  );
}

function renderPanel(props: Partial<React.ComponentProps<typeof PlanClarificationPanel>> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onSubmitAnswers = props.onSubmitAnswers ?? vi.fn();
  act(() => {
    root?.render(<TestHarness {...props} onSubmitAnswers={onSubmitAnswers} />);
  });
  return { container, onSubmitAnswers };
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('PlanClarificationPanel', () => {
  it('does not render when no MCQ questions are pending', () => {
    const { container } = renderPanel({ questions: [] });

    expect(container.querySelector('[data-testid="plan-clarification-panel"]')).toBeNull();
  });

  it('submits selected MCQ answers in a follow-up prompt', () => {
    const { container, onSubmitAnswers } = renderPanel();
    const firstOption = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Smallest safe change'),
    );
    const secondOption = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Full build and browser verification'),
    );

    act(() => {
      firstOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      secondOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const submit = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Send answers'),
    );
    act(() => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSubmitAnswers).toHaveBeenCalledWith(expect.stringContaining('Smallest safe change'));
    expect(onSubmitAnswers).toHaveBeenCalledWith(expect.stringContaining('Full build and browser verification'));
  });
});

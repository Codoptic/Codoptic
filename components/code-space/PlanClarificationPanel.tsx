'use client';

import React from 'react';
import { useMemo } from 'react';
import { Check, HelpCircle, Send } from 'lucide-react';
import type { CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';

interface PlanClarificationPanelProps {
  questions: CodeSpaceClarifyingQuestion[];
  answers?: Record<string, string[]>;
  onAnswersChange?: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  disabled?: boolean;
  onSubmitAnswers: (prompt: string) => void;
}

function formatAnswerPrompt(questions: CodeSpaceClarifyingQuestion[], answers: Record<string, string[]>): string {
  const lines = questions.map((question, index) => {
    const selected = answers[question.id]?.join(', ') || '(no answer selected)';
    return `${index + 1}. ${question.question}\nAnswer: ${selected}`;
  });
  return ['Plan clarification answers:', '', ...lines].join('\n');
}

// Motivation vs Logic: Plan-mode clarifications are workflow controls, not chat prose. Keeping MCQs in a reusable sidebar panel lets the agent append targeted questions after scanning context while leaving the full planning document hidden until the final wrap-up.
export function PlanClarificationPanel({
  questions,
  answers = {},
  onAnswersChange,
  disabled = false,
  onSubmitAnswers,
}: PlanClarificationPanelProps) {
  const allAnswered = useMemo(
    () => questions.length > 0 && questions.every((question) => (answers[question.id]?.length ?? 0) > 0),
    [answers, questions],
  );

  if (!questions.length) return null;

  const toggleChoice = (question: CodeSpaceClarifyingQuestion, choice: string) => {
    if (disabled || !onAnswersChange) return;
    const existing = answers[question.id] ?? [];
    const selected = existing.includes(choice);
    const nextChoices = question.allowMultiple
      ? selected
        ? existing.filter((item) => item !== choice)
        : [...existing, choice]
      : selected
        ? []
        : [choice];
    onAnswersChange((current) => ({ ...current, [question.id]: nextChoices }));
  };

  return (
    <section
      data-testid="plan-clarification-panel"
      className="flex h-full min-h-0 max-h-full flex-col rounded border border-[#30363d] bg-[#0f141b] p-2"
      aria-label="Plan clarifying questions"
    >
      <div className="mb-2 flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wider text-[#8b949e]">
        <HelpCircle size={12} className="text-[#d2a8ff]" />
        <span>Clarify Plan</span>
      </div>
      <div
        data-testid="plan-clarification-questions"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-0.5 max-h-[min(55vh,32rem)]"
      >
        {questions.map((question, index) => {
          const selectedChoices = answers[question.id] ?? [];
          return (
            <div key={question.id} className="space-y-1.5">
              <div className="text-[10px] leading-4 text-[#c9d1d9]">
                <span className="text-[#6e7681]">{index + 1}. </span>
                {question.question}
              </div>
              {question.rationale && (
                <div className="text-[9px] leading-4 text-[#8b949e]">Why it matters: {question.rationale}</div>
              )}
              <div className="grid gap-1">
                {(question.options?.length
                  ? question.options
                  : question.choices.map((choice) => ({ label: choice, description: undefined }))
                ).map((option) => {
                  const selected = selectedChoices.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggleChoice(question, option.label)}
                      className={`flex min-h-8 items-start gap-2 rounded border px-2 py-1 text-left text-[10px] leading-4 transition ${
                        selected
                          ? 'border-[#8957e5] bg-[#2b1b40] text-[#f0e6ff]'
                          : 'border-[#30363d] bg-[#111111] text-[#c9d1d9] hover:border-[#58a6ff66] hover:bg-[#161b22]'
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${selected ? 'border-[#d2a8ff] bg-[#8957e5]' : 'border-[#6e7681]'}`}>
                        {selected && <Check size={10} />}
                      </span>
                      <span className="min-w-0 break-words">
                        <span className="block">{option.label}</span>
                        {option.description && <span className="mt-0.5 block text-[9px] text-[#8b949e]">{option.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        disabled={disabled || !allAnswered}
        onClick={() => onSubmitAnswers(formatAnswerPrompt(questions, answers))}
        className="mt-3 flex w-full shrink-0 items-center justify-center gap-1 rounded bg-[#8957e5] px-2 py-1.5 text-[10px] text-white hover:bg-[#a371f7] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Send size={11} />
        Send answers
      </button>
    </section>
  );
}

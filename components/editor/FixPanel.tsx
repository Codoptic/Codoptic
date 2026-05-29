'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Wrench } from 'lucide-react';
import { useDiagramStore } from '@/lib/state/store';
import { ProviderConfig } from '../agent/ProviderConfig';
import { AnalysisAnimation } from '../agent/AnalysisAnimation';
import { readAgentStream, readErrorMessage, type AgentStreamEvent } from '../agent/streamEvents';
import { FIX_CLARIFY_STAGES, FIX_APPLY_STAGES } from '@/lib/agent/planning/fixPipeline';
import type { ClarifyStreamOutput } from '@/lib/util/stream';

type Step = 'prompt' | 'questions' | 'generating' | 'complete';

interface AnswerState {
  selected: Set<string>;
  custom: string;
}

const OTHER_TOKEN = '__other__';

const FIX_PANEL_CACHE_KEY = 'codoptic:fix-panel:v1';

interface PersistedFixState {
  changeDescription: string;
  step: 'prompt' | 'questions' | 'complete';
  clarify: ClarifyStreamOutput | null;
  answers: Record<string, { selected: string[]; custom: string }>;
}

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function saveFixState(state: PersistedFixState): void {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(FIX_PANEL_CACHE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota errors
  }
}

function loadFixState(): PersistedFixState | null {
  if (!canUseLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(FIX_PANEL_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedFixState;
  } catch {
    return null;
  }
}

interface Props {
  onFixApplied: () => void;
}

export function FixPanel({ onFixApplied }: Props) {
  const provider = useDiagramStore((s) => s.provider);
  const dsl = useDiagramStore((s) => s.dslText);
  const setDsl = useDiagramStore((s) => s.setDsl);
  const setAgentStage = useDiagramStore((s) => s.setAgentStage);
  const pushLog = useDiagramStore((s) => s.pushAgentLog);
  const startAgent = useDiagramStore((s) => s.startAgent);
  const stopAgent = useDiagramStore((s) => s.stopAgent);
  const agentRunning = useDiagramStore((s) => s.agentRunning);

  const [step, setStep] = useState<Step>('prompt');
  const [changeDescription, setChangeDescription] = useState('');
  const [clarify, setClarify] = useState<ClarifyStreamOutput | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [retryNotice, setRetryNotice] = useState<{ stage: string; attempt: number; delayMs: number; reason: string } | null>(null);
  const [counters, setCounters] = useState<Record<string, number>>({});
  const [terminalState, setTerminalState] = useState<{ status: 'failed' | 'cancelled'; message: string } | null>(null);
  const [phaseStages, setPhaseStages] = useState(FIX_APPLY_STAGES);
  const [showProviderConfig, setShowProviderConfig] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Restore persisted state on mount
  useEffect(() => {
    const saved = loadFixState();
    if (!saved) return;
    if (saved.changeDescription) setChangeDescription(saved.changeDescription);
    if (saved.step === 'questions' && saved.clarify) {
      setClarify(saved.clarify);
      const restored: Record<string, AnswerState> = {};
      for (const [qid, ans] of Object.entries(saved.answers)) {
        restored[qid] = { selected: new Set(ans.selected), custom: ans.custom };
      }
      setAnswers(restored);
      setStep('questions');
    } else if (saved.step === 'complete') {
      setStep('complete');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on every relevant state change
  useEffect(() => {
    if (step === 'generating') return;
    const serializedAnswers: Record<string, { selected: string[]; custom: string }> = {};
    for (const [qid, ans] of Object.entries(answers)) {
      serializedAnswers[qid] = { selected: [...ans.selected], custom: ans.custom };
    }
    saveFixState({
      changeDescription,
      step,
      clarify,
      answers: serializedAnswers,
    });
  }, [changeDescription, step, clarify, answers]);

  const currentModel =
    provider.provider === 'foundry' || provider.provider === 'deepseek' || provider.provider === 'nvidia'
      ? (provider.customModel ?? '?')
      : provider.model;

  const runClarify = async () => {
    if (!changeDescription.trim()) return;
    const sessionId = `fix-clarify-${Date.now()}`;
    startAgent(sessionId);
    setCounters({});
    setRetryNotice(null);
    setTerminalState(null);
    setClarify(null);
    setAnswers({});
    setPhaseStages(FIX_CLARIFY_STAGES);
    setStep('generating');

    let sawResult = false;
    let sawFailure = false;
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch('/api/agent/fix-clarify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.provider,
          model: currentModel,
          apiKey: provider.apiKey || undefined,
          endpoint: provider.endpoint || undefined,
          dsl,
          changeDescription: changeDescription.trim(),
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const message = await readErrorMessage(res);
        sawFailure = true;
        setTerminalState({ status: 'failed', message });
        pushLog({ stage: 'init', level: 'error', message });
        setStep('prompt');
        return;
      }
      await readAgentStream(res.body, (ev) => {
        if (ev.type === 'stage') {
          setAgentStage(ev.stage);
          if (ev.counters) setCounters((c) => ({ ...c, ...ev.counters }));
          if (ev.message) pushLog({ stage: ev.stage, level: 'info', message: `${ev.status}: ${ev.message}` });
        } else if (ev.type === 'retry') {
          setRetryNotice({ stage: ev.stage, attempt: ev.attempt, delayMs: ev.delayMs, reason: ev.reason });
          pushLog({ stage: ev.stage, level: 'warn', message: `retry #${ev.attempt} in ${Math.round(ev.delayMs / 1000)}s — ${ev.reason}` });
        } else if (ev.type === 'log') {
          pushLog({ stage: ev.stage, level: ev.level, message: ev.message });
        } else if (ev.type === 'error') {
          sawFailure = true;
          setTerminalState({ status: 'failed', message: ev.message });
          pushLog({ stage: ev.stage, level: 'error', message: ev.message });
        } else if (ev.type === 'result-clarify') {
          sawResult = true;
          setClarify(ev.output);
          const seeded: Record<string, AnswerState> = {};
          for (const q of ev.output.questions) {
            seeded[q.id] = { selected: new Set(), custom: '' };
          }
          setAnswers(seeded);
          setStep('questions');
        } else if (ev.type === 'done') {
          setAgentStage(null);
        }
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        sawFailure = true;
        setTerminalState({ status: 'cancelled', message: 'Cancelled' });
        pushLog({ stage: 'init', level: 'info', message: 'Cancelled' });
        setStep('prompt');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        sawFailure = true;
        setTerminalState({ status: 'failed', message });
        pushLog({ stage: 'init', level: 'error', message });
        setStep('prompt');
      }
    } finally {
      if (!sawResult && !sawFailure && !ac.signal.aborted) {
        setTerminalState({ status: 'failed', message: 'Clarification ended before questions were produced.' });
        setStep('prompt');
      }
      stopAgent();
      abortRef.current = null;
    }
  };

  const applyFix = async (withAnswers: boolean) => {
    const sessionId = `fix-${Date.now()}`;
    startAgent(sessionId);
    setCounters({});
    setRetryNotice(null);
    setTerminalState(null);
    setPhaseStages(FIX_APPLY_STAGES);
    setStep('generating');

    const compiledAnswers =
      withAnswers && clarify
        ? clarify.questions.map((q) => {
            const ans = answers[q.id] ?? { selected: new Set<string>(), custom: '' };
            return {
              question_id: q.id,
              question: q.question,
              selected_options: [...ans.selected].filter((s) => s !== OTHER_TOKEN),
              custom_text: ans.custom.trim() ? ans.custom.trim() : undefined,
            };
          })
        : [];

    let sawResult = false;
    let sawFailure = false;
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch('/api/agent/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.provider,
          model: currentModel,
          apiKey: provider.apiKey || undefined,
          endpoint: provider.endpoint || undefined,
          dsl,
          changeDescription: changeDescription.trim(),
          intentSummary: clarify?.intent_summary,
          answers: compiledAnswers,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const message = await readErrorMessage(res);
        sawFailure = true;
        setTerminalState({ status: 'failed', message });
        pushLog({ stage: 'init', level: 'error', message });
        setStep(withAnswers ? 'questions' : 'prompt');
        return;
      }
      await readAgentStream(res.body, (ev: AgentStreamEvent) => {
        if (ev.type === 'stage') {
          setAgentStage(ev.stage);
          if (ev.counters) setCounters((c) => ({ ...c, ...ev.counters }));
          if (ev.message) pushLog({ stage: ev.stage, level: 'info', message: `${ev.status}: ${ev.message}` });
        } else if (ev.type === 'retry') {
          setRetryNotice({ stage: ev.stage, attempt: ev.attempt, delayMs: ev.delayMs, reason: ev.reason });
          pushLog({ stage: ev.stage, level: 'warn', message: `retry #${ev.attempt} in ${Math.round(ev.delayMs / 1000)}s — ${ev.reason}` });
        } else if (ev.type === 'log') {
          pushLog({ stage: ev.stage, level: ev.level, message: ev.message });
        } else if (ev.type === 'error') {
          sawFailure = true;
          setTerminalState({ status: 'failed', message: ev.message });
          pushLog({ stage: ev.stage, level: 'error', message: ev.message });
        } else if (ev.type === 'result') {
          sawResult = true;
          setDsl(ev.dsl);
          setStep('complete');
          onFixApplied();
        } else if (ev.type === 'done') {
          setAgentStage(null);
        }
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        sawFailure = true;
        setTerminalState({ status: 'cancelled', message: 'Cancelled' });
        pushLog({ stage: 'init', level: 'info', message: 'Cancelled' });
        setStep(withAnswers ? 'questions' : 'prompt');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        sawFailure = true;
        setTerminalState({ status: 'failed', message });
        pushLog({ stage: 'init', level: 'error', message });
        setStep(withAnswers ? 'questions' : 'prompt');
      }
    } finally {
      if (!sawResult && !sawFailure && !ac.signal.aborted) {
        setTerminalState({ status: 'failed', message: 'Fix ended before a new diagram was produced.' });
        setStep(withAnswers ? 'questions' : 'prompt');
      }
      stopAgent();
      abortRef.current = null;
    }
  };

  const onCancel = () => abortRef.current?.abort();

  const toggleOption = (qid: string, label: string, allowMultiple: boolean) => {
    setAnswers((prev) => {
      const cur = prev[qid] ?? { selected: new Set(), custom: '' };
      const next = new Set(cur.selected);
      if (allowMultiple) {
        if (next.has(label)) next.delete(label);
        else next.add(label);
      } else {
        next.clear();
        next.add(label);
      }
      return { ...prev, [qid]: { ...cur, selected: next } };
    });
  };

  const setCustomText = (qid: string, value: string) => {
    setAnswers((prev) => {
      const cur = prev[qid] ?? { selected: new Set(), custom: '' };
      const nextSelected = new Set(cur.selected);
      if (value.trim()) nextSelected.add(OTHER_TOKEN);
      else nextSelected.delete(OTHER_TOKEN);
      return { ...prev, [qid]: { selected: nextSelected, custom: value } };
    });
  };

  const allAnswered = useMemo(() => {
    if (!clarify) return false;
    return clarify.questions.every((q) => {
      const a = answers[q.id];
      if (!a) return false;
      return a.selected.size > 0;
    });
  }, [clarify, answers]);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto bg-ink-950 p-3 text-xs space-y-3">

        {/* Provider row */}
        <div>
          <button
            type="button"
            onClick={() => setShowProviderConfig((v) => !v)}
            className="flex w-full items-center justify-between rounded-md border border-ink-700 bg-ink-900 px-2.5 py-2 text-[10px] uppercase tracking-wider text-ink-400 hover:bg-ink-800 transition-colors"
          >
            <span>
              AI Provider ·{' '}
              <span className="font-mono text-ink-200">{provider.provider}</span>
              {' / '}
              <span className="font-mono text-ink-200">{currentModel}</span>
            </span>
            <span className="text-ink-500">{showProviderConfig ? '▲' : '▼'}</span>
          </button>
          {showProviderConfig && (
            <div className="mt-2">
              <ProviderConfig />
            </div>
          )}
        </div>

        {/* Main panel */}
        <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-3 space-y-3">
          <div className="flex items-center gap-2">
            <Wrench size={12} className="text-accent" />
            <div className="text-[10px] uppercase tracking-widest text-ink-400">
              {step === 'prompt' && 'Describe your change'}
              {step === 'questions' && 'Clarifying questions'}
              {step === 'generating' && 'Working…'}
              {step === 'complete' && 'Fix applied'}
            </div>
            {step === 'questions' && (
              <button
                type="button"
                onClick={() => { setStep('prompt'); setClarify(null); setAnswers({}); }}
                className="ml-auto text-[10px] text-ink-400 underline-offset-2 hover:underline"
              >
                ← back
              </button>
            )}
          </div>

          {/* Prompt step */}
          {step === 'prompt' && (
            <div className="space-y-2">
              <textarea
                value={changeDescription}
                onChange={(e) => setChangeDescription(e.target.value)}
                placeholder={'e.g. "Add a Redis cache layer between the API Gateway and the Database group, using teal color and dashed edges."'}
                rows={5}
                className="w-full rounded-md border border-ink-700 bg-ink-900 px-2.5 py-2 text-xs placeholder:text-ink-600 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
              <p className="text-[10px] text-ink-500">
                Choose how to proceed — fix directly (faster) or clarify ambiguous details first.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => applyFix(false)}
                  disabled={!changeDescription.trim() || agentRunning || !dsl.trim()}
                  className="flex-1 rounded-md border border-accent/50 bg-accent/20 px-3 py-2 text-xs text-accent hover:bg-accent/30 disabled:opacity-40 transition-colors"
                >
                  Fix directly
                </button>
                <button
                  onClick={runClarify}
                  disabled={!changeDescription.trim() || agentRunning || !dsl.trim()}
                  className="flex-1 rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-xs text-ink-200 hover:bg-ink-700 disabled:opacity-40 transition-colors"
                >
                  Clarify first →
                </button>
              </div>
              {!dsl.trim() && (
                <p className="text-[10px] text-yellow-400/80">No diagram loaded — write or generate a diagram in the DSL tab first.</p>
              )}
            </div>
          )}

          {/* Questions step */}
          {step === 'questions' && clarify && (
            <div className="space-y-3">
              <div className="rounded-md border border-accent/30 bg-accent/5 px-2.5 py-2 text-[10px] text-ink-200">
                <span className="text-[9px] uppercase tracking-widest text-accent">Restated intent</span>
                <div className="mt-1">{clarify.intent_summary}</div>
              </div>

              {clarify.questions.map((q, idx) => {
                const ans = answers[q.id] ?? { selected: new Set<string>(), custom: '' };
                return (
                  <div key={q.id} className="space-y-1.5 rounded-lg border border-ink-700 bg-ink-850/60 p-2.5">
                    <div className="flex items-start gap-1.5">
                      <span className="mt-0.5 text-[9px] text-ink-500 flex-shrink-0">Q{idx + 1}</span>
                      <span className="text-xs text-ink-100 flex-1">{q.question}</span>
                      {q.allow_multiple && (
                        <span className="flex-shrink-0 rounded-sm border border-ink-700 px-1 py-0.5 text-[8px] uppercase tracking-wider text-ink-400">
                          multi
                        </span>
                      )}
                    </div>
                    {q.rationale && <div className="pl-4 text-[10px] text-ink-500">{q.rationale}</div>}

                    <div className="space-y-1 pl-1">
                      {q.options.map((opt) => {
                        const selected = ans.selected.has(opt.label);
                        return (
                          <button
                            key={opt.label}
                            type="button"
                            onClick={() => toggleOption(q.id, opt.label, q.allow_multiple)}
                            className={`w-full rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors ${
                              selected
                                ? 'border-accent/60 bg-accent/10'
                                : 'border-ink-700 bg-ink-800 hover:bg-ink-700'
                            }`}
                          >
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`flex h-3 w-3 flex-shrink-0 items-center justify-center border text-[8px] ${
                                  q.allow_multiple ? 'rounded-sm' : 'rounded-full'
                                } ${selected ? 'border-accent bg-accent/30 text-accent' : 'border-ink-600'}`}
                              >
                                {selected ? '✓' : ''}
                              </span>
                              <span className="text-ink-100">{opt.label}</span>
                            </div>
                            <div className="mt-0.5 pl-5 text-[9px] text-ink-400">{opt.description}</div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Other free-text */}
                    <div className="space-y-1 rounded-md border border-dashed border-ink-700 bg-ink-900/40 p-1.5 pl-1">
                      <label className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-ink-400">
                        <span
                          className={`flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-sm border text-[8px] ${
                            ans.selected.has(OTHER_TOKEN)
                              ? 'border-accent bg-accent/30 text-accent'
                              : 'border-ink-600'
                          }`}
                        >
                          {ans.selected.has(OTHER_TOKEN) ? '✓' : ''}
                        </span>
                        Other — your own words
                      </label>
                      <input
                        value={ans.custom}
                        onChange={(e) => setCustomText(q.id, e.target.value)}
                        placeholder="Type a custom answer…"
                        className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-[11px]"
                      />
                    </div>
                  </div>
                );
              })}

              <div className="flex items-center justify-between pt-1">
                <div className="text-[10px] text-ink-400">
                  {allAnswered ? 'All answered.' : 'Answer each question to continue.'}
                </div>
                <button
                  onClick={() => applyFix(true)}
                  disabled={!allAnswered || agentRunning}
                  className="rounded-md border border-accent/50 bg-accent/20 px-3 py-2 text-xs text-accent hover:bg-accent/30 disabled:opacity-40 transition-colors"
                >
                  Apply fix →
                </button>
              </div>
            </div>
          )}

          {/* Complete step */}
          {step === 'complete' && (
            <div className="space-y-2.5">
              <div className="rounded-md border border-green-500/30 bg-green-500/10 px-2.5 py-2 text-[11px] text-green-300">
                ✓ Diagram updated. Switched to DSL tab to show changes.
              </div>
              <button
                type="button"
                onClick={() => {
                  setStep('prompt');
                  setChangeDescription('');
                  setClarify(null);
                  setAnswers({});
                }}
                className="rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1.5 text-[11px] text-ink-200 hover:bg-ink-700 transition-colors"
              >
                Make another change
              </button>
            </div>
          )}
        </div>
      </div>

      {(agentRunning || terminalState) && (
        <AnalysisAnimation
          retryNotice={retryNotice}
          counters={counters}
          onCancel={onCancel}
          onDismiss={() => setTerminalState(null)}
          terminalState={terminalState}
          stages={phaseStages}
        />
      )}
    </div>
  );
}

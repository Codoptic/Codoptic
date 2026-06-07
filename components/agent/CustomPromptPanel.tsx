'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpenText, Layers3, Sparkles, SquareIcon } from 'lucide-react';
import { useDiagramStore, type MultiLayerOutput } from '@/lib/state/store';
import { ProviderConfig } from './ProviderConfig';
import { AnalysisAnimation } from './AnalysisAnimation';
import { readAgentStream, readErrorMessage, type AgentStreamEvent } from './streamEvents';
import type { ClarifyStreamOutput } from '@/lib/util/stream';
import { extractFallbackName } from '@/lib/code-space/sessionNaming';

type Step = 'prompt' | 'questions' | 'generating';
type DiagramStyle = 'single' | 'multi-layer';

interface AnswerState {
  selected: Set<string>;
  custom: string;
}

const CLARIFY_STAGES = [
  { id: 'validate', label: 'Validating credentials' },
  { id: 'clarify', label: 'Drafting clarifying questions' },
];

const SINGLE_PLAN_STAGES = [
  { id: 'validate', label: 'Validating credentials' },
  { id: 'plan', label: 'Designing diagram from prompt + answers' },
  { id: 'compile', label: 'Compiling DSL' },
  { id: 'validate-dsl', label: 'Validating syntax' },
];

const INSTRUCTION_STAGE = { id: 'instruction', label: 'Writing Instruction Mode guide' };

const MULTI_PLAN_STAGES = [
  { id: 'validate', label: 'Validating credentials' },
  { id: 'layer-plan', label: 'Planning layer structure' },
  { id: 'overview', label: 'Compiling overview diagram' },
  { id: 'sub-plans', label: 'Generating per-layer diagrams' },
];

const OTHER_TOKEN = '__other__';

const CUSTOM_PROMPT_CACHE_KEY = 'codoptic:custom-prompt:v1';

interface PersistedCustomPromptState {
  prompt: string;
  step: 'prompt' | 'questions';
  diagramStyle: DiagramStyle;
  instructionMode: boolean;
  clarify: ClarifyStreamOutput | null;
  answers: Record<string, { selected: string[]; custom: string }>;
}

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function saveCustomPromptState(state: PersistedCustomPromptState): void {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(CUSTOM_PROMPT_CACHE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota errors
  }
}

function loadCustomPromptState(): PersistedCustomPromptState | null {
  if (!canUseLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(CUSTOM_PROMPT_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedCustomPromptState;
  } catch {
    return null;
  }
}

export function CustomPromptPanel() {
  const provider = useDiagramStore((s) => s.provider);
  const setMode = useDiagramStore((s) => s.setMode);
  const setDsl = useDiagramStore((s) => s.setDsl);
  const setMultiLayer = useDiagramStore((s) => s.setMultiLayer);
  const setActiveLayer = useDiagramStore((s) => s.setActiveLayer);
  const setInstructionMarkdown = useDiagramStore((s) => s.setInstructionMarkdown);
  const clearOverrides = useDiagramStore((s) => s.clearOverrides);
  const addGeneratedProject = useDiagramStore((s) => s.addGeneratedProject);
  const setAgentStage = useDiagramStore((s) => s.setAgentStage);
  const pushLog = useDiagramStore((s) => s.pushAgentLog);
  const startAgent = useDiagramStore((s) => s.startAgent);
  const stopAgent = useDiagramStore((s) => s.stopAgent);
  const agentRunning = useDiagramStore((s) => s.agentRunning);

  const [step, setStep] = useState<Step>('prompt');
  const [prompt, setPrompt] = useState('');
  const [diagramStyle, setDiagramStyle] = useState<DiagramStyle>('single');
  const [instructionMode, setInstructionMode] = useState(false);
  const [clarify, setClarify] = useState<ClarifyStreamOutput | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [retryNotice, setRetryNotice] = useState<{ stage: string; attempt: number; delayMs: number; reason: string } | null>(null);
  const [counters, setCounters] = useState<Record<string, number>>({});
  const [terminalState, setTerminalState] = useState<{ status: 'failed' | 'cancelled'; message: string } | null>(null);
  const [activeStages, setActiveStages] = useState(CLARIFY_STAGES);
  const [animTitle, setAnimTitle] = useState('Generating questions…');
  const abortRef = useRef<AbortController | null>(null);
  const summaryUsesCustomModel =
    provider.provider === 'foundry' || provider.provider === 'deepseek' || provider.provider === 'nvidia' || provider.provider === 'openrouter';
  const summaryModel = summaryUsesCustomModel ? provider.customModel ?? '?' : provider.model;

  // Restore persisted state on mount
  useEffect(() => {
    const saved = loadCustomPromptState();
    if (!saved) return;
    if (saved.prompt) setPrompt(saved.prompt);
    if (saved.diagramStyle) setDiagramStyle(saved.diagramStyle);
    if (typeof saved.instructionMode === 'boolean') setInstructionMode(saved.instructionMode);
    if (saved.step === 'questions' && saved.clarify) {
      setClarify(saved.clarify);
      // Rehydrate Set-based answers from serialized arrays
      const restored: Record<string, AnswerState> = {};
      for (const [qid, ans] of Object.entries(saved.answers)) {
        restored[qid] = { selected: new Set(ans.selected), custom: ans.custom };
      }
      setAnswers(restored);
      setStep('questions');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist state whenever prompt/step/clarify/answers change
  useEffect(() => {
    if (step === 'generating') return; // don't persist mid-flight state
    const serializedAnswers: Record<string, { selected: string[]; custom: string }> = {};
    for (const [qid, ans] of Object.entries(answers)) {
      serializedAnswers[qid] = { selected: [...ans.selected], custom: ans.custom };
    }
    saveCustomPromptState({
      prompt,
      step: step as 'prompt' | 'questions',
      diagramStyle,
      instructionMode,
      clarify,
      answers: serializedAnswers,
    });
  }, [prompt, step, diagramStyle, instructionMode, clarify, answers]);

  // -------------------------------------------------------------------------
  // Step 1 → Step 2: ask clarifying questions
  // -------------------------------------------------------------------------
  const onAskQuestions = async () => {
    if (!prompt.trim()) return;
    const sessionId = `cp-${Date.now()}`;
    startAgent(sessionId);
    setCounters({});
    setRetryNotice(null);
    setTerminalState(null);
    setClarify(null);
    setAnswers({});
    setActiveStages(CLARIFY_STAGES);
    setAnimTitle('Generating questions…');
    setStep('generating');

    let sawResult = false;
    let sawFailure = false;
    const ac = new AbortController();
    abortRef.current = ac;

    const clarifyUsesCustomModel =
      provider.provider === 'foundry' || provider.provider === 'deepseek' || provider.provider === 'nvidia' || provider.provider === 'openrouter';
    const clarifyModel =
      clarifyUsesCustomModel
        ? (provider.customModel ?? provider.model)
        : provider.provider === 'local'
          ? (provider.localModelName ?? '')
          : provider.model;
    const clarifyApiKey =
      provider.provider === 'local'
        ? (provider.localApiKey ?? '')
        : (provider.apiKey || undefined);
    const clarifyEndpoint =
      provider.provider === 'local'
        ? (provider.localBaseUrl ?? undefined)
        : (provider.endpoint || undefined);
    const clarifyTemperature =
      provider.provider === 'local' ? (provider.localTemperature ?? 0.7) : undefined;
    const clarifyMaxTokens =
      provider.provider === 'local' ? (provider.localContextLength ?? 4096) : undefined;

    try {
      const res = await fetch('/api/agent/clarify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.provider,
          model: clarifyModel,
          apiKey: clarifyApiKey,
          endpoint: clarifyEndpoint,
          ...(clarifyTemperature !== undefined ? { temperature: clarifyTemperature } : {}),
          ...(clarifyMaxTokens !== undefined ? { maxTokens: clarifyMaxTokens } : {}),
          prompt,
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
      } else {
        const message = err instanceof Error ? err.message : String(err);
        sawFailure = true;
        setTerminalState({ status: 'failed', message });
        pushLog({ stage: 'init', level: 'error', message });
      }
      setStep('prompt');
    } finally {
      if (!sawResult && !sawFailure && !ac.signal.aborted) {
        setTerminalState({ status: 'failed', message: 'Clarification ended before questions were produced.' });
        setStep('prompt');
      }
      stopAgent();
      abortRef.current = null;
    }
  };

  // -------------------------------------------------------------------------
  // Step 2 → diagram: generate single or multi-layer
  // -------------------------------------------------------------------------
  const onGenerateDiagram = async () => {
    if (!clarify) return;

    const compiledAnswers = clarify.questions.map((q) => {
      const ans = answers[q.id] ?? { selected: new Set<string>(), custom: '' };
      return {
        question_id: q.id,
        question: q.question,
        selected_options: [...ans.selected].filter((s) => s !== OTHER_TOKEN),
        custom_text: ans.custom.trim() ? ans.custom.trim() : undefined,
      };
    });

    const isMulti = diagramStyle === 'multi-layer';
    const sessionId = `cp2-${Date.now()}`;
    startAgent(sessionId);
    setInstructionMarkdown('');
    setCounters({});
    setRetryNotice(null);
    setTerminalState(null);
    setActiveStages([
      ...(isMulti ? MULTI_PLAN_STAGES : SINGLE_PLAN_STAGES),
      ...(instructionMode ? [INSTRUCTION_STAGE] : []),
    ]);
    setAnimTitle(isMulti ? 'Generating multi-layer diagram…' : 'Generating diagram…');
    setStep('generating');

    let sawResult = false;
    let sawFailure = false;
    const ac = new AbortController();
    abortRef.current = ac;

    const apiEndpoint = isMulti ? '/api/agent/custom-multilayer' : '/api/agent/custom';

    const genUsesCustomModel =
      provider.provider === 'foundry' || provider.provider === 'deepseek' || provider.provider === 'nvidia' || provider.provider === 'openrouter';
    const genModel =
      genUsesCustomModel
        ? (provider.customModel ?? provider.model)
        : provider.provider === 'local'
          ? (provider.localModelName ?? '')
          : provider.model;
    const genApiKey =
      provider.provider === 'local'
        ? (provider.localApiKey ?? '')
        : (provider.apiKey || undefined);
    const genEndpoint =
      provider.provider === 'local'
        ? (provider.localBaseUrl ?? undefined)
        : (provider.endpoint || undefined);
    const genTemperature =
      provider.provider === 'local' ? (provider.localTemperature ?? 0.7) : undefined;
    const genMaxTokens =
      provider.provider === 'local' ? (provider.localContextLength ?? 4096) : undefined;

    let projectName = extractFallbackName(prompt, 2);

    try {
      const res = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.provider,
          model: genModel,
          apiKey: genApiKey,
          endpoint: genEndpoint,
          ...(genTemperature !== undefined ? { temperature: genTemperature } : {}),
          ...(genMaxTokens !== undefined ? { maxTokens: genMaxTokens } : {}),
          prompt,
          intentSummary: clarify.intent_summary,
          answers: compiledAnswers,
          instructionMode,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const message = await readErrorMessage(res);
        sawFailure = true;
        setTerminalState({ status: 'failed', message });
        pushLog({ stage: 'init', level: 'error', message });
        setStep('questions');
        return;
      }
      // Capture result data from the stream so we can await naming after the stream ends.
      // The `as` cast is needed because TypeScript's control-flow analysis cannot see
      // that the synchronous callback inside readAgentStream mutates this variable.
      type CapturedResult =
        | { kind: 'single'; dsl: string; instructionMarkdown: string }
        | { kind: 'multi'; out: MultiLayerOutput; instructionMarkdown: string };
      // eslint-disable-next-line prefer-const
      let capturedResult = null as CapturedResult | null;

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
          // Single-layer result — capture for async naming after stream ends
          sawResult = true;
          const instructionMarkdown = ev.instructionMarkdown ?? '';
          setInstructionMarkdown(instructionMarkdown);
          setDsl(ev.dsl);
          capturedResult = { kind: 'single', dsl: ev.dsl, instructionMarkdown };
        } else if (ev.type === 'result-multilayer') {
          // Multi-layer result — capture for async naming after stream ends
          sawResult = true;
          const instructionMarkdown = ev.instructionMarkdown ?? '';
          setInstructionMarkdown(instructionMarkdown);
          const out = ev.output as MultiLayerOutput;
          setMultiLayer(out);
          clearOverrides();
          setActiveLayer('overview');
          setDsl(out.overview.dsl);
          capturedResult = { kind: 'multi', out, instructionMarkdown };
        } else if (ev.type === 'done') {
          setAgentStage(null);
        }
      });

      // After the stream ends, resolve the project name and call addGeneratedProject.
      const result = capturedResult;
      if (result !== null) {
        try {
          const nameRes = await fetch('/api/code-space/name-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: prompt.slice(0, 100),
              providerId: provider.provider,
              model: genModel,
              apiKey: genApiKey,
              endpoint: genEndpoint,
              mode: 'app-planner',
            }),
          });
          if (nameRes.ok) {
            const { name } = await nameRes.json() as { name: string };
            if (name) projectName = name;
          }
        } catch {
          // fallback already set
        }
        if (result.kind === 'single') {
          addGeneratedProject(projectName, result.dsl, undefined, result.instructionMarkdown);
        } else {
          addGeneratedProject(projectName, result.out.overview.dsl, result.out, result.instructionMarkdown);
        }
        setMode('editor');
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        sawFailure = true;
        setTerminalState({ status: 'cancelled', message: 'Cancelled' });
        pushLog({ stage: 'init', level: 'info', message: 'Cancelled' });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        sawFailure = true;
        setTerminalState({ status: 'failed', message });
        pushLog({ stage: 'init', level: 'error', message });
      }
      setStep('questions');
    } finally {
      if (!sawResult && !sawFailure && !ac.signal.aborted) {
        setTerminalState({ status: 'failed', message: 'Generation ended before a diagram was produced.' });
        setStep('questions');
      }
      stopAgent();
      abortRef.current = null;
    }
  };

  const onCancel = () => abortRef.current?.abort();

  // -------------------------------------------------------------------------
  // Answer helpers
  // -------------------------------------------------------------------------
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
      return a && a.selected.size > 0;
    });
  }, [clarify, answers]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <>
      <div className="grid h-full grid-cols-[1fr] gap-4 overflow-y-auto p-6 lg:grid-cols-2">
        <ProviderConfig />

        <div className="space-y-2 rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-xs">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-accent" />
            <div className="text-[10px] uppercase tracking-widest text-ink-400">Custom Prompt mode</div>
          </div>
          <p className="text-ink-300">
            Describe anything you want diagrammed — software, workflows, org charts, lifecycles, decision trees,
            recipes, journeys, or any other structure.
          </p>
          <ol className="list-decimal pl-5 text-ink-400">
            <li>Write a short description of what you have in mind.</li>
            <li>The agent asks 4-6 clarifying questions to refine scope.</li>
            <li>Answer each question with the canned options or type your own under "Other".</li>
            <li>Choose <strong>Single diagram</strong> or <strong>Multi-layer</strong>, then generate.</li>
          </ol>
        </div>

        <div className="col-span-full space-y-4 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
          {/* ---- Step header ---- */}
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-widest text-ink-400">
              {step === 'prompt' && 'Step 1 · Describe your diagram'}
              {step === 'questions' && 'Step 2 · Answer clarifying questions'}
              {step === 'generating' && 'Working…'}
            </div>
            {step === 'questions' && (
              <button
                type="button"
                onClick={() => { setStep('prompt'); setClarify(null); setAnswers({}); }}
                className="text-[11px] text-ink-400 underline-offset-2 hover:underline"
              >
                ← back to prompt
              </button>
            )}
          </div>

          {/* ---- Step 1: prompt ---- */}
          {step === 'prompt' && (
            <>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  'e.g. "An onboarding workflow for new hires at a 50-person SaaS company, covering ' +
                  'pre-day-1, week 1, and the first 90 days, with handoffs between HR, IT, and the hiring manager."'
                }
                rows={6}
                className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm"
              />
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-ink-400">
                  Provider:{' '}
                  <span className="text-ink-200">{provider.provider}</span>
                  {' · '}Model:{' '}
                  <span className="font-mono text-ink-200">{summaryModel}</span>
                </div>
                <button
                  onClick={onAskQuestions}
                  disabled={!prompt.trim() || agentRunning}
                  className="rounded-md border border-accent/50 bg-accent/20 px-4 py-2 text-sm text-accent hover:bg-accent/30 disabled:opacity-50"
                >
                  Ask clarifying questions →
                </button>
              </div>
            </>
          )}

          {/* ---- Step 2: questions ---- */}
          {step === 'questions' && clarify && (
            <div className="space-y-4">
              {/* Intent summary */}
              <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2">
                <div className="text-[10px] uppercase tracking-widest text-accent">Restated intent</div>
                <div className="mt-1 text-[11px] text-ink-200">{clarify.intent_summary}</div>
              </div>

              {/* MCQ questions */}
              {clarify.questions.map((q, idx) => {
                const ans = answers[q.id] ?? { selected: new Set<string>(), custom: '' };
                return (
                  <div key={q.id} className="space-y-2 rounded-lg border border-ink-700 bg-ink-850/60 p-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[10px] text-ink-500">Q{idx + 1}</span>
                      <span className="text-sm text-ink-100">{q.question}</span>
                      {q.allow_multiple && (
                        <span className="ml-auto shrink-0 rounded-sm border border-ink-700 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-ink-400">
                          multi-select
                        </span>
                      )}
                    </div>
                    {q.rationale && (
                      <div className="text-[11px] text-ink-400">{q.rationale}</div>
                    )}

                    <div className="grid gap-2 sm:grid-cols-2">
                      {q.options.map((opt) => {
                        const selected = ans.selected.has(opt.label);
                        return (
                          <button
                            key={opt.label}
                            type="button"
                            onClick={() => toggleOption(q.id, opt.label, q.allow_multiple)}
                            className={`rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
                              selected
                                ? 'border-accent/60 bg-accent/10'
                                : 'border-ink-700 bg-ink-800 hover:bg-ink-700'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-[9px] ${
                                  q.allow_multiple ? 'rounded-sm' : 'rounded-full'
                                } ${selected ? 'border-accent bg-accent/30 text-accent' : 'border-ink-600'}`}
                              >
                                {selected ? '✓' : ''}
                              </span>
                              <span className="text-ink-100">{opt.label}</span>
                            </div>
                            <div className="mt-1 pl-5 text-[10px] text-ink-400">{opt.description}</div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Other (free text) */}
                    <div className="space-y-1 rounded-md border border-dashed border-ink-700 bg-ink-900/40 p-2">
                      <label className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-ink-400">
                        <span
                          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px] ${
                            ans.selected.has(OTHER_TOKEN)
                              ? 'border-accent bg-accent/30 text-accent'
                              : 'border-ink-600'
                          }`}
                        >
                          {ans.selected.has(OTHER_TOKEN) ? '✓' : ''}
                        </span>
                        Other — answer in your own words
                      </label>
                      <input
                        value={ans.custom}
                        onChange={(e) => setCustomText(q.id, e.target.value)}
                        placeholder="Type a custom answer (optional)…"
                        className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs"
                      />
                    </div>
                  </div>
                );
              })}

              {/* Diagram style + generate */}
              <div className="rounded-lg border border-ink-700 bg-ink-850/40 p-3 space-y-3">
                <div className="text-[10px] uppercase tracking-widest text-ink-400">Diagram style</div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setDiagramStyle('single')}
                    className={`flex items-center gap-2 rounded-md border px-3 py-2.5 text-left text-xs transition-colors ${
                      diagramStyle === 'single'
                        ? 'border-accent/60 bg-accent/10'
                        : 'border-ink-700 bg-ink-800 hover:bg-ink-700'
                    }`}
                  >
                    <SquareIcon size={14} className={diagramStyle === 'single' ? 'text-accent' : 'text-ink-400'} />
                    <div>
                      <div className="text-ink-100">Single diagram</div>
                      <div className="text-[10px] text-ink-400">One cohesive view of everything</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiagramStyle('multi-layer')}
                    className={`flex items-center gap-2 rounded-md border px-3 py-2.5 text-left text-xs transition-colors ${
                      diagramStyle === 'multi-layer'
                        ? 'border-accent/60 bg-accent/10'
                        : 'border-ink-700 bg-ink-800 hover:bg-ink-700'
                    }`}
                  >
                    <Layers3 size={14} className={diagramStyle === 'multi-layer' ? 'text-accent' : 'text-ink-400'} />
                    <div>
                      <div className="text-ink-100">Multi-layer</div>
                      <div className="text-[10px] text-ink-400">Overview + one sub-diagram per layer</div>
                    </div>
                  </button>
                </div>

                {/* Motivation vs Logic: Instruction Mode is a workflow preference layered on top of the diagram shape, so it sits after the single/multi choice and sends an explicit flag to the agent instead of overloading either diagram option. */}
                <label className="flex cursor-pointer items-start gap-3 rounded-md border border-ink-700 bg-ink-900/60 p-3 transition-colors hover:border-accent/40">
                  <input
                    checked={instructionMode}
                    className="mt-0.5 h-4 w-4 rounded border-ink-600 bg-ink-900 accent-[rgb(var(--accent))]"
                    onChange={(e) => setInstructionMode(e.target.checked)}
                    type="checkbox"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium text-ink-100">
                      <BookOpenText size={14} className={instructionMode ? 'text-accent' : 'text-ink-400'} />
                      Instruction Mode
                    </span>
                    <span className="mt-1 block text-[11px] leading-5 text-ink-400">
                      Also generate a Markdown mentor guide with step-by-step implementation or best-practice instructions.
                    </span>
                  </span>
                </label>

                <div className="flex items-center justify-between pt-1">
                  <div className="text-[11px] text-ink-400">
                    {allAnswered
                      ? diagramStyle === 'multi-layer'
                        ? 'Will generate an overview + per-layer sub-diagrams.'
                        : 'Ready to generate a single diagram.'
                      : 'Pick or type an answer for each question to continue.'}
                  </div>
                  <button
                    onClick={onGenerateDiagram}
                    disabled={!allAnswered || agentRunning}
                    className="rounded-md border border-accent/50 bg-accent/20 px-4 py-2 text-sm text-accent hover:bg-accent/30 disabled:opacity-50"
                  >
                    Generate diagram →
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {(agentRunning || terminalState) && (
        <AnalysisAnimation
          retryNotice={retryNotice}
          counters={counters}
          onCancel={onCancel}
          onDismiss={() => { setTerminalState(null); }}
          terminalState={terminalState}
          stages={activeStages}
          title={animTitle}
        />
      )}
    </>
  );
}

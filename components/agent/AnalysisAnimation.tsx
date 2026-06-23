'use client';

import { useEffect, useState } from 'react';
import { useDiagramStore } from '@/lib/state/store';

const DEFAULT_STAGES: Array<{ id: string; label: string }> = [
  { id: 'validate', label: 'Validating credentials' },
  { id: 'scan', label: 'Scanning repository' },
  { id: 'classify', label: 'Selecting relevant files' },
  { id: 'context', label: 'Reading docs + import graph' },
  { id: 'summarize', label: 'Summarizing modules' },
  { id: 'subsystem', label: 'Discovering subsystems' },
  { id: 'plan', label: 'Generating diagram plan' },
  { id: 'compile', label: 'Compiling DSL' },
  { id: 'validate-dsl', label: 'Validating syntax' },
];

interface Props {
  retryNotice?: { stage: string; attempt: number; delayMs: number; reason: string } | null;
  counters?: Record<string, number>;
  onCancel?: () => void;
  onDismiss?: () => void;
  terminalState?: { status: 'failed' | 'cancelled'; message: string } | null;
  stages?: Array<{ id: string; label: string }>;
  /** Override the running title shown while the pipeline is active */
  title?: string;
}

export function AnalysisAnimation({ retryNotice, counters, onCancel, onDismiss, terminalState, stages = DEFAULT_STAGES, title = 'Analyzing repository' }: Props) {
  const stage = useDiagramStore((s) => s.agentStage);
  const log = useDiagramStore((s) => s.agentLog);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250);
    return () => clearInterval(t);
  }, []);

  const activeIdx = stages.findIndex((s) => s.id === stage);
  const isTerminal = terminalState !== null && terminalState !== undefined;
  const estimatedTokens = (() => {
    if (typeof counters?.estimatedTokens === 'number') return counters.estimatedTokens;
    if (stage === 'scan') {
      const files = counters?.files ?? 0;
      return files > 0 ? Math.round(files * 120) : 0;
    }
    if (stage === 'summarize') {
      const done = counters?.done ?? 0;
      const total = counters?.total ?? counters?.selected ?? 0;
      if (total <= 0) return 0;
      const avgPerFile = 1_300;
      return Math.round(Math.max(done, 1) * avgPerFile);
    }
    if (stage === 'plan' || stage === 'subsystem' || stage === 'layers' || stage === 'compile' || stage === 'validate-dsl') {
      const selected = counters?.selected ?? counters?.total ?? 0;
      return selected > 0 ? Math.round(selected * 350) : 0;
    }
    if (stage === 'overview') {
      const selected = counters?.selected ?? counters?.total ?? 0;
      const layers = counters?.layers ?? 1;
      return Math.round((selected * 180) + (layers * 900));
    }
    if (stage === 'sub-plans' || stage === 'layer-plan') {
      const selected = counters?.selected ?? counters?.total ?? 0;
      const layers = Math.max(1, counters?.layers ?? 1);
      return Math.round((selected * 300) + (layers * 2_200));
    }
    if (stage === 'instruction') {
      const selected = counters?.selected ?? counters?.total ?? counters?.done ?? 0;
      const batches = counters?.instructionBatches ?? 1;
      const completedBatches = counters?.instructionDone ?? 0;
      const completedRatio = batches > 0 ? Math.max(1, completedBatches) / batches : 1;
      return Math.round((selected * 950 * completedRatio) + (batches * 2_500));
    }
    return 0;
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/85 backdrop-blur-sm">
      <div className="w-[700px] max-w-[92vw] rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-ink-100">
              {terminalState?.status === 'failed'
                ? 'Analysis failed'
                : terminalState?.status === 'cancelled'
                  ? 'Analysis cancelled'
                  : title}
            </div>
            <div className="text-[11px] text-ink-400">
              {isTerminal ? 'Review the error and log before closing' : 'Streaming live progress · cancel any time'}
            </div>
          </div>
          <button
            onClick={isTerminal ? onDismiss : onCancel}
            className="rounded-md border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs hover:bg-ink-700"
          >
            {isTerminal ? 'Close' : 'Cancel'}
          </button>
        </div>

        {terminalState?.message && (
          <div className="mb-4 rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-xs text-red-200">
            {terminalState.message}
          </div>
        )}

        <div className="space-y-2">
          {stages.map((s, i) => {
            const done = i < activeIdx;
            const active = i === activeIdx;
            return (
              <div
                key={s.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
                  active
                    ? 'stage-active border-accent/60 bg-accent/10'
                    : done
                      ? 'border-ink-700 bg-ink-800/40 text-ink-300'
                      : 'border-ink-800 bg-ink-900 text-ink-500'
                }`}
              >
                <div
                  className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                    done
                      ? 'border-green-400/60 bg-green-400/20 text-green-300'
                      : active
                        ? 'border-accent bg-accent/30 text-accent'
                        : 'border-ink-700 bg-ink-800'
                  }`}
                >
                  {done ? '✓' : active ? <span className="h-2 w-2 rounded-full bg-accent animate-pulse" /> : i + 1}
                </div>
                <div className="flex-1 text-sm">{s.label}</div>
                {active && retryNotice?.stage === s.id && (
                  <span className="text-[11px] text-yellow-300">
                    Retrying in {Math.round(retryNotice.delayMs / 1000)}s (attempt {retryNotice.attempt})
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-400">
          <div>⏱ {elapsed}s</div>
          {counters?.files !== undefined && <div>📁 {counters.files} files</div>}
          {counters?.selected !== undefined && <div>★ {counters.selected} selected</div>}
          {counters?.docs !== undefined && <div>📄 {counters.docs} docs</div>}
          {counters?.externals !== undefined && <div>🔗 {counters.externals} externals</div>}
          {counters?.layers !== undefined && <div>🧱 {counters.layers} layers</div>}
          {counters?.done !== undefined && counters?.total !== undefined && (
            <div>✓ {counters.done}/{counters.total} summarized</div>
          )}
          {counters?.instructionDone !== undefined && counters?.instructionBatches !== undefined && (
            <div>Guide {counters.instructionDone}/{counters.instructionBatches} sections</div>
          )}
          {estimatedTokens > 0 && <div>🧠 ≈ {estimatedTokens.toLocaleString()} tokens</div>}
        </div>

        <details className="mt-3 rounded-lg border border-ink-700 bg-ink-950/40 p-2 text-[11px]">
          <summary className="cursor-pointer text-ink-400">Log</summary>
          <div className="mt-2 max-h-32 overflow-y-auto font-mono text-[11px]">
            {log.length === 0 ? (
              <div className="text-ink-500">No log entries yet.</div>
            ) : (
              log.slice(-60).map((l, i) => (
                <div
                  key={i}
                  className={
                    l.level === 'error'
                      ? 'text-red-300'
                      : l.level === 'warn'
                        ? 'text-yellow-300'
                        : 'text-ink-300'
                  }
                >
                  [{l.stage}] {l.message}
                </div>
              ))
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

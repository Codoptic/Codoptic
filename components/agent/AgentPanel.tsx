'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDiagramStore } from '@/lib/state/store';
import { ProviderConfig } from './ProviderConfig';
import { RepoInput } from './RepoInput';
import type { RepoSourceConfig } from '@/lib/agent/repo/repoTypes';
import { DiagramTypePicker } from './DiagramTypePicker';
import { FocusPromptBox } from './FocusPromptBox';
import { QuickModeToggle } from './QuickModeToggle';
import { AnalysisAnimation } from './AnalysisAnimation';
import { readAgentStream, readErrorMessage, type AgentStreamEvent } from './streamEvents';

interface ScanResult {
  resolved: string;
  fileCount: number;
}

export function AgentPanel() {
  const provider = useDiagramStore((s) => s.provider);
  const kind = useDiagramStore((s) => s.diagramType);
  const focus = useDiagramStore((s) => s.focusPrompt);
  const quickMode = useDiagramStore((s) => s.quickMode);
  const maxMode = useDiagramStore((s) => s.maxMode);
  const instructionMode = useDiagramStore((s) => s.instructionMode);
  const setMaxMode = useDiagramStore((s) => s.setMaxMode);
  const setInstructionMode = useDiagramStore((s) => s.setInstructionMode);
  const setInstructionMarkdown = useDiagramStore((s) => s.setInstructionMarkdown);
  const setMode = useDiagramStore((s) => s.setMode);
  const addGeneratedProject = useDiagramStore((s) => s.addGeneratedProject);
  const setAgentStage = useDiagramStore((s) => s.setAgentStage);
  const pushLog = useDiagramStore((s) => s.pushAgentLog);
  const startAgent = useDiagramStore((s) => s.startAgent);
  const stopAgent = useDiagramStore((s) => s.stopAgent);
  const agentRunning = useDiagramStore((s) => s.agentRunning);
  const router = useRouter();

  const [rootPath, setRootPath] = useState<string>('');
  const [ignoredFolders, setIgnoredFolders] = useState<string[]>([]);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [repoSource, setRepoSource] = useState<RepoSourceConfig>({ sourceType: 'local', repoPath: '', authMode: 'none' });
  const [retryNotice, setRetryNotice] = useState<{ stage: string; attempt: number; delayMs: number; reason: string } | null>(null);
  const [counters, setCounters] = useState<Record<string, number>>({});
  const [terminalState, setTerminalState] = useState<{ status: 'failed' | 'cancelled'; message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const onStart = async () => {
    if (!rootPath) {
      pushLog({ stage: 'init', level: 'error', message: 'Choose a repo path first' });
      return;
    }
    const sessionId = `s-${Date.now()}`;
    startAgent(sessionId);
    setCounters({});
    setRetryNotice(null);
    setTerminalState(null);
    setInstructionMarkdown('');
    let sawResult = false;
    let sawFailure = false;

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch('/api/agent/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.provider,
          model:
            provider.provider === 'foundry' || provider.provider === 'deepseek' || provider.provider === 'nvidia' || provider.provider === 'openrouter'
              ? provider.customModel ?? ''
              : provider.model,
          apiKey: provider.apiKey || undefined,
          endpoint: provider.endpoint || undefined,
          rootPath,
          kind,
          focus,
          ignoredFolders,
          quickMode,
          maxMode,
          instructionMode,
          source: repoSource,
        }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const message = await readErrorMessage(res);
        sawFailure = true;
        setTerminalState({ status: 'failed', message });
        pushLog({ stage: 'init', level: 'error', message });
        return;
      }

      await readAgentStream(res.body, handleEvent);
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
    } finally {
      if (!sawResult && !sawFailure && !ac.signal.aborted) {
        setTerminalState({ status: 'failed', message: 'Analysis ended before a diagram was produced.' });
      }
      stopAgent();
      abortRef.current = null;
    }

    function handleEvent(ev: AgentStreamEvent) {
      if (ev.type === 'stage') {
        setAgentStage(ev.stage);
        if (ev.counters) setCounters((c) => ({ ...c, ...ev.counters }));
        if (ev.message)
          pushLog({ stage: ev.stage, level: 'info', message: `${ev.status}: ${ev.message}` });
      } else if (ev.type === 'retry') {
        setRetryNotice({ stage: ev.stage, attempt: ev.attempt, delayMs: ev.delayMs, reason: ev.reason });
        pushLog({
          stage: ev.stage,
          level: 'warn',
          message: `retry #${ev.attempt} in ${Math.round(ev.delayMs / 1000)}s — ${ev.reason}`,
        });
      } else if (ev.type === 'log') {
        pushLog({ stage: ev.stage, level: ev.level, message: ev.message });
      } else if (ev.type === 'error') {
        sawFailure = true;
        setTerminalState({ status: 'failed', message: ev.message });
        pushLog({ stage: ev.stage, level: 'error', message: ev.message });
      } else if (ev.type === 'result') {
        sawResult = true;
        const instructionMarkdown = ev.instructionMarkdown ?? '';
        setInstructionMarkdown(instructionMarkdown);
        const projectName = rootPath.split('/').filter(Boolean).pop() || 'diagram';
        addGeneratedProject(projectName, ev.dsl, undefined, instructionMarkdown);
        setMode('editor');
        router.push('/diagram');
      } else if (ev.type === 'done') {
        setAgentStage(null);
      }
    }
  };

  const onCancel = () => {
    abortRef.current?.abort();
  };

  return (
    <>
      <div className="grid h-full grid-cols-[1fr] gap-4 overflow-y-auto p-6 lg:grid-cols-2">
        <ProviderConfig />
        <RepoInput
          maxMode={maxMode}
          onMaxModeChange={setMaxMode}
          instructionMode={instructionMode}
          onInstructionModeChange={setInstructionMode}
          onConfigChange={(path, ignored, source) => {
            setRootPath(path);
            setIgnoredFolders(ignored);
            setRepoSource(source);
            setScan(null);
          }}
          onScan={(path, result, ignored, source) => {
            setRootPath(path);
            setIgnoredFolders(ignored);
            setRepoSource(source);
            setScan({ resolved: result.resolved, fileCount: result.fileCount });
          }}
        />
        <DiagramTypePicker />
        <FocusPromptBox />
        <QuickModeToggle />
        <div className="col-span-full flex items-center justify-between gap-2 rounded-xl border border-accent/15 bg-black/42 p-4">
          <div className="text-xs text-ink-400">
            {scan ? (
              <>
                Ready to analyze <span className="font-mono text-ink-200">{scan.resolved}</span> ({scan.fileCount} files)
                {ignoredFolders.length ? ` · ${ignoredFolders.length} ignored folder${ignoredFolders.length === 1 ? '' : 's'}` : ''}
                {' · '}
                <span className="capitalize">{kind}</span>
                {' · '}
                <span>
                  {provider.provider}/
                  {(provider.provider === 'foundry' ||
                    provider.provider === 'deepseek' ||
                    provider.provider === 'nvidia' ||
                    provider.provider === 'openrouter'
                    ? provider.customModel ?? '?'
                    : provider.model)}
                </span>
                {quickMode ? <> · <span className="text-accent">Quick Mode</span></> : null}
                {maxMode ? <> · <span className="text-coral">MAX</span></> : null}
                {instructionMode ? <> · <span className="text-accent">Document Mode</span></> : null}
              </>
            ) : (
              'Configure provider + preview repo to enable analysis'
            )}
          </div>
          <button
            disabled={!scan || agentRunning}
            onClick={onStart}
            className="rounded-md border border-accent/50 bg-accent/20 px-4 py-2 text-sm text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {agentRunning ? 'Analyzing…' : 'Generate diagram'}
          </button>
        </div>
      </div>

      {(agentRunning || terminalState) && (
        <AnalysisAnimation
          retryNotice={retryNotice}
          counters={counters}
          onCancel={onCancel}
          onDismiss={() => setTerminalState(null)}
          terminalState={terminalState}
          stages={[
            { id: 'validate', label: 'Validating credentials' },
            { id: 'scan', label: 'Scanning repository' },
            { id: 'classify', label: 'Selecting relevant files' },
            { id: 'context', label: 'Reading docs + import graph' },
            { id: 'summarize', label: 'Summarizing modules' },
            { id: 'subsystem', label: 'Discovering subsystems' },
            { id: 'plan', label: 'Generating diagram plan' },
            { id: 'compile', label: 'Compiling DSL' },
            { id: 'validate-dsl', label: 'Validating syntax' },
            ...(instructionMode ? [{ id: 'instruction', label: 'Writing Document Mode guide' }] : []),
          ]}
        />
      )}
    </>
  );
}

'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { useDiagramStore } from '@/lib/state/store';
import { readUiPreference, writeUiPreference, type PersistedEditorTab } from '@/lib/state/uiPreferences';
import { registerDslLanguage } from './dslLanguage';
import { FixPanel } from './FixPanel';

type Tab = PersistedEditorTab;

export function MonacoPanel() {
  const dsl = useDiagramStore((s) => s.dslText);
  const setDsl = useDiagramStore((s) => s.setDsl);
  const diagram = useDiagramStore((s) => s.diagram);
  const theme = useDiagramStore((s) => s.theme);
  const [tab, setTab] = useState<Tab>('dsl');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monacoRef = useRef<any>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const mountedRef = useRef(false);
  const ignoreEmptyMountChange = useRef(true);

  // Root Cause vs Logic: the IR tab was eagerly stringifying the entire compiled diagram on every DSL change, even while the DSL tab was active. Large generated diagrams could spend most of the render budget serializing JSON that the user wasn't looking at yet, which made the editor feel frozen. Only materialize the IR payload when the IR tab is actually selected.
  const irText = useMemo(
    () =>
      tab === 'ir'
        ? diagram
          ? JSON.stringify(diagram, null, 2)
          : '// Render the diagram to see the IR'
        : '// Switch to JSON IR to inspect the compiled diagram',
    [diagram, tab],
  );
  const diagnostics = useMemo(() => diagram?.diagnostics ?? [], [diagram]);

  useEffect(() => {
    const savedTab = readUiPreference('editorTab');
    if (savedTab) setTab(savedTab);
  }, []);

  const selectTab = (nextTab: Tab) => {
    writeUiPreference('editorTab', nextTab);
    setTab(nextTab);
  };

  const onMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco;
    editorRef.current = editor as Monaco.editor.IStandaloneCodeEditor;
    mountedRef.current = true;
    registerDslLanguage(monaco);
    monaco.editor.setTheme(theme === 'light' ? 'codoptic-light' : 'codoptic-dark');
  };

  // When the DSL is changed externally (AI Fix, example loader, project switch) and
  // the DSL tab is active, push the new value into Monaco without resetting undo history.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || tab !== 'dsl') return;
    const model = editor.getModel();
    if (!model || model.getValue() === dsl) return;
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: dsl, forceMoveMarkers: true }],
      () => null,
    );
  }, [dsl, tab]);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    monaco.editor.setTheme(theme === 'light' ? 'codoptic-light' : 'codoptic-dark');
  }, [theme]);

  // Apply diagnostics as markers when they change.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    const editors = monaco.editor.getEditors?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ed = editors.find((e: any) => e.getModel()?.getLanguageId?.() === 'codoptic');
    if (!ed) return;
    const model = ed.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'codoptic',
      diagnostics.map((d) => ({
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.line,
        endColumn: d.column + (d.length ?? 1),
        message: d.message,
        severity:
          d.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : d.severity === 'warning'
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
      })),
    );
  }, [diagnostics]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-ink-700 bg-ink-850 text-xs">
        {(['dsl', 'ir', 'diagnostics', 'fix'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => selectTab(t)}
            className={`px-3 py-2 uppercase tracking-wider transition-colors ${
              tab === t ? 'border-b-2 border-accent text-ink-100' : 'text-ink-400 hover:text-ink-200'
            }`}
          >
            {t === 'dsl' ? 'DSL' : t === 'ir' ? 'JSON IR' : t === 'diagnostics' ? 'Diagnostics' : 'Fix'}
            {t === 'diagnostics' && diagnostics.length > 0 && (
              <span className="ml-1.5 rounded-full bg-coral/20 px-1.5 text-coral text-[10px]">{diagnostics.length}</span>
            )}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {tab === 'dsl' && (
          <Editor
            height="100%"
            theme={theme === 'light' ? 'codoptic-light' : 'codoptic-dark'}
            language="codoptic"
            value={dsl}
            onChange={(v) => {
              if (!mountedRef.current) return;
              if (ignoreEmptyMountChange.current) {
                ignoreEmptyMountChange.current = false;
                if ((v === undefined || v === '') && useDiagramStore.getState().dslText) return;
              }
              setDsl(v ?? '');
            }}
            onMount={onMount}
            options={{
              minimap: { enabled: false },
              fontSize: 12.5,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              wordWrap: 'on',
              renderWhitespace: 'selection',
              scrollBeyondLastLine: false,
              tabSize: 2,
            }}
          />
        )}
        {tab === 'ir' && (
          <Editor
            height="100%"
            theme={theme === 'light' ? 'codoptic-light' : 'codoptic-dark'}
            language="json"
            value={irText}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 11.5,
              wordWrap: 'on',
            }}
          />
        )}
        {tab === 'diagnostics' && (
          <div className="h-full overflow-y-auto bg-ink-950 p-3 font-mono text-xs">
            {diagnostics.length === 0 ? (
              <div className="text-ink-500">No diagnostics.</div>
            ) : (
              <ul className="space-y-1.5">
                {diagnostics.map((d, i) => (
                  <li
                    key={i}
                    className={`flex items-start gap-2 rounded border px-2 py-1.5 ${
                      d.severity === 'error'
                        ? 'border-red-500/40 bg-red-500/10 text-red-200'
                        : d.severity === 'warning'
                          ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-200'
                          : 'border-sky-500/40 bg-sky-500/10 text-sky-200'
                    }`}
                  >
                    <span className="font-semibold uppercase text-[10px] tracking-wider">{d.severity}</span>
                    <span className="text-ink-400">L{d.line}:{d.column}</span>
                    <span className="flex-1">{d.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {tab === 'fix' && (
          <FixPanel onFixApplied={() => selectTab('dsl')} />
        )}
      </div>
    </div>
  );
}

'use client';

import { COLOR_NAMES } from '@/lib/ir/types';
import { knownIconNames } from '@/lib/icons/registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Monaco = any;

const COLORS = COLOR_NAMES;
const ICONS = knownIconNames();

export function registerDslLanguage(monaco: Monaco) {
  const langId = 'codoptic';
  const isRegistered = monaco.languages.getLanguages().some((l: { id: string }) => l.id === langId);

  if (!isRegistered) {
    monaco.languages.register({ id: langId });

    monaco.languages.setMonarchTokensProvider(langId, {
      defaultToken: '',
      tokenPostfix: '.codoptic',
      tokenizer: {
        root: [
          [/\/\/.*$/, 'comment'],
          [/\[/, { token: 'delimiter.bracket', next: '@props' }],
          [/[{}]/, 'delimiter.curly'],
          [/<>|>|<|--|=>/, 'operator'],
          [/:/, 'delimiter'],
          [/[A-Za-z][\w \-|&()/]*/, 'identifier'],
        ],
        props: [
          [/\]/, { token: 'delimiter.bracket', next: '@pop' }],
          [/,/, 'delimiter'],
          [/:/, 'delimiter'],
          [/[a-zA-Z_][\w-]*/, 'attribute.name'],
          [/[^,\]]+/, 'attribute.value'],
        ],
      },
    });

    monaco.languages.setLanguageConfiguration(langId, {
      comments: { lineComment: '//' },
      brackets: [
        ['{', '}'],
        ['[', ']'],
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
      ],
    });

    monaco.languages.registerCompletionItemProvider(langId, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provideCompletionItems(model: any, position: any) {
        const line = model.getLineContent(position.lineNumber);
        const before = line.slice(0, position.column - 1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const range: any = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column,
          endColumn: position.column,
        };
        if (/color:\s*$/.test(before)) {
          return {
            suggestions: COLORS.map((c) => ({
              label: c,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: c,
              range,
            })),
          };
        }
        if (/icon:\s*$/.test(before)) {
          return {
            suggestions: ICONS.map((c) => ({
              label: c,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: c,
              range,
            })),
          };
        }
        return { suggestions: [] };
      },
    });
  }

  // Motivation vs Logic: Monaco is its own rendering surface, so define both themes alongside the DSL registration and switch the active theme from React state.
  monaco.editor.defineTheme('codoptic-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'identifier', foreground: 'c1c7d3' },
      { token: 'operator', foreground: '7c9cff', fontStyle: 'bold' },
      { token: 'attribute.name', foreground: 'ffb37c' },
      { token: 'attribute.value', foreground: '90dc60' },
      { token: 'delimiter.bracket', foreground: '8b95a8' },
      { token: 'delimiter.curly', foreground: '8b95a8' },
    ],
    colors: {
      'editor.background': '#07090c',
      'editor.foreground': '#c1c7d3',
      'editor.lineHighlightBackground': '#0f1218',
      'editorLineNumber.foreground': '#3c4658',
    },
  });

  monaco.editor.defineTheme('codoptic-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
      { token: 'identifier', foreground: '1f2937' },
      { token: 'operator', foreground: '3a60e5', fontStyle: 'bold' },
      { token: 'attribute.name', foreground: 'c05621' },
      { token: 'attribute.value', foreground: '047857' },
      { token: 'delimiter.bracket', foreground: '64748b' },
      { token: 'delimiter.curly', foreground: '64748b' },
    ],
    colors: {
      'editor.background': '#f8fafd',
      'editor.foreground': '#1f2937',
      'editor.lineHighlightBackground': '#eef3fb',
      'editorLineNumber.foreground': '#94a3b8',
    },
  });
}

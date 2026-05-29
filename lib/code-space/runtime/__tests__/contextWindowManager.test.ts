import { describe, expect, it } from 'vitest';
import {
  allocateContextBudget,
  compressMessageHistory,
  contextWindowForModel,
  estimateTokens,
  fallbackContextBudget,
  isContentFilterError,
  isContextLimitError,
  isReduciblePromptError,
  skeletonizeFileContent,
} from '../contextWindowManager';

describe('estimateTokens', () => {
  it('estimates tokens from character length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(380))).toBe(100);
  });
});

describe('contextWindowForModel', () => {
  it('returns correct windows for known models', () => {
    expect(contextWindowForModel('gpt-4o')).toBe(128_000);
    expect(contextWindowForModel('gpt-4')).toBe(8_192);
    expect(contextWindowForModel('gpt-35-turbo-16k')).toBe(16_384);
    expect(contextWindowForModel('gpt-35-turbo')).toBe(4_096);
    expect(contextWindowForModel('claude-3-5-sonnet')).toBe(200_000);
  });

  it('returns a safe default for unknown models', () => {
    expect(contextWindowForModel('unknown-model')).toBe(32_000);
    expect(contextWindowForModel('')).toBe(32_000);
  });

  it('matches case-insensitively', () => {
    expect(contextWindowForModel('GPT-4O')).toBe(128_000);
    expect(contextWindowForModel('Azure-GPT-4-turbo-preview')).toBe(128_000);
  });
});

describe('allocateContextBudget', () => {
  it('returns full budget for large context models', () => {
    const budget = allocateContextBudget('gpt-4o');
    expect(budget.maxFiles).toBe(24);
    expect(budget.maxCharsPerFile).toBe(16_000);
    expect(budget.maxIndexEntries).toBe(800);
    expect(budget.useSkeleton).toBe(false);
  });

  it('reduces budget for small context models', () => {
    const budget = allocateContextBudget('gpt-4');
    expect(budget.maxFiles).toBeLessThan(24);
    expect(budget.maxCharsPerFile).toBeLessThan(16_000);
    expect(budget.useSkeleton).toBe(true);
  });

  it('enables skeleton for tiny context models', () => {
    const budget = allocateContextBudget('gpt-35-turbo');
    expect(budget.useSkeleton).toBe(true);
    expect(budget.maxFiles).toBeLessThanOrEqual(6);
  });

  it('applies conservative defaults for empty model string', () => {
    const budget = allocateContextBudget('');
    // 32K default — should still fit reasonable evidence
    expect(budget.maxFiles).toBeGreaterThan(0);
    expect(budget.maxIndexEntries).toBeGreaterThan(0);
  });
});

describe('fallbackContextBudget', () => {
  it('halves all limits and enables skeleton', () => {
    const original = { maxFiles: 16, maxCharsPerFile: 8_000, maxIndexEntries: 400, useSkeleton: false };
    const fallback = fallbackContextBudget(original);
    expect(fallback.maxFiles).toBe(8);
    expect(fallback.maxCharsPerFile).toBe(4_000);
    expect(fallback.maxIndexEntries).toBe(200);
    expect(fallback.useSkeleton).toBe(true);
  });

  it('respects minimum floor values', () => {
    const tight = { maxFiles: 4, maxCharsPerFile: 800, maxIndexEntries: 50, useSkeleton: true };
    const fallback = fallbackContextBudget(tight);
    expect(fallback.maxFiles).toBeGreaterThanOrEqual(4);
    expect(fallback.maxCharsPerFile).toBeGreaterThanOrEqual(800);
    expect(fallback.maxIndexEntries).toBeGreaterThanOrEqual(50);
  });
});

describe('skeletonizeFileContent', () => {
  it('extracts TypeScript exports and function signatures', () => {
    const content = [
      "import { foo } from './foo';",
      'export interface Config { timeout: number; }',
      'export function run(cfg: Config): void {',
      '  const x = 1;',
      '  console.log(x);',
      '}',
      'export const MAX = 100;',
    ].join('\n');

    const skeleton = skeletonizeFileContent('app.ts', content);
    expect(skeleton).toContain("import { foo } from './foo';");
    expect(skeleton).toContain('export interface Config');
    expect(skeleton).toContain('export function run(cfg: Config): void {');
    expect(skeleton).toContain('export const MAX = 100;');
    // Implementation body should be collapsed
    expect(skeleton).not.toContain('console.log(x)');
  });

  it('handles Python files', () => {
    const content = [
      'from os import path',
      'import sys',
      'class MyClass:',
      '    def __init__(self):',
      '        self.x = 1',
      'def helper(a: int) -> str:',
      '    return str(a)',
    ].join('\n');

    const skeleton = skeletonizeFileContent('util.py', content);
    expect(skeleton).toContain('from os import path');
    expect(skeleton).toContain('class MyClass:');
    expect(skeleton).toContain('def helper(a: int) -> str:');
    expect(skeleton).not.toContain('return str(a)');
  });

  it('returns truncated content for unknown extensions', () => {
    const skeleton = skeletonizeFileContent('data.csv', 'a,b,c\n'.repeat(1000));
    expect(skeleton.length).toBeLessThan(700);
    expect(skeleton).toContain('[truncated]');
  });
});

describe('error detection', () => {
  it('detects context limit errors', () => {
    expect(isContextLimitError(new Error('context length exceeded'))).toBe(true);
    expect(isContextLimitError(new Error('maximum context window reached'))).toBe(true);
    expect(isContextLimitError(new Error('tokens exceeded maximum'))).toBe(true);
    expect(isContextLimitError(new Error('reduce the length of the input'))).toBe(true);
    expect(isContextLimitError(new Error('unrelated network error'))).toBe(false);
    expect(isContextLimitError(null)).toBe(false);
  });

  it('detects Azure content filter errors', () => {
    expect(isContentFilterError(new Error('400 Bad Request: content_filter policy violation'))).toBe(true);
    expect(isContentFilterError(new Error('The response was filtered due to content management policy'))).toBe(true);
    expect(isContentFilterError(new Error('ResponsibleAIPolicyViolation'))).toBe(true);
    expect(isContentFilterError(new Error('500 Internal Server Error'))).toBe(false);
    expect(isContentFilterError(new Error('rate limit exceeded'))).toBe(false);
  });

  it('isReduciblePromptError matches both classes', () => {
    expect(isReduciblePromptError(new Error('context length exceeded'))).toBe(true);
    expect(isReduciblePromptError(new Error('content_filter triggered'))).toBe(true);
    expect(isReduciblePromptError(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('compressMessageHistory', () => {
  it('trims old tool results but keeps recent ones intact', () => {
    const longContent = 'x'.repeat(2_000);
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'thinking' },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 't1', content: longContent }] },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 't2', content: longContent }] },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 't3', content: longContent }] },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 't4', content: longContent }] },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 't5', content: longContent }] }, // most recent
    ];

    compressMessageHistory(messages, 3);

    // Most recent 3 tool turns should be intact
    const toolTurns = messages.filter((m) => m.role === 'tool');
    expect(toolTurns[4]?.toolResults?.[0]?.content.length).toBe(longContent.length); // newest
    expect(toolTurns[3]?.toolResults?.[0]?.content.length).toBe(longContent.length);
    expect(toolTurns[2]?.toolResults?.[0]?.content.length).toBe(longContent.length);
    // Older turns should be truncated
    expect(toolTurns[1]?.toolResults?.[0]?.content).toContain('[prior tool result truncated for context]');
    expect(toolTurns[0]?.toolResults?.[0]?.content).toContain('[prior tool result truncated for context]');
  });

  it('does not modify non-tool messages', () => {
    const messages = [
      { role: 'system', content: 'x'.repeat(5_000) },
      { role: 'user', content: 'x'.repeat(5_000) },
    ];
    compressMessageHistory(messages, 4);
    expect(messages[0]?.content.length).toBe(5_000);
    expect(messages[1]?.content.length).toBe(5_000);
  });
});

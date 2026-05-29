import { describe, expect, it } from 'vitest';
import { buildChunkSummaryPrompt, chunkContent, SUMMARIZER_SYSTEM_PROMPT } from '../contextSummarizer';

describe('SUMMARIZER_SYSTEM_PROMPT', () => {
  it('instructs the model to preserve exact identifiers and omit bodies', () => {
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain('exact identifiers');
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain('verbatim');
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain('Omit');
  });
});

describe('buildChunkSummaryPrompt', () => {
  it('includes file path, chunk index, and task context', () => {
    const prompt = buildChunkSummaryPrompt('src/agent.ts', 0, 2, 'export class Agent {}', 'Refactor the agent class');
    expect(prompt).toContain('src/agent.ts');
    expect(prompt).toContain('chunk 1/2');
    expect(prompt).toContain('Refactor the agent class');
    expect(prompt).toContain('export class Agent {}');
  });

  it('omits chunk marker for single-chunk files', () => {
    const prompt = buildChunkSummaryPrompt('small.ts', 0, 1, 'const x = 1;', 'task');
    expect(prompt).not.toContain('chunk');
  });

  it('truncates task context to 240 chars', () => {
    const longTask = 'x'.repeat(500);
    const prompt = buildChunkSummaryPrompt('file.ts', 0, 1, 'code', longTask);
    const taskLine = prompt.split('\n').find((line) => line.startsWith('Task context'));
    // "Task context (for relevance): " prefix = 30 chars + 240 slice = 270 max
    expect(taskLine?.length).toBeLessThanOrEqual(270);
  });
});

describe('chunkContent', () => {
  it('returns single chunk for small content', () => {
    const chunks = chunkContent('hello world', 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('hello world');
  });

  it('splits large content into multiple chunks', () => {
    const content = 'x'.repeat(20_000);
    const chunks = chunkContent(content, 7_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(content);
  });

  it('prefers splitting at blank lines near the target', () => {
    const block = 'function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n';
    const bigContent = block.repeat(200); // ~13K chars
    const chunks = chunkContent(bigContent, 7_000);
    // Each chunk should end near a function boundary (blank line), not mid-line
    for (const chunk of chunks.slice(0, -1)) {
      const lastChars = chunk.slice(-5);
      expect(lastChars).not.toContain('function ');
    }
  });

  it('handles content exactly at chunk size boundary', () => {
    const content = 'a'.repeat(7_000);
    const chunks = chunkContent(content, 7_000);
    expect(chunks).toHaveLength(1);
  });
});

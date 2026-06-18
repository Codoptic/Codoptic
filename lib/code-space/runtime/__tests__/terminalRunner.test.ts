import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TerminalRunner, type TerminalChunk } from '../terminalRunner';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-terminal-runner-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('TerminalRunner', () => {
  it('streams stdout and stderr while preserving the buffered result', async () => {
    const chunks: TerminalChunk[] = [];
    const result = await new TerminalRunner().runStreaming(
      {
        kind: 'test',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("out"); process.stderr.write("err");'],
        cwd: tmpDir,
        reason: 'stream test',
        timeoutMs: 30_000,
      },
      tmpDir,
      (chunk) => {
        chunks.push(chunk);
      },
    );

    expect(result.status).toBe('passed');
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
    expect(chunks.some((chunk) => chunk.stream === 'stdout' && chunk.chunk.includes('out'))).toBe(true);
    expect(chunks.some((chunk) => chunk.stream === 'stderr' && chunk.chunk.includes('err'))).toBe(true);
  });
});

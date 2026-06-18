import { spawn } from 'node:child_process';
import { formatCommand, isRiskyTerminalCommand, redactTerminalOutput, type TerminalCommand } from './terminalPolicy';

export interface TerminalRunResult {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  output: string;
  durationMs: number;
}

export interface TerminalChunk {
  stream: 'stdout' | 'stderr';
  chunk: string;
  command: string;
}

export class TerminalRunner {
  async run(command: TerminalCommand, root: string, signal?: AbortSignal): Promise<TerminalRunResult> {
    return this.runStreaming(command, root, undefined, signal);
  }

  async runStreaming(
    command: TerminalCommand,
    root: string,
    onChunk?: (chunk: TerminalChunk) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<TerminalRunResult> {
    const startedAt = Date.now();
    const displayCommand = formatCommand(command);
    if (isRiskyTerminalCommand(command)) {
      return {
        command: displayCommand,
        status: 'skipped',
        output: `Command requires explicit approval: ${displayCommand}`,
        durationMs: Date.now() - startedAt,
      };
    }
    if (signal?.aborted) {
      return {
        command: displayCommand,
        status: 'skipped',
        output: 'Command skipped because the run was cancelled.',
        durationMs: Date.now() - startedAt,
      };
    }

    const outputParts: string[] = [];
    const maxBuffer = 1024 * 1024 * 12;
    let collectedBytes = 0;
    let timedOut = false;

    const appendOutput = async (stream: 'stdout' | 'stderr', value: Buffer | string) => {
      const text = redactTerminalOutput(String(value));
      collectedBytes += Buffer.byteLength(text);
      if (collectedBytes <= maxBuffer) outputParts.push(text);
      await onChunk?.({ stream, chunk: text, command: displayCommand });
    };

    return new Promise<TerminalRunResult>((resolve) => {
      const child = spawn(command.command, command.args, {
        cwd: command.cwd ?? root,
        env: { ...process.env },
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, command.timeoutMs ?? 120_000);

      const abort = () => {
        child.kill('SIGTERM');
      };
      signal?.addEventListener('abort', abort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        void appendOutput('stdout', chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        void appendOutput('stderr', chunk);
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        const output = redactTerminalOutput([...outputParts, error.message].filter(Boolean).join('\n').trim() || command.reason);
        resolve({
          command: displayCommand,
          status: signal?.aborted ? 'skipped' : 'failed',
          output,
          durationMs: Date.now() - startedAt,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        const timeoutMessage = timedOut ? `\nCommand timed out after ${command.timeoutMs ?? 120_000}ms.` : '';
        const clippedMessage = collectedBytes > maxBuffer ? '\n[Output exceeded terminal buffer and was truncated.]' : '';
        const output = redactTerminalOutput(`${outputParts.join('').trim()}${timeoutMessage}${clippedMessage}`.trim() || command.reason);
        resolve({
          command: displayCommand,
          status: signal?.aborted ? 'skipped' : code === 0 && !timedOut ? 'passed' : 'failed',
          output,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}

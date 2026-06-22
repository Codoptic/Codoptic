export interface TerminalCommand {
  kind:
    | 'explore'
    | 'shell'
    | 'script'
    | 'syntax'
    | 'format'
    | 'test'
    | 'typecheck'
    | 'lint'
    | 'build'
    | 'e2e';
  command: string;
  args: string[];
  cwd?: string;
  reason: string;
  timeoutMs?: number;
}

const RISKY_COMMAND_PATTERN = /\b(rm\s+-rf|git\s+push|npm\s+install|pnpm\s+add|yarn\s+add|bun\s+add|prisma\s+migrate|drop\s+database|curl\s+.*\|\s*sh)\b/i;
const CIRCUIT_BREAKER_PATTERN = /\b(rm\s+-rf\s+(?:\/|~|"\$HOME"|\$HOME|\*))|:\(\)\s*\{\s*:\|\:&\s*\}/i;

export function isRiskyTerminalCommand(command: TerminalCommand): boolean {
  return RISKY_COMMAND_PATTERN.test([command.command, ...command.args].join(' '));
}

export function isCircuitBreakerTerminalCommand(command: TerminalCommand): boolean {
  return CIRCUIT_BREAKER_PATTERN.test([command.command, ...command.args].join(' '));
}

export function redactTerminalOutput(output: string): string {
  return output
    .replace(/(api[_-]?key|token|secret|password|authorization|cookie)=\S+/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{20,})\b/gi, '[REDACTED]');
}

export function formatCommand(command: TerminalCommand): string {
  return [command.command, ...command.args].join(' ');
}

import type { ValidationRunResult } from './validationRunner';

export interface RepairFailureFingerprint {
  command: string;
  kind: ValidationRunResult['kind'];
  category: 'syntax' | 'typecheck' | 'lint' | 'test' | 'build' | 'runtime' | 'unknown';
  anchor: string;
  hash: string;
}

export interface RepairStateDecision {
  repeated: boolean;
  count: number;
  fingerprint: RepairFailureFingerprint;
  blocker?: string;
}

export class RepairStateMachine {
  private readonly seen = new Map<string, number>();

  constructor(private readonly repeatedFailureLimit = 3) {}

  observe(result: ValidationRunResult): RepairStateDecision {
    const fingerprint = fingerprintValidationFailure(result);
    const count = (this.seen.get(fingerprint.hash) ?? 0) + 1;
    this.seen.set(fingerprint.hash, count);
    return {
      repeated: count > 1,
      count,
      fingerprint,
      blocker:
        count >= this.repeatedFailureLimit
          ? `Repeated ${fingerprint.category} failure after ${count} attempts: ${fingerprint.command} (${fingerprint.anchor}).`
          : undefined,
    };
  }
}

export function fingerprintValidationFailure(result: ValidationRunResult): RepairFailureFingerprint {
  const output = result.output || '';
  const category = classifyFailure(result.command, output, result.kind);
  const anchor = extractAnchor(output);
  const normalized = `${result.command}\n${category}\n${anchor}`.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return {
    command: result.command,
    kind: result.kind,
    category,
    anchor,
    hash: hashString(normalized),
  };
}

function classifyFailure(command: string, output: string, kind: ValidationRunResult['kind']): RepairFailureFingerprint['category'] {
  const haystack = `${command}\n${output}`;
  if (kind === 'syntax' || /\b(SyntaxError|IndentationError|compileall|parse error)\b/i.test(haystack)) return 'syntax';
  if (kind === 'typecheck' || /\b(TS\d{4}|type error|mypy|tsc)\b/i.test(haystack)) return 'typecheck';
  if (kind === 'lint' || /\b(eslint|ruff|flake8|lint|no-unused-vars|prefer-const)\b/i.test(haystack)) return 'lint';
  if (kind === 'test' || /\b(AssertionError|expected|received|FAIL|FAILED|pytest|vitest|jest)\b/i.test(haystack)) return 'test';
  if (kind === 'build' || /\b(next build|vite build|webpack|failed to compile|prerender)\b/i.test(haystack)) return 'build';
  if (/\b(TypeError|ReferenceError|RangeError|runtime)\b/i.test(haystack)) return 'runtime';
  return 'unknown';
}

function extractAnchor(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fileLine = lines.find((line) => /(?:^|[\s("'`])[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|css|scss|json|md)(?::\d+)?/.test(line));
  const errorLine = lines.find((line) => /\b(error|failed|exception|TS\d{4}|SyntaxError|AssertionError)\b/i.test(line));
  return (fileLine || errorLine || lines[0] || 'unknown failure').slice(0, 240);
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 33) ^ value.charCodeAt(index);
  return (hash >>> 0).toString(16);
}

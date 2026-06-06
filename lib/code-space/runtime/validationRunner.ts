import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeAgentArtifact, type AgentArtifact } from '@/lib/code-space/agent/artifacts';
import { pathExists } from './repoMap';
import { TerminalRunner, type TerminalRunResult } from './terminalRunner';
import type { TerminalCommand } from './terminalPolicy';

export interface ValidationRunResult extends TerminalRunResult {
  kind: TerminalCommand['kind'];
  artifact?: AgentArtifact;
}

/**
 * Progressive validation strategy order: cheap/structural gates first (syntax → typecheck → lint),
 * then behavioral gates (unit tests → integration/e2e), then the expensive full build. Running in
 * this order surfaces the smallest, fastest-to-fix failures before the slow ones.
 */
const STRATEGY_ORDER: TerminalCommand['kind'][] = ['syntax', 'format', 'typecheck', 'lint', 'test', 'e2e', 'build', 'script', 'shell', 'explore'];

export function progressiveOrder(commands: TerminalCommand[]): TerminalCommand[] {
  const rank = (kind: TerminalCommand['kind']): number => {
    const index = STRATEGY_ORDER.indexOf(kind);
    return index === -1 ? STRATEGY_ORDER.length : index;
  };
  return [...commands].sort((a, b) => rank(a.kind) - rank(b.kind));
}

export class ValidationRunner {
  constructor(private readonly terminal = new TerminalRunner()) {}

  async detectValidationCommands(rootPath: string, changedPaths: string[] = []): Promise<TerminalCommand[]> {
    const commands: TerminalCommand[] = [];
    const packageJsonPath = await findFirst(rootPath, ['package.json', 'frontend/package.json', 'client/package.json', 'app/package.json', 'web/package.json']);
    if (packageJsonPath) {
      const absolute = path.join(rootPath, packageJsonPath);
      const pkg = JSON.parse(await fs.readFile(absolute, 'utf8')) as { scripts?: Record<string, string>; packageManager?: string };
      const packageRoot = path.dirname(packageJsonPath);
      const cwd = path.join(rootPath, packageRoot);
      const packageManager = await detectPackageManager(cwd, pkg.packageManager);
      const scripts = pkg.scripts ?? {};
      if (scripts.typecheck) commands.push({ kind: 'typecheck', command: packageManager, args: ['run', 'typecheck'], cwd, reason: 'TypeScript/no-emit validation is available.', timeoutMs: 120_000 });
      if (scripts.lint) commands.push({ kind: 'lint', command: packageManager, args: ['run', 'lint'], cwd, reason: 'Lint validation is available.', timeoutMs: 120_000 });
      const focusedTestTargets = focusTestTargets(changedPaths);
      if (scripts.test && focusedTestTargets.length) {
        commands.push({
          kind: 'test',
          command: packageManager,
          args: ['run', 'test', '--', ...focusedTestTargets],
          cwd,
          reason: 'Focused test validation for changed test/source paths is available.',
          timeoutMs: 180_000,
        });
      }
      if (scripts.test) commands.push({ kind: 'test', command: packageManager, args: ['run', 'test'], cwd, reason: 'Automated tests are available.', timeoutMs: 180_000 });
      if (scripts.build) commands.push({ kind: 'build', command: packageManager, args: ['run', 'build'], cwd, reason: 'Production build validation is available.', timeoutMs: 180_000 });
    }

    const pythonConfig = await findFirst(rootPath, ['pyproject.toml', 'requirements.txt', 'backend/requirements.txt', 'api/requirements.txt', 'pytest.ini', 'setup.py']);
    if (pythonConfig) {
      const cwd = path.join(rootPath, path.dirname(pythonConfig));
      commands.push({ kind: 'syntax', command: 'python3', args: ['-m', 'compileall', '.'], cwd, reason: 'Python syntax and indentation compilation is required.', timeoutMs: 120_000 });
      commands.push({ kind: 'test', command: 'python3', args: ['-m', 'pytest'], cwd, reason: 'Pytest must run for Python work; missing pytest is reported as validation output.', timeoutMs: 180_000 });
    }

    if (!commands.length && (await pathExists(rootPath, 'go.mod'))) {
      commands.push({ kind: 'test', command: 'go', args: ['test', './...'], cwd: rootPath, reason: 'Go module validation is available.', timeoutMs: 180_000 });
    }
    if (!commands.length && (await pathExists(rootPath, 'Cargo.toml'))) {
      commands.push({ kind: 'test', command: 'cargo', args: ['test'], cwd: rootPath, reason: 'Rust crate validation is available.', timeoutMs: 180_000 });
    }

    return commands;
  }

  async runValidationCommands(rootPath: string, runId: string, commands: TerminalCommand[], signal?: AbortSignal): Promise<ValidationRunResult[]> {
    if (!commands.length) {
      return [
        {
          kind: 'typecheck',
          command: 'manual review',
          status: 'skipped',
          output: 'No project-specific validation command was detected. Treat the patch as unverified until an appropriate compile/test command is run manually.',
          durationMs: 0,
        },
      ];
    }

    const results: ValidationRunResult[] = [];
    for (const command of commands) {
      const result = await this.terminal.run(command, rootPath, signal);
      const artifact = await writeAgentArtifact({
        projectRoot: rootPath,
        runId,
        kind: 'validation_report',
        content: result.output,
        summary: `${result.command}: ${result.status}`,
      });
      results.push({ ...result, kind: command.kind, artifact, output: truncateVisibleOutput(result.output) });
      if (signal?.aborted) break;
    }
    return results;
  }
}

function truncateVisibleOutput(output: string): string {
  return output.length > 1200 ? `${output.slice(0, 1200)}\n…\n[Full output stored as artifact]` : output;
}

async function findFirst(root: string, relativePaths: string[]): Promise<string | null> {
  for (const relativePath of relativePaths) {
    if (await pathExists(root, relativePath)) return relativePath;
  }
  return null;
}

async function hasAny(root: string, relativePaths: string[]): Promise<boolean> {
  for (const relativePath of relativePaths) {
    if (await pathExists(root, relativePath)) return true;
  }
  return false;
}

async function detectPackageManager(rootPath: string, packageManager?: string): Promise<string> {
  if (packageManager?.startsWith('pnpm')) return 'pnpm';
  if (packageManager?.startsWith('yarn')) return 'yarn';
  if (packageManager?.startsWith('bun')) return 'bun';
  if (await pathExists(rootPath, 'pnpm-lock.yaml')) return 'pnpm';
  if (await pathExists(rootPath, 'yarn.lock')) return 'yarn';
  if (await pathExists(rootPath, 'bun.lockb')) return 'bun';
  return 'npm';
}

function focusTestTargets(changedPaths: string[]): string[] {
  const targets = changedPaths
    .map((item) => item.replace(/\\/g, '/'))
    .filter((item) => /\.(test|spec)\.(tsx?|jsx?)$/.test(item) || /(^|\/)(__tests__|tests?)\//.test(item))
    .slice(0, 8);
  return Array.from(new Set(targets));
}

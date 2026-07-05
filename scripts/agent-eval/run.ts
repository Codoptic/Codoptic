/**
 * Real-system agent evaluation harness.
 *
 * Drives the LIVE Code Space agent (POST /api/code-space/agent) against a
 * disposable medium-hard fixture repo using the real Foundry gpt-5.4 model, then
 * asserts the industry-standard Definition of Done. Each check is tagged with the
 * phase that delivers it, so `--phase N` enforces only what should exist so far.
 *
 * Usage:
 *   npm run dev                       # in another terminal
 *   npx tsx scripts/agent-eval/run.ts --phase 1 [--scenario bugfix-code-git] [--keep]
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFoundryCreds } from './lib/env';
import { createFixture, removeFixture, type FixtureOptions } from './lib/fixture';
import { runAgent, type AgentRequestBody, type RunResult } from './lib/sse';
import * as checks from './lib/assertions';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const FIXTURE_BASE = path.join(os.homedir(), 'Downloads', 'codoptic-agent-eval');

interface Check {
  id: string;
  phase: number;
  run: (result: RunResult) => checks.CheckOutcome;
}

interface Scenario {
  name: string;
  description: string;
  fixture: Omit<FixtureOptions, 'root'>;
  mode: 'ask' | 'plan' | 'code';
  prompt: string;
  checks: Check[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'ambiguous-plan',
    description: 'Vague feature request in Plan mode must trigger MCQ clarification before planning.',
    fixture: { git: true, withBug: false },
    mode: 'plan',
    prompt: 'Make the warehouse service better and add caching where it makes sense.',
    checks: [
      { id: 'no-agent-error', phase: 0, run: checks.noAgentError },
      { id: 'asks-mcq-clarification', phase: 2, run: (r) => checks.asksClarifyingQuestions(r, 2) },
      { id: 'mcq-have-rationale', phase: 2, run: checks.questionsHaveRationale },
    ],
  },
  {
    name: 'plan-depth-kg',
    description: 'Concrete Plan-mode task produces a deep plan and (first run) builds a knowledge graph.',
    fixture: { git: true, withBug: false },
    mode: 'plan',
    prompt:
      'Add a configurable low-stock threshold to src/inventory.mjs so available() callers can detect SKUs that need reordering, and expose it through placeOrder in src/orders.mjs.',
    checks: [
      { id: 'no-agent-error', phase: 0, run: checks.noAgentError },
      { id: 'plan-has-base-sections', phase: 0, run: (r) => checks.planHasSections(r, ['Summary', 'Definition of Done']) },
      { id: 'plan-has-approaches', phase: 2, run: (r) => checks.planHasSections(r, ['Candidate Approaches']) },
      { id: 'knowledge-graph-built', phase: 4, run: checks.knowledgeGraphReady },
    ],
  },
  {
    name: 'plan-to-code-low-stock',
    description: 'Code mode builds from an approved markdown plan and must surface a multi-requirement implementation contract.',
    fixture: { git: true, withBug: false, plan: 'low-stock-threshold' },
    mode: 'code',
    prompt: 'Build from the approved plan at .agent/plans/low-stock-threshold.md.',
    checks: [
      { id: 'no-agent-error', phase: 0, run: checks.noAgentError },
      { id: 'coverage-has-plan-requirements', phase: 0, run: (r) => checks.coverageHasMultipleRequirements(r, 3) },
      { id: 'produced-file-changes', phase: 0, run: checks.producedFileChanges },
      { id: 'diff-gate-carries-diff', phase: 1, run: checks.diffGateCarriesDiff },
      { id: 'ran-real-validation', phase: 1, run: checks.ranRealValidation },
    ],
  },
  {
    name: 'bugfix-code-git',
    description: 'Clear bug fix in a git repo: real validation runs, diff gate fires, no verified-without-changes.',
    fixture: { git: true, withBug: true },
    mode: 'code',
    prompt:
      'Fix the oversell bug: Inventory.reserve() in src/inventory.mjs must refuse to reserve more than the available stock (return false and leave stock unchanged). The failing tests in test/inventory.test.mjs describe the expected behavior.',
    checks: [
      { id: 'no-agent-error', phase: 0, run: checks.noAgentError },
      { id: 'produced-file-changes', phase: 0, run: checks.producedFileChanges },
      { id: 'no-verified-without-changes', phase: 0, run: checks.noVerifiedWithoutChanges },
      { id: 'ran-real-validation', phase: 1, run: checks.ranRealValidation },
      { id: 'diff-gate-before-validation', phase: 1, run: checks.diffGateBeforeValidation },
      { id: 'diff-gate-carries-diff', phase: 1, run: checks.diffGateCarriesDiff },
    ],
  },
  {
    name: 'nongit-code',
    description: 'Bug fix in a non-git folder: the diff gate falls back to a ledger-derived diff.',
    fixture: { git: false, withBug: true },
    mode: 'code',
    prompt:
      'Fix the oversell bug in src/inventory.mjs so reserve() refuses to oversell, matching the failing tests in test/inventory.test.mjs.',
    checks: [
      { id: 'no-agent-error', phase: 0, run: checks.noAgentError },
      { id: 'produced-file-changes', phase: 0, run: checks.producedFileChanges },
      { id: 'diff-gate-carries-diff', phase: 1, run: checks.diffGateCarriesDiff },
    ],
  },
];

interface Args {
  phase: number;
  baseUrl: string;
  scenario?: string;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: 99, baseUrl: 'http://localhost:3000', keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--phase') args.phase = Number(argv[++i] ?? '99');
    else if (arg === '--base-url') args.baseUrl = argv[++i] ?? args.baseUrl;
    else if (arg === '--scenario') args.scenario = argv[++i];
    else if (arg === '--keep') args.keep = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const creds = resolveFoundryCreds(REPO_ROOT);
  const scenarios = args.scenario ? SCENARIOS.filter((s) => s.name === args.scenario) : SCENARIOS;
  if (!scenarios.length) {
    console.error(`No scenario named "${args.scenario}". Known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }

  console.log(`\nCodoptic agent eval — model=${creds.model} baseUrl=${args.baseUrl} enforcing phase<=${args.phase}\n`);

  let enforcedFailures = 0;
  const summary: string[] = [];

  for (const scenario of scenarios) {
    const root = path.join(FIXTURE_BASE, scenario.name);
    console.log(`\n=== ${scenario.name} ===\n${scenario.description}`);
    createFixture({ root, ...scenario.fixture });

    const body: AgentRequestBody = {
      sessionId: `eval-${scenario.name}-${Date.now()}`,
      projectRoot: root,
      projectName: `eval-${scenario.name}`,
      messages: [{ role: 'user', content: scenario.prompt }],
      model: creds.model,
      providerId: creds.providerId,
      apiKey: creds.apiKey,
      endpoint: creds.endpoint,
      mode: scenario.mode,
      toolBudget: 40,
      autonomy: 'auto_safe_tools',
    };

    let result: RunResult;
    try {
      result = await runAgent(body, {
        baseUrl: args.baseUrl,
        timeoutMs: 300_000,
        onEvent: (event) => {
          if (event.type === 'agent_error') console.log(`   [stream] agent_error: ${String(event.message).slice(0, 200)}`);
        },
      });
    } catch (error) {
      console.error(`   RUN FAILED: ${(error as Error).message}`);
      enforcedFailures += 1;
      summary.push(`FAIL  ${scenario.name} (run crashed)`);
      if (!args.keep) removeFixture(root);
      continue;
    }

    const eventTypes = new Map<string, number>();
    for (const event of result.events) eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1);
    console.log(`   events: ${[...eventTypes.entries()].map(([t, n]) => `${t}×${n}`).join(', ')}`);

    for (const check of scenario.checks) {
      const outcome = check.run(result);
      const enforced = check.phase <= args.phase;
      const mark = outcome.ok ? 'PASS' : enforced ? 'FAIL' : 'pend';
      console.log(`   [${mark}] (p${check.phase}) ${check.id} — ${outcome.detail}`);
      if (enforced && !outcome.ok) {
        enforcedFailures += 1;
        summary.push(`FAIL  ${scenario.name} / ${check.id}`);
      }
    }

    if (!args.keep) removeFixture(root);
  }

  console.log(`\n--- summary (phase<=${args.phase}) ---`);
  if (!enforcedFailures) {
    console.log('All enforced checks passed.');
  } else {
    for (const line of summary) console.log(line);
    console.log(`\n${enforcedFailures} enforced check(s) failed.`);
  }
  process.exit(enforcedFailures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});

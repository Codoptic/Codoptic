import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantTurn } from '@/lib/agent/providers';
import { chatTurnWithTools } from '@/lib/agent/providers';
import { AgentRuntime, runtimeSourceFingerprintForTests } from '../agentRuntime';
import { PlanningEngine, REQUIRED_PLAN_SECTIONS, sanitizePlanMarkdown } from '../planningEngine';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';

vi.mock('@/lib/agent/providers', () => ({
  chatTurnWithTools: vi.fn(),
}));

const mockedTurn = vi.mocked(chatTurnWithTools);

function turn(partial: Partial<AssistantTurn>): AssistantTurn {
  return { text: '', toolCalls: [], stopReason: 'tool_use', ...partial };
}

const PLAN_MARKDOWN = ['# Plan: model-authored', '', ...REQUIRED_PLAN_SECTIONS.map((section) => `## ${section}\n- detail grounded in app.ts`)].join('\n');

let tmpDir: string | null = null;

beforeEach(() => {
  mockedTurn.mockReset();
});

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('AgentRuntime workflow contracts', () => {
  it('keeps ask mode read-only and avoids dummy internal workflow language', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-agent-runtime-ask-'));
    await writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    await writeFile(path.join(tmpDir, 'src.ts'), 'export const answer = 42;\n', 'utf8');
    const before = await readFile(path.join(tmpDir, 'src.ts'), 'utf8');
    const events: AgentSSEEvent[] = [];

    await new AgentRuntime().run(
      {
        sessionId: 's1',
        projectRoot: tmpDir,
        projectName: 'demo',
        messages: [{ role: 'user', content: 'What does answer do in src.ts?' }],
        mode: 'ask',
        model: 'test',
        providerId: 'openai',
        apiKey: '',
        openTabs: [],
        toolBudget: 20,
        autonomy: 'auto_safe_tools',
        attachments: [{ kind: 'file', relativePath: 'src.ts', displayName: 'src.ts' }],
      },
      (event) => {
        events.push(event);
      },
    );

    expect(await readFile(path.join(tmpDir, 'src.ts'), 'utf8')).toBe(before);
    expect(events.some((event) => event.type === 'diff_proposed' || event.type === 'file_applied')).toBe(false);
    const final = events.find((event) => event.type === 'agent_done');
    expect(final?.summary).not.toMatch(/Reviewed \d+ files|Visible workflow|Repository map|Validation available/i);
  });

  it('code mode emits a review diff, then validates and completes after the supervisor verdict', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-agent-runtime-code-auto-'));
    await writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      'utf8',
    );
    await writeFile(path.join(tmpDir, 'src.ts'), 'export const answer = 1;\n', 'utf8');

    mockedTurn
      .mockResolvedValueOnce(turn({ toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'src.ts' } }] }))
      .mockResolvedValueOnce(turn({
        toolCalls: [{
          id: 't2',
          name: 'edit_file',
          input: { edits: [{ path: 'src.ts', search: 'export const answer = 1;', replace: 'export const answer = 2;', reason: 'Update answer.' }] },
        }],
      }))
      .mockResolvedValueOnce(turn({ toolCalls: [{ id: 't3', name: 'attempt_completion', input: { success: true, summary: 'Updated answer.' } }] }))
      .mockResolvedValueOnce(turn({
        toolCalls: [{
          id: 't4',
          name: 'edit_file',
          input: { edits: [{ path: '.agent/tests/smoke.js', search: '', replace: 'console.log("smoke");\n', reason: 'Add focused smoke script.' }] },
        }],
      }))
      .mockResolvedValueOnce(turn({
        toolCalls: [{ id: 't5', name: 'run_command', input: { command: 'node', args: ['.agent/tests/smoke.js'], reason: 'Run focused smoke script.' } }],
      }))
      .mockResolvedValueOnce(turn({ toolCalls: [{ id: 't6', name: 'attempt_completion', input: { success: true, summary: 'Smoke script passed.' } }] }));

    const events: AgentSSEEvent[] = [];
    await new AgentRuntime().run(
      {
        sessionId: 'session-code-auto',
        projectRoot: tmpDir,
        projectName: 'demo',
        messages: [{ role: 'user', content: 'Update answer in src.ts' }],
        mode: 'code',
        model: 'test',
        providerId: 'openai',
        apiKey: 'test-key',
        openTabs: ['src.ts'],
        toolBudget: 20,
        autonomy: 'auto_safe_tools',
        attachments: [],
      },
      (event) => {
        events.push(event);
      },
    );

    const diffIndex = events.findIndex((event) => event.type === 'diff_confirmation_required');
    const validationIndex = events.findIndex((event) => event.type === 'validation_result');
    const doneIndex = events.findIndex((event) => event.type === 'agent_done');
    expect(diffIndex).toBeGreaterThanOrEqual(0);
    expect(validationIndex).toBeGreaterThan(diffIndex);
    expect(doneIndex).toBeGreaterThan(validationIndex);
    expect(events.some((event) => event.type === 'structured_event' && event.event.type === 'plan.updated' && (event.event.payload as { phase?: string }).phase === 'diff_review_emitted')).toBe(true);
    const verdicts = events.filter((event) => event.type === 'supervisor_verdict');
    expect(verdicts).toContainEqual({ type: 'supervisor_verdict', status: 'verified', blockers: [] });
    expect(await readFile(path.join(tmpDir, 'src.ts'), 'utf8')).toContain('answer = 2');
  });

  it('plan mode requires a provider key and reports needs_review when none is configured', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-agent-runtime-plan-nokey-'));
    await writeFile(path.join(tmpDir, 'app.ts'), 'export function run() { return true; }\n', 'utf8');
    const events: AgentSSEEvent[] = [];

    await new AgentRuntime().run(
      {
        sessionId: 'session-plan-nokey',
        projectRoot: tmpDir,
        projectName: 'demo',
        messages: [
          { role: 'user', content: 'Plan a runtime refactor for app.ts' },
          { role: 'user', content: 'Plan clarification answers: preserve the exported run API and validate with the detected test command.' },
        ],
        mode: 'plan',
        model: 'test',
        providerId: 'openai',
        apiKey: '',
        openTabs: ['app.ts'],
        toolBudget: 20,
        autonomy: 'auto_safe_tools',
        attachments: [],
      },
      (event) => {
        events.push(event);
      },
    );

    expect(events.some((event) => event.type === 'plan_markdown_created')).toBe(false);
    expect(mockedTurn).not.toHaveBeenCalled();
    const done = events.find((event) => event.type === 'agent_done');
    expect(done?.summary).toMatch(/not configured|provider key/i);
  });

  it('plan mode authors the artifact via the LLM after reading evidence, staying read-only', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-agent-runtime-plan-llm-'));
    await writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }), 'utf8');
    await writeFile(path.join(tmpDir, 'app.ts'), 'export function run() { return true; }\n', 'utf8');

    mockedTurn
      .mockResolvedValueOnce(turn({ toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'app.ts' } }] }))
      .mockResolvedValueOnce(turn({ toolCalls: [{ id: 't2', name: 'write_plan_artifact', input: { planMarkdown: PLAN_MARKDOWN, summary: 'Refactor app.run', status: 'ready', inspectedFiles: ['app.ts'] } }] }))
      .mockResolvedValueOnce(turn({ stopReason: 'end_turn', toolCalls: [] }));

    const events: AgentSSEEvent[] = [];
    await new AgentRuntime().run(
      {
        sessionId: 'session-plan-llm',
        projectRoot: tmpDir,
        projectName: 'demo',
        messages: [
          { role: 'user', content: 'Plan a runtime refactor for app.ts' },
          { role: 'user', content: 'Plan clarification answers: preserve the exported run API and validate with the detected test command.' },
        ],
        mode: 'plan',
        model: 'test',
        providerId: 'openai',
        apiKey: 'test-key',
        openTabs: ['app.ts'],
        toolBudget: 20,
        autonomy: 'auto_safe_tools',
        attachments: [],
      },
      (event) => {
        events.push(event);
      },
    );

    const planEvent = events.find((event) => event.type === 'plan_markdown_created');
    expect(planEvent?.filePath).toBe('.agent/plans/session-plan-llm.md');
    expect(planEvent?.content).toBe(`${PLAN_MARKDOWN}\n`);
    expect(planEvent?.content).toContain('## Summary');
    // Read-only invariant: planning never proposes or applies file changes.
    expect(events.some((event) => event.type === 'diff_proposed' || event.type === 'file_applied')).toBe(false);
  });

  it('plan mode pauses for LLM-authored high-level clarification after reading evidence', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-agent-runtime-plan-clarify-'));
    await writeFile(path.join(tmpDir, 'app.ts'), 'export function run() { return true; }\n', 'utf8');

    mockedTurn
      .mockResolvedValueOnce(turn({ toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'app.ts' } }] }))
      .mockResolvedValueOnce(turn({ toolCalls: [{ id: 't2', name: 'ask_clarifying_questions', input: { questions: [{ question: 'Should this refactor preserve the exported run API or introduce a new runtime entrypoint?', rationale: 'The selected boundary changes whether callers keep importing run or migrate to a new module.', options: [{ label: 'Preserve run API', description: 'Keep the existing exported function as the public boundary.' }, { label: 'New entrypoint', description: 'Introduce a replacement runtime boundary and plan caller migration.' }] }] } }] }))
      .mockResolvedValueOnce(turn({ stopReason: 'end_turn', toolCalls: [] }));

    const events: AgentSSEEvent[] = [];
    await new AgentRuntime().run(
      {
        sessionId: 'session-plan-clarify',
        projectRoot: tmpDir,
        projectName: 'demo',
        messages: [{ role: 'user', content: 'Refactor app.ts somehow' }],
        mode: 'plan',
        model: 'test',
        providerId: 'openai',
        apiKey: 'test-key',
        openTabs: ['app.ts'],
        toolBudget: 20,
        autonomy: 'auto_safe_tools',
        attachments: [],
      },
      (event) => {
        events.push(event);
      },
    );

    const clarify = events.find((event) => event.type === 'clarifying_questions_created');
    expect(clarify && clarify.type === 'clarifying_questions_created' ? clarify.questions[0]?.question : '').toMatch(/run API|entrypoint/i);
    expect(events.some((event) => event.type === 'plan_markdown_created')).toBe(false);
    expect(mockedTurn.mock.calls.length).toBe(3);
    expect(events.some((event) => event.type === 'structured_event' && event.event.type === 'file.read')).toBe(true);
  });

  it('does not synthesize clarification questions when the model can author a plan', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-agent-runtime-plan-no-force-clarify-'));
    await writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    await writeFile(path.join(tmpDir, 'app.ts'), 'export function run() { return true; }\n', 'utf8');

    mockedTurn
      .mockResolvedValueOnce(turn({ toolCalls: [{ id: 't1', name: 'write_plan_artifact', input: { planMarkdown: PLAN_MARKDOWN, summary: 'Refactor app.run', status: 'ready', inspectedFiles: ['app.ts'] } }] }))
      .mockResolvedValueOnce(turn({ stopReason: 'end_turn', toolCalls: [] }));

    const events: AgentSSEEvent[] = [];
    await new AgentRuntime().run(
      {
        sessionId: 'session-plan-no-force-clarify',
        projectRoot: tmpDir,
        projectName: 'demo',
        messages: [{ role: 'user', content: 'Plan a runtime refactor for app.ts' }],
        mode: 'plan',
        model: 'test',
        providerId: 'openai',
        apiKey: 'test-key',
        openTabs: ['app.ts'],
        toolBudget: 20,
        autonomy: 'auto_safe_tools',
        attachments: [],
      },
      (event) => {
        events.push(event);
      },
    );

    expect(events.some((event) => event.type === 'clarifying_questions_created')).toBe(false);
    expect(events.some((event) => event.type === 'plan_markdown_created')).toBe(true);
  });

  it('always produces a previewable plan artifact after clarification even if the model never calls write_plan_artifact', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-agent-runtime-plan-fallback-'));
    await writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    await writeFile(path.join(tmpDir, 'app.ts'), 'export function run() { return true; }\n', 'utf8');

    // Model keeps answering in prose with no tool calls — it never finalizes the plan.
    mockedTurn.mockResolvedValue(turn({ stopReason: 'end_turn', text: 'Here is a plan...', toolCalls: [] }));

    const events: AgentSSEEvent[] = [];
    await new AgentRuntime().run(
      {
        sessionId: 'session-plan-fallback',
        projectRoot: tmpDir,
        projectName: 'medbot',
        messages: [
          { role: 'user', content: 'Plan a refactor for app.ts' },
          { role: 'user', content: 'Plan clarification answers: preserve the exported run API and validate with the detected test command.' },
        ],
        mode: 'plan',
        model: 'test',
        providerId: 'openai',
        apiKey: 'test-key',
        openTabs: ['app.ts'],
        toolBudget: 20,
        autonomy: 'auto_safe_tools',
        attachments: [],
      },
      (event) => {
        events.push(event);
      },
    );

    const planEvent = events.find((event) => event.type === 'plan_markdown_created');
    expect(planEvent?.filePath).toBe('.agent/plans/session-plan-fallback.md');
    expect(planEvent?.content).toContain('## Summary');
    // The escalation pushed the model to finalize before falling back.
    expect(mockedTurn.mock.calls.length).toBeGreaterThan(1);
    const done = events.find((event) => event.type === 'agent_done');
    expect(done?.filesChanged).toContain('.agent/plans/session-plan-fallback.md');
  });

  it('keeps private runbook diagnostics out of deterministic plan artifacts', () => {
    const content = new PlanningEngine().buildPlanArtifact({
      projectName: 'demo',
      prompt: 'Plan a runtime refactor for app.ts',
      validationCommands: [],
      context: {
        filesConsidered: 1,
        files: [],
        selectedFiles: [],
        omittedRelevantCandidates: ['app.ts', 'app.test.ts'],
        terms: [],
        dependencyEdges: [],
        testCandidates: [],
        validationCandidates: [],
        missingContextWarnings: ['No tests loaded yet.'],
        confidence: 'low',
      },
    });

    expect(content).toContain('## Repository Evidence Reviewed');
    for (const hiddenText of [
      '## Context Sufficiency Gate',
      'Status: needs_recall',
      'Status: ready',
      'Remaining blocker surfaces',
      '## Current-State Diagnosis to Verify',
      'Diagnosis Checks Before Editing Code',
      '## Target Design Direction',
      '## Safety and Change Control',
      '## Repair Policy',
      'Repair Plan',
      'Implementation Policy for the Next Code Run',
      '## Definition of Done',
      '## Final Response Format',
      'Final Response Format for the Implementation Run',
      '## Candidate Approaches and Recommendation',
      'Approach 1',
      'Approach A',
    ]) {
      expect(content).not.toContain(hiddenText);
    }
  });

  it('sanitizes hidden status and approach menu sections from model-authored plans', () => {
    const content = sanitizePlanMarkdown([
      '# Plan',
      '',
      '## Summary',
      '- Request: demo',
      '- Status: ready',
      '',
      '## Candidate Approaches and Recommendation',
      '- Approach 1: do the small thing',
      '- Approach 2: do the big thing',
      '',
      '## Implementation Milestones',
      '- Keep this milestone.',
    ].join('\n'));

    expect(content).toContain('## Summary');
    expect(content).toContain('## Implementation Milestones');
    expect(content).not.toContain('Status: ready');
    expect(content).not.toContain('Candidate Approaches');
    expect(content).not.toContain('Approach 1');
  });

  it('exposes a stable runtime fingerprint for route delegation tests', () => {
    expect(runtimeSourceFingerprintForTests()).toHaveLength(64);
  });
});

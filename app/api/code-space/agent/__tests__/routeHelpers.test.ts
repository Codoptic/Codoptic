import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildClarifyingQuestions,
  buildPlan,
  buildPlanImplementationPrompt,
  buildStrategyDocument,
  collectProjectContext,
  extractBuildPlanPath,
} from '../route';
import {
  buildCodeCompletionResponse,
  buildPlanCompletionResponse,
} from '@/lib/code-space/agent/runResponses';

describe('Code Space agent route mode helpers', () => {
  it('builds deterministic workflow items from inspected context without route-local orchestration', async () => {
    const plan = await buildPlan('plan', ['feature_build'], 'make this better', {
      filesConsidered: 4,
      terms: [],
      selectedFiles: ['components/code-space/AgentPanel.tsx'],
      omittedRelevantCandidates: [],
      dependencyEdges: [],
      testCandidates: [],
      validationCandidates: [],
      missingContextWarnings: [],
      confidence: 'medium',
      files: [
        {
          path: 'components/code-space/AgentPanel.tsx',
          content: '',
          truncated: false,
          mode: 'full',
          lineCount: 1,
          score: 10,
          reasons: ['ui_surface'],
          reasonDetails: ['test'],
          summary: 'UI surface',
          symbols: [],
        },
      ],
    });
    expect(plan).toEqual([
      'Resolve intent, scope, non-goals, assumptions, and risk',
      'Ground the plan in `components/code-space/AgentPanel.tsx`',
      'Gather enough surrounding evidence to make the plan concrete',
      'Write a human-reviewable implementation plan artifact',
      'Define the validation checks the implementer should run',
    ]);

    const questions = await buildClarifyingQuestions('comprehensively improve the agent planning and Build button workflow', ['feature_build'], {
      filesConsidered: 4,
      terms: [],
      selectedFiles: ['components/code-space/AgentPanel.tsx', 'app/api/code-space/agent/route.ts'],
      omittedRelevantCandidates: [],
      dependencyEdges: [],
      testCandidates: [],
      validationCandidates: [],
      missingContextWarnings: [],
      confidence: 'medium',
      files: [
        {
          path: 'components/code-space/AgentPanel.tsx',
          content: '',
          truncated: false,
          mode: 'full',
          lineCount: 1,
          score: 10,
          reasons: ['ui_surface'],
          reasonDetails: ['test'],
          summary: 'UI surface',
          symbols: [],
        },
        {
          path: 'app/api/code-space/agent/route.ts',
          content: '',
          truncated: false,
          mode: 'full',
          lineCount: 1,
          score: 10,
          reasons: ['route_runtime_surface'],
          reasonDetails: ['test'],
          summary: 'API surface',
          symbols: [],
        },
      ],
    });
    expect(questions).toEqual([]);
  });

  it('returns no workflow outline when context has not been inspected yet', async () => {
    expect(await buildClarifyingQuestions('build a better planning workflow', ['feature_build'])).toEqual([]);
    expect(
      await buildClarifyingQuestions('build a better planning workflow', ['feature_build'], {
        filesConsidered: 12,
        terms: [],
        selectedFiles: [],
        omittedRelevantCandidates: [],
        dependencyEdges: [],
        testCandidates: [],
        validationCandidates: [],
        missingContextWarnings: [],
        confidence: 'low',
        files: [],
      }),
    ).toEqual([]);
  });

  it('expands context with local imports and importers so planning starts from code evidence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-space-context-'));
    try {
      await writeFile(path.join(root, 'feature.ts'), "import { helper } from './helper';\nexport function runFeature() { return helper(); }\n");
      await writeFile(path.join(root, 'helper.ts'), 'export function helper() { return "ok"; }\n');
      await writeFile(path.join(root, 'caller.ts'), "import { runFeature } from './feature';\nexport const value = runFeature();\n");

      const context = await collectProjectContext(root, 'change feature.ts runFeature behavior', [], []);
      const paths = context.files.map((file) => file.path);

      expect(paths).toContain('feature.ts');
      expect(paths).toContain('helper.ts');
      expect(paths).toContain('caller.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds Code mode prompts that preserve and expose the selected plan path', () => {
    const prompt = buildPlanImplementationPrompt('.agent/plans/session-123.md');

    expect(prompt).toContain('Build from the approved plan at .agent/plans/session-123.md.');
    expect(prompt).toContain('Read that plan artifact first');
    expect(extractBuildPlanPath(prompt)).toBe('.agent/plans/session-123.md');
  });

  it('keeps MCQ question text and option menus out of the plan artifact', () => {
    const content = buildStrategyDocument({
      projectName: 'demo',
      prompt: 'improve planning',
      context: {
        filesConsidered: 1,
        terms: [],
        selectedFiles: ['app/api/code-space/agent/route.ts'],
        omittedRelevantCandidates: [],
        dependencyEdges: [],
        testCandidates: [],
        validationCandidates: [],
        missingContextWarnings: [],
        confidence: 'medium',
        files: [
          {
            path: 'app/api/code-space/agent/route.ts',
            content: 'export function buildPlan() {}',
            truncated: false,
            mode: 'full',
            lineCount: 1,
            score: 10,
            reasons: ['route_runtime_surface'],
            reasonDetails: ['test'],
            summary: 'Agent route',
            symbols: ['buildPlan'],
          },
        ],
      },
      validation: {
        commands: [{ kind: 'test', command: 'npm run test', reason: 'Automated tests are available.' }],
        packageManager: 'npm',
      },
      codeMode: false,
      answers: [
        {
          question: 'Which boundary should this implementation stay within?',
          answer: 'Existing route',
        },
      ],
      workflowOutline: {
        intentSummary: 'Improve the plan workflow using inspected repository evidence.',
        planItems: ['Inspect the agent route', 'Use context to drive the outline'],
        clarifyingQuestions: [],
      },
    });

    expect(content).not.toMatch(/\bMCQ\s*\d+\s*:/i);
    expect(content).not.toMatch(/Which boundary should this implementation stay within/i);
    expect(content).not.toMatch(/^\s*[-*]\s*[A-E]\)\s+/im);
    expect(content).toContain('## Summary');
    expect(content).not.toContain('## Context Sufficiency Gate');
    expect(content).toContain('## Repository Evidence Reviewed');
    expect(content).toContain('## Validation Plan');
    expect(content).toContain('app/api/code-space/agent/route.ts');
    expect(content).toContain('npm run test');
  });

  it('summarizes plan completion from the actual plan artifact instead of a canned template', () => {
    const response = buildPlanCompletionResponse({
      projectName: 'demo',
      planPath: '.agent/plans/session-123.md',
      planContent: [
        '# Code Space Plan',
        '## Summary',
        'Keep the plan aligned with the actual repository evidence.',
        '## Key Changes',
        '- Update AgentPanel to show the live plan summary.',
        '- Derive the completion text from the artifact content.',
        '## Test Plans',
        '- cd backend && python -m compileall .',
        '- cd backend && python -m pytest',
      ].join('\n'),
      inspectedFiles: [
        { path: 'components/code-space/AgentPanel.tsx', summary: 'sidebar message surface' },
        { path: 'app/api/code-space/agent/route.ts', summary: 'agent response route' },
      ],
      validationCommands: [
        { command: 'cd backend && python -m compileall .', reason: 'Python syntax compilation is available.' },
        { command: 'cd backend && python -m pytest', reason: 'Python pytest validation appears available.' },
      ],
    });

    expect(response).toContain('Saved .agent/plans/session-123.md for demo.');
    expect(response).toContain('Plan focus: Keep the plan aligned with the actual repository evidence.; Update AgentPanel to show the live plan summary.');
    expect(response).toContain('Validation: `cd backend && python -m compileall .`; `cd backend && python -m pytest`.');
    expect(response).not.toContain('Plan ready for');
    expect(response).not.toContain('Use Build when you are ready for Code mode to implement it.');
  });

  it('summarizes code completion from patch details and validation results without a fixed done template', () => {
    const response = buildCodeCompletionResponse({
      projectName: 'demo',
      files: [
        { path: 'components/code-space/AgentPanel.tsx', explanation: 'wire live completion copy into the sidebar' },
        { path: 'app/api/code-space/agent/route.ts', explanation: 'route plan/code summaries through shared helpers' },
      ],
      validationRuns: [
        { command: 'npm test', status: 'failed', output: '1 failing test' },
        { command: 'npm run lint', status: 'passed', output: '' },
      ],
      summary: 'Refined the sidebar completion message so it reflects the actual patch.',
      checkpointRef: 'snapshot:abc123',
    });

    expect(response).toContain('Refined the sidebar completion message so it reflects the actual patch.');
    expect(response).toContain('Updated 2 files in demo: `components/code-space/AgentPanel.tsx` and `app/api/code-space/agent/route.ts`.');
    expect(response).toContain('Validation still needs attention: `npm test`.');
    expect(response).toContain('Checkpoint created before the edit.');
    expect(response).not.toContain('Done — I updated');
  });
});

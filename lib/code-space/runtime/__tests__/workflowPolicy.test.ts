import { describe, expect, it } from 'vitest';
import type { ContextGraphResult } from '../contextGraphEngine';
import {
  assessContextSufficiency,
  buildRecallDirective,
  buildFallbackClarifyingQuestions,
  buildWorkflowKernelPrompt,
  formatWorkflowDodMarkdown,
} from '../workflowPolicy';

function context(overrides: Partial<ContextGraphResult> = {}): ContextGraphResult {
  return {
    filesConsidered: 4,
    files: [],
    selectedFiles: [],
    omittedRelevantCandidates: [],
    terms: [],
    dependencyEdges: [],
    testCandidates: [],
    validationCandidates: [],
    missingContextWarnings: [],
    confidence: 'low',
    ...overrides,
  };
}

describe('v3.2 workflow policy', () => {
  it('blocks code work when no repository evidence is readable', () => {
    const report = assessContextSufficiency({
      mode: 'code',
      prompt: 'fix the Code Space agent workflow',
      context: context(),
      validationCommands: [],
    });

    expect(report.status).toBe('needs_review');
    expect(report.blockers.join('\n')).toContain('No readable repository files');
  });

  it('marks a grounded implementation evidence pack as ready', () => {
    const report = assessContextSufficiency({
      mode: 'code',
      prompt: 'fix the Code Space agent workflow',
      validationCommands: [{ kind: 'test', command: 'npm', args: ['test'], reason: 'unit tests' }],
      context: context({
        confidence: 'high',
        selectedFiles: [
          'components/code-space/AgentPanel.tsx',
          'lib/code-space/runtime/agentRuntime.ts',
          'lib/code-space/runtime/workflowPolicy.ts',
          'lib/code-space/runtime/__tests__/workflowPolicy.test.ts',
          'package.json',
          'README.md',
          'app/api/code-space/agent/route.ts',
          'lib/code-space/runtime/validationRunner.ts',
        ],
        files: [
          { path: 'components/code-space/AgentPanel.tsx', content: '', truncated: false, mode: 'full', lineCount: 1, score: 90, reasons: ['ui_surface'], reasonDetails: [], summary: 'UI', symbols: [] },
          { path: 'lib/code-space/runtime/agentRuntime.ts', content: '', truncated: false, mode: 'full', lineCount: 1, score: 90, reasons: ['route_runtime_surface', 'direct_import_dependency'], reasonDetails: [], summary: 'Runtime', symbols: [] },
          { path: 'lib/code-space/runtime/workflowPolicy.ts', content: '', truncated: false, mode: 'full', lineCount: 1, score: 90, reasons: ['route_runtime_surface'], reasonDetails: [], summary: 'Policy', symbols: [] },
          { path: 'lib/code-space/runtime/__tests__/workflowPolicy.test.ts', content: '', truncated: false, mode: 'full', lineCount: 1, score: 90, reasons: ['test_surface'], reasonDetails: [], summary: 'Test', symbols: [] },
          { path: 'package.json', content: '', truncated: false, mode: 'full', lineCount: 1, score: 80, reasons: ['package_config'], reasonDetails: [], summary: 'Config', symbols: [] },
          { path: 'README.md', content: '', truncated: false, mode: 'full', lineCount: 1, score: 50, reasons: ['documentation_spec'], reasonDetails: [], summary: 'Docs', symbols: [] },
          { path: 'app/api/code-space/agent/route.ts', content: '', truncated: false, mode: 'full', lineCount: 1, score: 60, reasons: ['reverse_importer'], reasonDetails: [], summary: 'Route', symbols: [] },
          { path: 'lib/code-space/runtime/validationRunner.ts', content: '', truncated: false, mode: 'full', lineCount: 1, score: 60, reasons: ['route_runtime_surface'], reasonDetails: [], summary: 'Validation', symbols: [] },
        ],
      }),
    });

    expect(report.status).toBe('ready');
    expect(report.score).toBeGreaterThanOrEqual(60);
  });

  it('provides reusable prompt and DoD text for planning and code loops', () => {
    expect(buildWorkflowKernelPrompt('plan')).toContain('v3.2 workflow kernel');
    expect(formatWorkflowDodMarkdown()).toContain('Repository rules');
    expect(buildRecallDirective({ status: 'needs_recall', confidence: 'medium', score: 42, blockers: [], warnings: ['missing tests'], requiredEvidence: ['tests'], recommendedRecall: ['example.test.ts'] })).toContain('example.test.ts');
  });

  it('asks the user to choose one implementation approach before planning', () => {
    const questions = buildFallbackClarifyingQuestions('run-1');
    expect(questions[0]?.question).toMatch(/implementation approach/i);
    expect(questions[0]?.choices).toContain('Minimal owner change');
    expect(questions[0]?.choices).toContain('Coordinated related changes');
  });
});

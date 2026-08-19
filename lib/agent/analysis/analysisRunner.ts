import { adaptiveMap } from './adaptiveQueue';
import {
  assignSummaryDepths,
  budgetCounters,
  buildAnalysisDigest,
  createAnalysisBudget,
  formatDepth,
  isAnalyzedDepth,
  type AnalysisBudget,
  type AnalysisDigest,
  type AnalyzedSummary,
  type SummaryAssignment,
} from './analysisBudget';
import type { DiagramKind, Relevance } from './classifier';
import type { ImportGraph } from '../repo/importGraph';
import type { RepoContextDigest } from '../repo/repoContext';
import { readRepoFile, type RepoMap } from '../repo/repoScanner';
import { createSignatureSummary } from './sourceProfiler';
import { summarizeFile } from './summarizer';
import type { ProviderSession, RetryListener } from '../providers';
import type { SseEvent } from '../../util/stream';

export interface RepoAnalysisResult {
  budget: AnalysisBudget;
  assignments: SummaryAssignment[];
  summaries: AnalyzedSummary[];
  digest: AnalysisDigest;
}

interface AnalyzeRelevantFilesInput {
  repoMap: RepoMap;
  relevant: Relevance[];
  kind: DiagramKind;
  focus: string;
  importGraph: ImportGraph;
  repoContext?: RepoContextDigest;
  session: ProviderSession;
  signal?: AbortSignal;
  send: (ev: SseEvent) => void;
  onRetry: (stage: string) => RetryListener;
}

function dependencyContext(filePath: string, importGraph: ImportGraph, repoContext?: RepoContextDigest): string {
  const inbound = importGraph.edges
    .filter((edge) => !edge.external && edge.to === filePath)
    .slice(0, 8)
    .map((edge) => edge.from);
  const outbound = (importGraph.files.get(filePath) ?? []).slice(0, 12);
  const cluster = repoContext?.folderClusters.find((item) => filePath === item.folder || filePath.startsWith(`${item.folder}/`));
  const central = repoContext?.centralFiles.find((item) => item.path === filePath);
  return [
    `Inbound imports: ${inbound.join(', ') || 'none'}`,
    `Outbound imports: ${outbound.join(', ') || 'none'}`,
    cluster ? `Folder cluster: ${cluster.folder}, files=${cluster.fileCount}, in=${cluster.importsIn}, out=${cluster.importsOut}` : '',
    central ? `Centrality: incoming=${central.incoming}, outgoing=${central.outgoing}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function summarizeAssignment(
  input: AnalyzeRelevantFilesInput,
  budget: AnalysisBudget,
  assignment: SummaryAssignment,
  onRetry: RetryListener,
): Promise<AnalyzedSummary | null> {
  if (!isAnalyzedDepth(assignment.depth)) return null;
  const file = assignment.relevance.file;

  if (assignment.depth === 'signature') {
    const text = await readRepoFile(input.repoMap.root, file.path, 48_000);
    return {
      path: file.path,
      depth: assignment.depth,
      summary: createSignatureSummary(file, text, input.importGraph, input.repoContext),
    };
  }

  const text = await readRepoFile(input.repoMap.root, file.path, Math.max(file.bytes, 64_000));
  const summary = await summarizeFile(input.session, file.path, text, {
    signal: input.signal,
    onRetry,
    chunkTokens: budget.chunkTokens,
    analysisMode: assignment.depth,
    dependencyContext: dependencyContext(file.path, input.importGraph, input.repoContext),
  });
  return { path: file.path, depth: assignment.depth, summary };
}

export async function analyzeRelevantFiles(input: AnalyzeRelevantFilesInput): Promise<RepoAnalysisResult> {
  const budget = createAnalysisBudget(input.relevant.length);
  const assignments = assignSummaryDepths(input.relevant, budget, input.repoMap, input.kind, input.repoContext);
  const counters = budgetCounters(budget, assignments);
  input.send({
    type: 'log',
    stage: 'summarize',
    level: 'info',
    message: `${budget.label}: ${budget.modeNote}`,
  });
  input.send({
    type: 'stage',
    stage: 'summarize',
    status: 'start',
    message: `Analyzing modules with ${budget.label}`,
    counters,
  });

  const planned = assignments.filter((assignment) => isAnalyzedDepth(assignment.depth));
  let done = 0;
  const summaries = (
    await adaptiveMap(
      planned,
      {
        initialConcurrency: budget.initialConcurrency,
        maxConcurrency: budget.maxConcurrency,
        minConcurrency: 2,
        signal: input.signal,
        onEvent: (event) => {
          if (event.kind === 'rate-limit') {
            input.send({
              type: 'log',
              stage: 'summarize',
              level: 'warn',
              message: `Rate limit detected; reducing summarizer concurrency to ${event.concurrency} and cooling down ${Math.round((event.delayMs ?? 0) / 1000)}s`,
            });
          } else {
            input.send({
              type: 'log',
              stage: 'summarize',
              level: 'info',
              message: `Summarizer concurrency recovered to ${event.concurrency}`,
            });
          }
        },
      },
      async (assignment, _index, control) => {
        if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const retry = input.onRetry(`summarize:${formatDepth(assignment.depth)}`);
        const result = await summarizeAssignment(input, budget, assignment, (notice) => {
          retry(notice);
          control.onRetry(notice);
        });
        done++;
        input.send({
          type: 'stage',
          stage: 'summarize',
          status: 'progress',
          percent: planned.length ? Math.round((done / planned.length) * 100) : 100,
          counters: { ...counters, done, total: planned.length },
        });
        return result;
      },
    )
  ).filter((summary): summary is AnalyzedSummary => Boolean(summary));

  const digest = buildAnalysisDigest({
    budget,
    repoMap: input.repoMap,
    importGraph: input.importGraph,
    repoContext: input.repoContext,
    assignments,
    summaries,
  });

  input.send({
    type: 'stage',
    stage: 'summarize',
    status: 'done',
    message: `Analyzed ${summaries.length} files, rolled up ${digest.moduleRollups.length} modules`,
    counters: {
      ...counters,
      done: summaries.length,
      total: planned.length,
      rollups: digest.moduleRollups.length,
      bypassed: digest.bypassedFiles,
    },
  });

  return { budget, assignments, summaries, digest };
}

export function quickAnalysisDigest(params: {
  repoMap: RepoMap;
  relevant: Relevance[];
  kind: DiagramKind;
  importGraph: ImportGraph;
  repoContext?: RepoContextDigest;
}): RepoAnalysisResult {
  const budget = createAnalysisBudget(params.relevant.length);
  const assignments = params.relevant.map((relevance) => ({ relevance, depth: 'structural' as const }));
  const digest = buildAnalysisDigest({
    budget,
    repoMap: params.repoMap,
    importGraph: params.importGraph,
    repoContext: params.repoContext,
    assignments,
    summaries: [],
  });
  return { budget, assignments, summaries: [], digest };
}

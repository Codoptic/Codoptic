/**
 * Single-diagram pipeline (Agentic Explorer mode):
 *   1. Validate provider key
 *   2. Scan repo
 *   3. Classify files (heuristic)
 *   4. Read docs + extract import graph (deep context)
 *   5. Read & chunk relevant files
 *   6. Summarize (parallel, cached by content hash)
 *   7. Identify subsystems (heuristic + import-graph clusters)
 *   8. Plan diagram with all priors
 *   9. Compile plan → DSL
 *  10. Validate + repair
 */

import { AGENT_FILE_ALLOWLIST } from '../repo/repoScanner';
import { classifyRelevance, type DiagramKind } from '../analysis/classifier';
import { generateTechnicalDocumentation } from '../docs/docGenerator';
import { instructionFailureMarkdown, withInstructionTimeout } from './instructionTimeout';
import { generatePlan } from './planner';
import { planToDsl } from './dslCompiler';
import { tryRepair } from './repair';
import { compile } from '../../dsl/compiler';
import { validateWithRetry, type ProviderSession } from '../providers';
import type { SseEvent } from '../../util/stream';
import { extractImportGraph, topClusters } from '../repo/importGraph';
import { readDocPriors } from '../docs/docReader';
import { buildRepoContext } from '../repo/repoContext';
import { scanResolvedRepoSource, type ResolvedRepoSource } from '../repo/repoSource';
import { analyzeRelevantFiles, quickAnalysisDigest } from '../analysis/analysisRunner';

export interface PipelineInput {
  repoSource: ResolvedRepoSource;
  session: ProviderSession;
  kind: DiagramKind;
  focus: string;
  topK?: number;
  ignoredFolders?: string[];
  /**
   * Quick Mode: skip per-file content reads and LLM summarization. The planner
   * runs on the deterministic structural digest only (folder clusters, import
   * graph, central files, routes, exports, env vars, docs). Much faster and
   * cheaper, but produces a more skeletal diagram.
   */
  quickMode?: boolean;
  maxMode?: boolean;
  instructionMode?: boolean;
  signal?: AbortSignal;
}

export function validateRenderableDsl(dsl: string): string | null {
  const diagram = compile(dsl);
  const errors = diagram.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    return `Generated DSL is still invalid after repair: ${errors[0]?.message ?? 'syntax error'}`;
  }
  if (diagram.nodes.length + diagram.groups.length === 0) {
    return 'Generated DSL did not contain any nodes or groups.';
  }
  const hasMeaningfulLabel = [...diagram.nodes, ...diagram.groups].some((item) =>
    /[A-Za-z0-9]/.test(item.label ?? item.name),
  );
  if (!hasMeaningfulLabel) {
    return 'Generated DSL did not contain any renderable node or group labels.';
  }
  return null;
}

export async function runPipeline(
  input: PipelineInput,
  send: (ev: SseEvent) => void,
): Promise<{ dsl: string }> {
  const onRetry = (stage: string) => (notice: { attempt: number; delayMs: number; reason: string }) => {
    send({ type: 'retry', stage, attempt: notice.attempt, delayMs: notice.delayMs, reason: notice.reason });
  };

  try {
    // 1. Validate
    send({ type: 'stage', stage: 'validate', status: 'start', message: 'Checking provider credentials…' });
    const v = await validateWithRetry(input.session, {
      signal: input.signal,
      onRetry: onRetry('validate'),
    });
    if (!v.ok) {
      send({ type: 'error', stage: 'validate', message: v.error ?? 'Provider validation failed' });
      send({ type: 'done' });
      return { dsl: '' };
    }
    send({ type: 'stage', stage: 'validate', status: 'done', message: 'Provider ready' });

    // 2. Scan
    send({ type: 'stage', stage: 'scan', status: 'start', message: 'Scanning repository…' });
    const repoMap = await scanResolvedRepoSource(input.repoSource, {
      allowlist: AGENT_FILE_ALLOWLIST,
      ignoredFolders: input.ignoredFolders,
    });
    send({
      type: 'stage',
      stage: 'scan',
      status: 'done',
      message: `Found ${repoMap.fileCount} files (${Math.round(repoMap.totalBytes / 1024)} KB) — stack: ${repoMap.likelyStack.join(', ') || 'unknown'}`,
      counters: { files: repoMap.fileCount, bytes: repoMap.totalBytes },
    });

    // 3. Classify
    send({ type: 'stage', stage: 'classify', status: 'start', message: 'Scoring relevance…' });
    const relevantCap = input.maxMode ? repoMap.files.length : (input.topK ?? 60);
    const relevant = classifyRelevance(repoMap, input.kind, input.focus, relevantCap);
    send({
      type: 'stage',
      stage: 'classify',
      status: 'done',
      message: input.maxMode
        ? `MAX mode: selected all ${relevant.length} relevant files for tiered analysis`
        : `Selected ${relevant.length} files for deep analysis`,
      counters: { selected: relevant.length },
    });

    // 4. Deep context: docs + import graph
    send({ type: 'stage', stage: 'context', status: 'start', message: 'Reading docs + import graph…' });
    const [docs, importGraph] = await Promise.all([
      readDocPriors(repoMap),
      extractImportGraph(repoMap.root, repoMap.files.map((f) => f.path), { maxFiles: 700 }),
    ]);
    const clusters = topClusters(importGraph, 12);
    const repoContext = await buildRepoContext(repoMap, importGraph);
    send({
      type: 'stage',
      stage: 'context',
      status: 'done',
      message: `${docs.length} docs · ${importGraph.files.size} files analyzed · ${importGraph.externals.size} unique externals · ${repoContext.folderClusters.length} deep clusters`,
      counters: {
        docs: docs.length,
        importEdges: importGraph.edges.length,
        externals: importGraph.externals.size,
        clusters: repoContext.folderClusters.length,
      },
    });

    // 5 + 6. Summarize relevant files in adaptive parallel tiers — skipped in Quick Mode.
    let analysis = quickAnalysisDigest({
      repoMap,
      relevant,
      kind: input.kind,
      importGraph,
      repoContext,
    });
    if (input.quickMode) {
      send({
        type: 'stage',
        stage: 'summarize',
        status: 'done',
        message: 'Quick Mode: skipped per-file summarization — planning from structural digest only',
        counters: {
          tier: analysis.budget.tier,
          done: 0,
          total: relevant.length,
          rollups: analysis.digest.moduleRollups.length,
        },
      });
    } else {
      analysis = await analyzeRelevantFiles({
        repoMap,
        relevant,
        kind: input.kind,
        focus: input.focus,
        importGraph,
        repoContext,
        session: input.session,
        signal: input.signal,
        send,
        onRetry,
      });
    }
    const summaries = analysis.summaries.map((item) => ({ path: item.path, summary: item.summary }));

    // 7. Subsystem catalog (heuristic now)
    send({ type: 'stage', stage: 'subsystem', status: 'start', message: 'Discovering subsystems…' });
    const subsystemCount = input.quickMode
      ? clusters.length
      : new Set(summaries.map((s) => s.summary.layer)).size;
    send({
      type: 'stage',
      stage: 'subsystem',
      status: 'done',
      message: input.quickMode
        ? `Quick Mode: ${clusters.length} folder clusters used as subsystem hints`
        : `Identified ${subsystemCount} subsystem layers + ${clusters.length} folder clusters`,
      counters: { layers: subsystemCount, clusters: clusters.length },
    });

    // 8. Plan
    send({
      type: 'stage',
      stage: 'plan',
      status: 'start',
      message: input.quickMode
        ? 'Generating diagram plan from structural digest…'
        : 'Generating diagram plan…',
    });
    const plan = await generatePlan(
      input.session,
      {
        repoMap,
        summaries,
        imports: importGraph,
        docs,
        repoContext,
        analysisDigest: analysis.digest,
        kind: input.kind,
        focus: input.focus,
        quickMode: input.quickMode,
      },
      { signal: input.signal, onRetry: onRetry('plan') },
    );
    send({
      type: 'stage',
      stage: 'plan',
      status: 'done',
      message: `Plan: ${plan.groups.length} groups, ${plan.nodes.length} nodes, ${plan.edges.length} edges`,
    });

    // 9. Compile to DSL
    send({ type: 'stage', stage: 'compile', status: 'start', message: 'Compiling DSL…' });
    let dsl = planToDsl(plan);
    send({ type: 'stage', stage: 'compile', status: 'done', message: 'DSL compiled' });

    // 10. Validate + repair
    send({ type: 'stage', stage: 'validate-dsl', status: 'start', message: 'Validating syntax…' });
    const initial = compile(dsl);
    const initialErrors = initial.diagnostics.filter((d) => d.severity === 'error').length;
    if (initialErrors > 0) {
      send({
        type: 'log',
        stage: 'validate-dsl',
        level: 'warn',
        message: `${initialErrors} syntax errors — attempting repair`,
      });
      const repaired = await tryRepair(input.session, dsl, {
        maxAttempts: 2,
        signal: input.signal,
        onRetry: onRetry('repair'),
      });
      dsl = repaired.dsl;
      send({
        type: 'log',
        stage: 'validate-dsl',
        level: repaired.errors === 0 ? 'info' : 'warn',
        message: repaired.errors === 0 ? 'Repaired successfully' : `${repaired.errors} errors remain after repair`,
      });
    }
    const finalError = validateRenderableDsl(dsl);
    if (finalError) {
      // Root Cause vs Logic: malformed repair output such as "/" was treated as a successful result and saved into project tabs. Stop before emitting `result` so the UI reports failure instead of persisting an unrenderable diagram.
      send({ type: 'error', stage: 'validate-dsl', message: finalError });
      send({ type: 'done' });
      return { dsl: '' };
    }
    send({ type: 'stage', stage: 'validate-dsl', status: 'done', message: 'Validation complete' });

    let instructionMarkdown: string | undefined;
    if (input.instructionMode) {
      // Motivation vs Logic: the old implementation passed only 7 sparse text lines
      // (plan title, top-8 groups, 16 nodes, 16 edges) to generateInstructionGuide,
      // discarding the full per-file FileSummary array, import graph, repo context,
      // and analysis digest that the pipeline had already collected. The new
      // generateTechnicalDocumentation call feeds ALL those pre-computed signals,
      // producing documentation at source-code depth rather than a generic build guide.
      const isLargeRepo = summaries.length > 80;
      send({
        type: 'stage',
        stage: 'instruction',
        status: 'start',
        message: isLargeRepo
          ? `Writing deep technical reference (${summaries.length} files, two-pass mode)…`
          : `Writing deep technical reference (${summaries.length} files)…`,
      });
      try {
        instructionMarkdown = await withInstructionTimeout(input.signal, (signal) =>
          generateTechnicalDocumentation(
            input.session,
            {
              repoMap,
              summaries,
              importGraph,
              docs,
              repoContext,
              analysisDigest: analysis.digest,
              diagramStyle: 'single',
              diagramTitle: plan.title,
              focus: input.focus,
              planGroups: plan.groups.map((g) => ({ name: g.name, children: g.children })),
            },
            {
              signal,
              onRetry: onRetry('instruction'),
              onProgress: (message, counters) => {
                send({ type: 'log', stage: 'instruction', level: 'info', message });
                if (counters) send({ type: 'stage', stage: 'instruction', status: 'progress', message, counters });
              },
            },
          ),
        );
      } catch (err) {
        if (input.signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'log', stage: 'instruction', level: 'warn', message });
        // Root Cause vs Logic: any Document Mode failure used to be replaced with the
        // fixed 180s timeout stub, which hid real provider/generation errors after the
        // stage budget was removed. Persist the actual failure while keeping the diagram.
        instructionMarkdown = instructionFailureMarkdown(message);
      }
      send({
        type: 'stage',
        stage: 'instruction',
        status: 'done',
        message: `Deep technical reference ready (${Math.round((instructionMarkdown?.length ?? 0) / 1024)} KB)`,
      });
    }

    send({ type: 'result', dsl, instructionMarkdown });
    send({ type: 'done' });
    return { dsl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'error', stage: 'pipeline', message });
    send({ type: 'done' });
    return { dsl: '' };
  }
}

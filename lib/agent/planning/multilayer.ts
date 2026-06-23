/**
 * Multi-Layer pipeline.
 *
 * Produces:
 *   1. One **overview** diagram: layers as top-level groups, with each
 *      group's most-important components shown inline; cross-layer edges
 *      drawn between layers.
 *   2. One **sub-diagram per layer**: focused deep dive into that layer's
 *      internals, with the immediate boundary nodes from neighboring
 *      layers shown as dashed pass-throughs.
 *
 * Reuses the same scan / docs / import-graph / summarize stages as the
 * single-pipeline mode, then calls `identifyLayers` once and `generatePlan`
 * once per layer (concurrently with p-limit(2)).
 */

import pLimit from 'p-limit';
import { AGENT_FILE_ALLOWLIST } from '../repo/repoScanner';
import { classifyRelevance } from '../analysis/classifier';
import { generatePlan, identifyLayers, type LayerCatalog } from './planner';
import { planToDsl } from './dslCompiler';
import { tryRepair } from './repair';
import { compile } from '../../dsl/compiler';
import { validateWithRetry, type ProviderSession } from '../providers';
import { generateTechnicalDocumentation } from '../docs/docGenerator';
import { instructionTimeoutMarkdown, withInstructionTimeout } from './instructionTimeout';
import type { SseEvent } from '../../util/stream';
import { extractImportGraph } from '../repo/importGraph';
import { readDocPriors } from '../docs/docReader';
import { buildRepoContext, selectLayerContextSummaries } from '../repo/repoContext';
import { scanResolvedRepoSource, type ResolvedRepoSource } from '../repo/repoSource';
import type { LayerDiagram, MultiLayerOutput } from '../../state/store';
import { analyzeRelevantFiles, quickAnalysisDigest } from '../analysis/analysisRunner';
import { focusAnalysisDigest } from '../analysis/analysisBudget';

export interface MultiLayerInput {
  repoSource: ResolvedRepoSource;
  session: ProviderSession;
  focus: string;
  topK?: number;
  ignoredFolders?: string[];
  /** See PipelineInput.quickMode — skips per-file summarization for the layered pipeline too. */
  quickMode?: boolean;
  /** MAX mode removes the default relevance cap so the layered planner can consider every file. */
  maxMode?: boolean;
  instructionMode?: boolean;
  signal?: AbortSignal;
}

function edgeOp(kind: LayerCatalog['cross_layer_edges'][number]['kind']): string {
  return kind === 'fwd' ? '>' : kind === 'bwd' ? '<' : kind === 'bi' ? '<>' : kind === 'dashed' ? '--' : '=>';
}

function sanitizeDslName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\[\]{}:,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 56);
  return cleaned || fallback;
}

function uniqueName(base: string, used: Set<string>): string {
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} ${i}`;
    i++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function overviewDslFromCatalog(catalog: LayerCatalog): string {
  const lines: string[] = ['// Overview - high-level layered architecture', ''];
  const layerNames = new Map<string, string>();
  const usedLayerNames = new Set<string>();
  for (const layer of catalog.layers) {
    layerNames.set(layer.name, uniqueName(sanitizeDslName(layer.name, 'Layer'), usedLayerNames));
  }

  for (const l of catalog.layers) {
    const layerName = layerNames.get(l.name) ?? sanitizeDslName(l.name, 'Layer');
    lines.push(`${layerName} [color: ${l.color}, icon: ${l.icon}] {`);
    const usedSurfaceNames = new Set<string>();
    const surfaceSources = (l.representative_files.length ? l.representative_files : l.member_files)
      .slice(0, 6)
      .map((p) => {
        const stripped = p.replace(/^.*\//, '').replace(/\.(ts|tsx|js|jsx|py|go|rs|java)$/, '');
        const title = stripped
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
          .slice(0, 40);
        return uniqueName(sanitizeDslName(title, 'Component'), usedSurfaceNames);
      });
    for (const s of surfaceSources) {
      lines.push(`  ${s} [color: ${l.color}, icon: circle]`);
    }
    lines.push('}');
    lines.push('');
  }
  lines.push('// ==== Cross-layer flow ====');
  for (const e of catalog.cross_layer_edges) {
    const source = layerNames.get(e.source) ?? layerNames.get(catalog.layers.find((l) => l.name.toLowerCase() === e.source.toLowerCase())?.name ?? '');
    const target = layerNames.get(e.target) ?? layerNames.get(catalog.layers.find((l) => l.name.toLowerCase() === e.target.toLowerCase())?.name ?? '');
    if (!source || !target) continue;
    const label = e.label ? `: ${sanitizeDslName(e.label, 'flow')}` : '';
    lines.push(`${source} ${edgeOp(e.kind)} ${target}${label}`);
  }
  return lines.join('\n');
}

async function validateDsl(
  session: ProviderSession,
  dsl: string,
  send: (ev: SseEvent) => void,
  stage: string,
  onRetry: (stage: string) => (notice: { attempt: number; delayMs: number; reason: string }) => void,
  signal?: AbortSignal,
): Promise<string> {
  const compiled = compile(dsl);
  const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
  const warnings = compiled.diagnostics.filter((d) => d.severity === 'warning');
  if (errors.length === 0) {
    if (warnings.length) {
      send({ type: 'log', stage, level: 'warn', message: `${warnings.length} DSL warnings remain` });
    }
    return dsl;
  }

  send({ type: 'log', stage, level: 'warn', message: `${errors.length} syntax errors - attempting repair` });
  const repaired = await tryRepair(session, dsl, {
    signal,
    onRetry: onRetry(`${stage}-repair`),
  });
  const final = compile(repaired.dsl);
  const remainingErrors = final.diagnostics.filter((d) => d.severity === 'error').length;
  const remainingWarnings = final.diagnostics.filter((d) => d.severity === 'warning').length;
  if (remainingErrors || remainingWarnings) {
    send({
      type: 'log',
      stage,
      level: remainingErrors ? 'error' : 'warn',
      message: `${remainingErrors} errors and ${remainingWarnings} warnings remain after repair`,
    });
  }
  return repaired.dsl;
}

function fallbackLayerDsl(layer: LayerCatalog['layers'][number]): string {
  const safeName = sanitizeDslName(layer.name, 'Layer');
  const lines = [`// ${safeName} - fallback layer diagram`, '', `${safeName} [color: ${layer.color}, icon: ${layer.icon}] {`];
  const used = new Set<string>();
  for (const filePath of (layer.representative_files.length ? layer.representative_files : layer.member_files).slice(0, 10)) {
    const base = filePath.replace(/^.*\//, '').replace(/\.(ts|tsx|js|jsx|py|go|rs|java)$/, '');
    lines.push(`  ${uniqueName(sanitizeDslName(base.replace(/[-_]/g, ' '), 'Component'), used)} [color: ${layer.color}, icon: file]`);
  }
  lines.push('}');
  return lines.join('\n');
}

export async function runMultiLayerPipeline(
  input: MultiLayerInput,
  send: (ev: SseEvent) => void,
): Promise<MultiLayerOutput | null> {
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
      return null;
    }
    send({ type: 'stage', stage: 'validate', status: 'done' });

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
      message: `${repoMap.fileCount} files · stack: ${repoMap.likelyStack.join(', ') || 'unknown'}`,
      counters: { files: repoMap.fileCount },
    });

    // 3. Classify
    send({ type: 'stage', stage: 'classify', status: 'start' });
    // Motivation vs Logic: the layered pipeline uses the same MAX semantics as Agentic Explorer,
    // so the toggle must lift the file-budget cap here rather than only changing the UI state.
    const relevantCap = input.maxMode ? repoMap.files.length : (input.topK ?? 80);
    const relevant = classifyRelevance(repoMap, 'architecture', input.focus, relevantCap);
    send({
      type: 'stage',
      stage: 'classify',
      status: 'done',
      message: input.maxMode ? `MAX mode: selected all ${relevant.length} relevant files for tiered analysis` : `${relevant.length} files selected`,
      counters: { selected: relevant.length },
    });

    // 4. Context
    send({ type: 'stage', stage: 'context', status: 'start', message: 'Reading docs + import graph…' });
    const [docs, importGraph] = await Promise.all([
      readDocPriors(repoMap),
      extractImportGraph(repoMap.root, repoMap.files.map((f) => f.path), { maxFiles: 800 }),
    ]);
    const repoContext = await buildRepoContext(repoMap, importGraph);
    send({
      type: 'stage',
      stage: 'context',
      status: 'done',
      message: `${docs.length} docs · ${importGraph.files.size} files mapped · ${importGraph.externals.size} externals · ${repoContext.folderClusters.length} deep clusters`,
      counters: { docs: docs.length, externals: importGraph.externals.size, clusters: repoContext.folderClusters.length },
    });

    // 5. Summarize with adaptive tiering — skipped in Quick Mode.
    let analysis = quickAnalysisDigest({
      repoMap,
      relevant,
      kind: 'architecture',
      importGraph,
      repoContext,
    });
    if (input.quickMode) {
      send({
        type: 'stage',
        stage: 'summarize',
        status: 'done',
        message: 'Quick Mode: skipped per-file summarization — layers will be inferred from structural digest only',
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
        kind: 'architecture',
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

    // 6. Identify layers
    send({ type: 'stage', stage: 'layers', status: 'start', message: 'Identifying architectural layers…' });
    const catalog = await identifyLayers(
      input.session,
      {
        repoMap,
        summaries,
        imports: importGraph,
        docs,
        repoContext,
        analysisDigest: analysis.digest,
        kind: 'architecture',
        focus: input.focus,
        quickMode: input.quickMode,
      },
      { signal: input.signal, onRetry: onRetry('layers') },
    );
    send({
      type: 'stage',
      stage: 'layers',
      status: 'done',
      message: `Identified ${catalog.layers.length} layers`,
      counters: { layers: catalog.layers.length },
    });

    // 7. Overview DSL (deterministic from catalog)
    send({ type: 'stage', stage: 'overview', status: 'start' });
    const overviewDsl = overviewDslFromCatalog(catalog);
    const finalOverviewDsl = await validateDsl(input.session, overviewDsl, send, 'overview', onRetry, input.signal);
    send({ type: 'stage', stage: 'overview', status: 'done', message: 'Overview compiled' });

    // 8. Per-layer plans (parallel)
    send({ type: 'stage', stage: 'sub-plans', status: 'start', message: 'Generating per-layer diagrams…' });
    const layerLimit = pLimit(2);
    const subLayers: LayerDiagram[] = await Promise.all(
      catalog.layers.map((layer) =>
        layerLimit(async () => {
          try {
            send({
              type: 'log',
              stage: 'sub-plans',
              level: 'info',
              message: `planning ${layer.name}`,
            });

            const used = input.quickMode
              ? []
              : selectLayerContextSummaries(layer, summaries, importGraph, { min: 8, max: 35 });
            const plan = await generatePlan(
              input.session,
              {
                repoMap,
                summaries: used,
                imports: importGraph,
                docs,
                repoContext,
                analysisDigest: focusAnalysisDigest(analysis.digest, layer.member_files),
                kind: 'architecture',
                focus: `Layer "${layer.name}" - ${layer.description}. Show internal structure plus one-hop boundary nodes (dashed). Boundary deps: ${layer.boundary_deps.join(', ') || 'none'}.`,
                layerFocus: layer.name,
                quickMode: input.quickMode,
              },
              { signal: input.signal, onRetry: onRetry('sub-plan') },
            );
            const dsl = await validateDsl(input.session, planToDsl(plan), send, 'sub-plans', onRetry, input.signal);
            send({
              type: 'log',
              stage: 'sub-plans',
              level: 'info',
              message: `${layer.name}: ${plan.groups.length} groups, ${plan.nodes.length} nodes`,
            });
            return { name: layer.name, description: layer.description, dsl };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            send({
              type: 'log',
              stage: 'sub-plans',
              level: 'error',
              message: `${layer.name} failed; using fallback diagram - ${message}`,
            });
            return { name: layer.name, description: layer.description, dsl: fallbackLayerDsl(layer) };
          }
        }),
      ),
    );
    send({
      type: 'stage',
      stage: 'sub-plans',
      status: 'done',
      message: `Generated ${subLayers.length} layer diagrams`,
    });

    const result: MultiLayerOutput = {
      overview: { name: 'Overview', description: 'High-level layered architecture', dsl: finalOverviewDsl },
      layers: subLayers,
      generatedAt: Date.now(),
    };

    let instructionMarkdown: string | undefined;
    if (input.instructionMode) {
      // Motivation vs Logic: the old implementation assembled only 4 text lines
      // (repo stack, overview name, layer summaries) and discarded the full
      // FileSummary array, import graph, and repo context that were already collected.
      // generateTechnicalDocumentation feeds ALL pre-computed signals — yielding
      // documentation at source-code depth, covering every module and data flow.
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
              diagramStyle: 'multi-layer',
              diagramTitle: `${result.overview.name} — ${result.overview.description}`,
              focus: input.focus,
              layers: result.layers.map((l) => ({ name: l.name, description: l.description })),
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
        instructionMarkdown = instructionTimeoutMarkdown();
      }
      send({
        type: 'stage',
        stage: 'instruction',
        status: 'done',
        message: `Deep technical reference ready (${Math.round((instructionMarkdown?.length ?? 0) / 1024)} KB)`,
      });
    }

    send({ type: 'result-multilayer', output: result, instructionMarkdown });
    send({ type: 'done' });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'error', stage: 'pipeline', message });
    send({ type: 'done' });
    return null;
  }
}

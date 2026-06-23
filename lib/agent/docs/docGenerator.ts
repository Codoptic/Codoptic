/**
 * Deep Technical Documentation Generator.
 *
 * Produces comprehensive, source-code-depth reference documentation from a full
 * repository analysis. This is the backbone of Document Mode (instructionMode
 * checkbox) in both Agentic Repo and Multi Layer pipelines.
 *
 * Unlike generateInstructionGuide() — which builds a shallow 4-section "build
 * guide" from a few plan fields — this module harnesses every pre-computed
 * analysis signal:
 *   - Per-file FileSummary objects  (role, category, layer, exports, surface,
 *     external_deps, side_effects, notes)
 *   - Import graph                  (static dependency edges, external packages)
 *   - RepoContextDigest             (folder clusters, central files, routes,
 *     env vars, export catalogs, cross-folder edges)
 *   - AnalysisDigest                (module rollups, tier, deep vs. signature)
 *   - DocPriors                     (README, CONTRIBUTING, doc file excerpts)
 *   - DiagramPlan / LayerCatalog    (architectural groupings the LLM derived)
 *
 * Generation strategy
 * -------------------
 * Small repos (≤ DOC_SPLIT_THRESHOLD analyzed files): a single comprehensive
 * LLM call produces the full reference in one pass.
 *
 * Large repos (> DOC_SPLIT_THRESHOLD files): two sequential LLM calls avoid
 * context-window exhaustion while preserving coverage:
 *
 *   Pass 1  — Architecture, API Contracts, Config, Security, Testing
 *             Context: repoContext, routes, env vars, docs, analysis digest,
 *             import graph sample, layer catalog or plan groups.
 *
 *   Pass 2  — Module-by-Module Reference
 *             Context: every FileSummary with exports, surface, side_effects,
 *             notes; keyed by file path.
 *
 * Both passes are concatenated into a single Markdown document separated by a
 * `---` section break. The caller (pipeline.ts / multilayer.ts) stores the
 * combined string as `instructionMarkdown` and streams it to the client.
 *
 * What makes this superior to generic documentation tools
 * --------------------------------------------------------
 * Generic tools (Cursor, Claude code review) read source files sequentially
 * without the cross-cutting analysis this pipeline has already performed. Here
 * we have:
 *   ① Layer assignments for every file (client / service / data / etc.)
 *   ② A full import graph showing who imports what, including external packages
 *   ③ A side-effects catalog per file (DB writes, HTTP calls, queue publishes)
 *   ④ Route-to-handler mapping extracted from the filesystem structure
 *   ⑤ Environment variable usage across files
 *   ⑥ Central/hub file rankings by import fan-in and fan-out
 *   ⑦ Cross-folder dependency boundaries (architectural seams)
 *   ⑧ Module rollups that aggregate file-level signals into subsystem views
 * Feeding all of this into the prompt produces documentation impossible to
 * generate from a simple file read.
 */

import pLimit from 'p-limit';
import type { ProviderSession, RetryListener } from '../providers';
import { chatWithRetry } from '../providers';
import type { FileSummary } from '../analysis/summarizer';
import type { RepoMap } from '../repo/repoScanner';
import type { ImportGraph } from '../repo/importGraph';
import type { DocPrior } from './docReader';
import type { RepoContextDigest } from '../repo/repoContext';
import type { AnalysisDigest } from '../analysis/analysisBudget';

// =========================================================================
// Public interface
// =========================================================================

export interface DocGenInput {
  /** Full repo map produced by scanResolvedRepoSource */
  repoMap: RepoMap;
  /** Per-file LLM summaries from analyzeRelevantFiles or quickAnalysisDigest */
  summaries: Array<{ path: string; summary: FileSummary }>;
  /** Static import dependency graph */
  importGraph: ImportGraph;
  /** README / doc file excerpts from readDocPriors */
  docs: DocPrior[];
  /** Structural repo context (clusters, routes, env vars, exports, etc.) */
  repoContext: RepoContextDigest;
  /** Optional: compact module-rollup digest from analysisBudget */
  analysisDigest?: AnalysisDigest;
  /** 'single' for Agentic Repo mode, 'multi-layer' for Multi Layer mode */
  diagramStyle: 'single' | 'multi-layer';
  /** Title of the generated diagram (from plan.title) */
  diagramTitle?: string;
  /** Layer catalog summary for multi-layer mode */
  layers?: Array<{ name: string; description: string }>;
  /** User focus prompt (optional) */
  focus?: string;
  /** Architectural groups from the diagram plan */
  planGroups?: Array<{ name: string; children: string[] }>;
}

export interface DocGenOptions {
  signal?: AbortSignal;
  onRetry?: RetryListener;
  onProgress?: (message: string, counters?: Record<string, number>) => void;
}

interface ModuleReferenceBatch {
  index: number;
  total: number;
  label: string;
  summaries: Array<{ path: string; summary: FileSummary }>;
}

// Large-repo threshold: above this, split architecture and module reference work.
const DOC_SPLIT_THRESHOLD = 80;
const MODULE_REF_BATCH_FILE_LIMIT = 24;
const MODULE_REF_BATCH_CHAR_LIMIT = 32_000;
const MODULE_REF_CONCURRENCY = 2;
const ARCHITECTURE_ANCHOR_CHAR_LIMIT = 6_000;

// =========================================================================
// System prompts
// =========================================================================

/**
 * Pass 1 (or single-pass for small repos): Architecture, API, Config, Security,
 * Testing, and high-level structure. This prompt does NOT produce per-file
 * module reference detail (that is Pass 2).
 */
const ARCHITECTURE_SYSTEM_PROMPT = `You are a senior software architect and technical writer producing authoritative reference documentation for a software repository. Your output must be so complete and technically precise that a developer who has never seen this codebase can understand, extend, debug, and operate every part of it without reading the source code.

Hard rules:
- Begin with the content immediately. No preamble, no meta-commentary.
- Be concrete and specific. Name every route path, every config key, every type field. Avoid generic placeholders.
- Use precise TypeScript-style type notation for schemas and interfaces (even for non-TS repos, use structural notation).
- Do not write filler sections ("Future Improvements", "Best Practices in General"). Every sentence must convey a fact a developer needs.
- When documenting an API endpoint, always include: HTTP method + path, request body schema (typed), response schema (typed), error codes and their meanings, and authentication requirements.
- When documenting configuration, always include: env var name, type, default value (or "required"), where it is consumed, and what breaks if it is missing.
- Use Markdown with ## for top-level sections and ### for sub-sections.
- Do not truncate or abbreviate. If something is important, document it fully.

Required sections for this pass:

## 1. Project Overview
- Identity: name, version, license, runtime, framework.
- What problem does this project solve? What is its core value proposition?
- Who are the intended users?

## 2. Technology Stack
- Every dependency: package name, version (if available), its role, and why it exists rather than an alternative.
- Group by: AI/LLM providers | Layout/Rendering | State Management | Testing | Editor | Styling | Build.

## 3. Directory & File Tree
- Annotated tree of every directory and file. Each file entry must include a one-line purpose note.
- Format each file as: \`path/to/file.ts\` — one-line purpose.

## 4. High-Level Architecture
- System boundary diagram (ASCII or descriptive text).
- Which components run client-side vs. server-side.
- Data flow: how does a user action propagate to rendered output?
- SSE/WebSocket patterns if present.
- Caching layers and their keys.

## 5. API Contracts
- Every HTTP endpoint: method, path, request body schema, response schema, error codes, authentication.
- For SSE streams: document every event type with its payload schema.

## 6. State Management
- Every Zustand store slice: its fields, actions, selectors.
- Persistence: what is stored, where (localStorage / IndexedDB), serialization format.
- How does multi-layer state differ from single-diagram state?

## 7. Configuration & Environment Variables
- Table: variable name | type | default | required | consumed by | effect if missing.

## 8. Security Model
- Input validation strategy (Zod schemas, path guards).
- Sensitive path blocking rules.
- API key handling: where keys live, how they are scoped, what is never persisted.
- File scanning allowlist/denylist rules.

## 9. Testing Infrastructure
- Every test file: what it covers, key edge cases tested.
- How to run unit tests, E2E tests, visual regression tests.
- Coverage gaps worth noting.

## 10. Module Cross-Reference Map
- For each major module: what it imports, what imports it, and why the dependency exists.`;

/**
 * Pass 2 (large repos only): Module-by-Module Reference.
 * This pass receives all per-file FileSummary data and produces a detailed
 * API reference for every analyzed file.
 */
const MODULE_REF_SYSTEM_PROMPT = `You are a senior software architect and technical writer producing an exhaustive module-by-module reference for a software repository.

Hard rules:
- Cover EVERY file listed in the input. Do not skip any, do not say "similar pattern as above".
- For each file produce: purpose, category/layer, every export (with type signature if inferable), key functions/classes with parameters and return types, internal design decisions, external dependencies used, and notable side effects.
- Use #### headings for each file (e.g. \`#### lib/agent/planner.ts\`).
- For exported functions: document parameters by name and type, return type, and what the function does.
- For exported interfaces/types: document every field with its type and semantics.
- For React components: document props interface, store subscriptions, store mutations, rendered structure.
- For API route handlers: document request body, response body, error handling, and which library function does the heavy lifting.
- Be concrete. If a function throws, say under what condition. If a field is optional, say what the default behavior is when absent.
- Group files by directory for readability.

Required structure:

## Module Reference

(For each directory, a ### heading. For each file inside it, a #### heading with the full relative path. Then cover all of the above.)`;

// =========================================================================
// Context builders
// =========================================================================

/** Formats doc priors as a compact readable block. */
function formatDocs(docs: DocPrior[], maxCharsEach = 3000): string {
  if (!docs.length) return '(no documentation found)';
  return docs
    .map((d) => `### ${d.path} (${d.kind})\n${d.excerpt.slice(0, maxCharsEach)}`)
    .join('\n\n');
}

/** Formats import graph as a compact dependency list. */
function formatImportGraph(graph: ImportGraph, maxLines = 80): string {
  const lines: string[] = [];
  for (const [from, tos] of graph.files) {
    if (!tos.length) continue;
    const slice = tos.slice(0, 6).join(', ');
    lines.push(`${from} → ${slice}${tos.length > 6 ? ` (+${tos.length - 6} more)` : ''}`);
    if (lines.length >= maxLines) break;
  }
  const extLines = [...graph.externals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([pkg, count]) => `${pkg} (×${count})`)
    .join(', ');
  return `External packages (by usage frequency): ${extLines || '(none)'}\n\nInternal import edges (sample):\n${lines.join('\n') || '(none)'}`;
}

/** Formats repo context digest as structured sections. */
function formatRepoContext(ctx: RepoContextDigest): string {
  const clusters = ctx.folderClusters
    .slice(0, 20)
    .map(
      (c) =>
        `- ${c.folder}: ${c.fileCount} files | in: ${c.importsIn} | out: ${c.importsOut}` +
        (c.representativeFiles.length ? ` | reps: ${c.representativeFiles.slice(0, 4).join(', ')}` : '') +
        (c.externalDeps.length ? ` | externals: ${c.externalDeps.slice(0, 5).join(', ')}` : ''),
    )
    .join('\n');

  const central = ctx.centralFiles
    .slice(0, 20)
    .map((f) => `- ${f.path} | fan-in: ${f.incoming} | fan-out: ${f.outgoing}` +
      (f.externalDeps.length ? ` | externals: ${f.externalDeps.slice(0, 4).join(', ')}` : ''))
    .join('\n');

  const routes = ctx.routes
    .slice(0, 40)
    .map((r) => `- ${r.methods.length ? r.methods.join('|') : 'ANY'} ${r.route} → ${r.path}`)
    .join('\n');

  const exports = ctx.exportsByFile
    .slice(0, 40)
    .map((e) => `- ${e.path}: ${e.symbols.slice(0, 12).join(', ')}`)
    .join('\n');

  const envVars = ctx.envVars
    .slice(0, 30)
    .map((e) => `- ${e.name}: used in ${e.files.slice(0, 5).join(', ')}`)
    .join('\n');

  const boundaries = ctx.crossFolderEdges
    .slice(0, 24)
    .map((e) => `- ${e.sourceFolder} → ${e.targetFolder}: ${e.edgeCount} edges` +
      (e.examples.length ? ` (e.g. ${e.examples[0]?.from} → ${e.examples[0]?.to})` : ''))
    .join('\n');

  return [
    `Stack: ${ctx.likelyStack.join(', ') || 'unknown'}`,
    `Dep hints: ${ctx.depHints.slice(0, 20).join(', ') || 'none'}`,
    '',
    'Folder Clusters (architectural boundaries):',
    clusters || '(none)',
    '',
    'Central Hub Files (high import fan-in/out):',
    central || '(none)',
    '',
    'API Routes:',
    routes || '(none)',
    '',
    'Exported Symbols by File:',
    exports || '(none)',
    '',
    'Environment Variables:',
    envVars || '(none)',
    '',
    'Cross-Folder Dependency Boundaries:',
    boundaries || '(none)',
    '',
    `Signals: manifests=[${ctx.signals.manifests.join(', ') || 'none'}]` +
    ` schemas=[${ctx.signals.schemas.slice(0, 5).join(', ') || 'none'}]` +
    ` infra=[${ctx.signals.infra.slice(0, 5).join(', ') || 'none'}]` +
    ` tests=${ctx.signals.tests}`,
  ].join('\n');
}

/** Formats the analysis digest module rollups. */
function formatAnalysisDigest(digest: AnalysisDigest | undefined): string {
  if (!digest) return '(not available)';
  const rollups = digest.moduleRollups
    .slice(0, 40)
    .map(
      (m) =>
        `- ${m.module}: ${m.fileCount} files (deep: ${m.deepFiles}, sig: ${m.signatureFiles})` +
        ` | layers: ${m.layers.join(', ') || 'other'}` +
        ` | surface: ${m.surface.slice(0, 8).join(', ') || 'none'}` +
        ` | externals: ${m.externalDeps.slice(0, 6).join(', ') || 'none'}`,
    )
    .join('\n');
  return [
    `${digest.label}: relevant=${digest.totalRelevantFiles} analyzed=${digest.analyzedFiles} deep=${digest.deepFiles} sig=${digest.signatureFiles}`,
    `Notes: ${digest.notes.join(' ')}`,
    `Global externals: ${digest.global.externals.slice(0, 30).join(', ') || 'none'}`,
    `Central files: ${digest.global.centralFiles.slice(0, 16).join('; ') || 'none'}`,
    '',
    'Module rollups:',
    rollups || '(none)',
  ].join('\n');
}

/**
 * Builds the detailed per-file summaries block for Pass 2 (module reference).
 * Groups files by their top-level directory for readability.
 */
function formatFileSummaries(
  summaries: Array<{ path: string; summary: FileSummary }>,
  limit = summaries.length,
): string {
  const sliced = summaries.slice(0, limit);
  // Group by top-level directory
  const byDir = new Map<string, typeof sliced>();
  for (const item of sliced) {
    const dir = (item.path.includes('/') ? item.path.split('/')[0] : undefined) ?? '(root)';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(item);
  }

  const sections: string[] = [];
  for (const [dir, files] of byDir) {
    sections.push(`### ${dir}/\n`);
    for (const { path, summary } of files) {
      const lines = [
        `#### ${path}`,
        `- **Role**: ${summary.role}`,
        `- **Category/Layer**: ${summary.category} / ${summary.layer}`,
      ];
      if (summary.exports.length) lines.push(`- **Exports**: ${summary.exports.join(', ')}`);
      if (summary.surface.length) lines.push(`- **Public surface** (functions/routes/tables): ${summary.surface.join(', ')}`);
      if (summary.external_deps.length) lines.push(`- **External deps**: ${summary.external_deps.join(', ')}`);
      if (summary.side_effects.length) lines.push(`- **Side effects**: ${summary.side_effects.join('; ')}`);
      if (summary.imports.length) lines.push(`- **Internal imports**: ${summary.imports.slice(0, 8).join(', ')}`);
      if (summary.notes) lines.push(`- **Notes**: ${summary.notes}`);
      sections.push(lines.join('\n'));
    }
  }

  const omitted = summaries.length - sliced.length;
  if (omitted > 0) {
    sections.push(`\n*(${omitted} additional files omitted from this pass — covered in the analysis digest above.)*`);
  }
  return sections.join('\n\n');
}

function describeSummaryDirs(summaries: Array<{ path: string; summary: FileSummary }>): string {
  const dirs = [...new Set(summaries.map((item) => (item.path.includes('/') ? item.path.split('/')[0] : '(root)')))];
  if (dirs.length <= 3) return dirs.join(', ');
  return `${dirs.slice(0, 3).join(', ')} +${dirs.length - 3} dirs`;
}

function splitModuleReferenceBatches(
  summaries: Array<{ path: string; summary: FileSummary }>,
): ModuleReferenceBatch[] {
  const batches: Array<Array<{ path: string; summary: FileSummary }>> = [];
  let current: Array<{ path: string; summary: FileSummary }> = [];
  let currentChars = 0;

  const flush = () => {
    if (!current.length) return;
    batches.push(current);
    current = [];
    currentChars = 0;
  };

  for (const item of summaries) {
    const itemChars = formatFileSummaries([item]).length;
    const wouldOverflow =
      current.length > 0 &&
      (current.length >= MODULE_REF_BATCH_FILE_LIMIT || currentChars + itemChars > MODULE_REF_BATCH_CHAR_LIMIT);
    if (wouldOverflow) flush();
    current.push(item);
    currentChars += itemChars;
  }
  flush();

  return batches.map((batch, i) => ({
    index: i + 1,
    total: batches.length,
    label: describeSummaryDirs(batch),
    summaries: batch,
  }));
}

function compactArchitectureAnchor(markdown: string): string {
  const headings = markdown
    .split('\n')
    .filter((line) => /^#{2,4}\s+\S/.test(line))
    .slice(0, 80)
    .join('\n');
  const opening = markdown.slice(0, ARCHITECTURE_ANCHOR_CHAR_LIMIT);
  return [opening, headings ? `\n\nKey headings:\n${headings}` : ''].join('').trim();
}

function stripModuleReferenceHeading(markdown: string): string {
  return markdown.trim().replace(/^##\s+Module Reference[^\n]*\n+/i, '').trim();
}

/**
 * Builds the architecture-pass (Pass 1) context string.
 * Uses structural signals, routes, env vars, docs, digest — not per-file summaries.
 */
function buildArchitectureContext(input: DocGenInput): string {
  const parts: string[] = [];

  // Project identity
  parts.push('## Project signals');
  parts.push(`Stack: ${input.repoMap.likelyStack.join(', ') || 'unknown'}`);
  parts.push(`Diagram title: ${input.diagramTitle || '(not specified)'}`);
  parts.push(`Diagram style: ${input.diagramStyle}`);
  if (input.focus) parts.push(`Analysis focus: ${input.focus}`);
  parts.push(`Total files scanned: ${input.repoMap.fileCount}`);
  parts.push(`Total size: ${Math.round(input.repoMap.totalBytes / 1024)} KB`);

  // Entrypoints
  const eps = input.repoMap.entrypoints.slice(0, 12).map((f) => f.path);
  if (eps.length) parts.push(`Entrypoints: ${eps.join(', ')}`);

  // Layer catalog (multi-layer mode)
  if (input.layers?.length) {
    parts.push('\n## Architectural Layers');
    parts.push(input.layers.map((l) => `- **${l.name}**: ${l.description}`).join('\n'));
  }

  // Plan groups (single mode)
  if (input.planGroups?.length) {
    parts.push('\n## Diagram Groups (from plan)');
    parts.push(
      input.planGroups
        .slice(0, 16)
        .map((g) => `- **${g.name}**: ${g.children.slice(0, 8).join(', ')}${g.children.length > 8 ? ` (+${g.children.length - 8})` : ''}`)
        .join('\n'),
    );
  }

  // Documentation priors
  parts.push('\n## Documentation excerpts');
  parts.push(formatDocs(input.docs, 3000));

  // Repo context (all structural signals)
  parts.push('\n## Repository structural context');
  parts.push(formatRepoContext(input.repoContext));

  // Analysis digest
  parts.push('\n## Analysis digest (module rollups)');
  parts.push(formatAnalysisDigest(input.analysisDigest));

  // Import graph
  parts.push('\n## Import graph');
  parts.push(formatImportGraph(input.importGraph, 60));

  // Top-level file summary digest (not full per-file, that's pass 2)
  if (input.summaries.length <= DOC_SPLIT_THRESHOLD) {
    // Single pass: include all summaries
    parts.push('\n## Per-file analysis');
    parts.push(formatFileSummaries(input.summaries));
  } else {
    // Two-pass mode: include only a compact rollup here
    parts.push('\n## File summary digest (top 30 most central files)');
    const topFiles = [...input.summaries]
      .sort((a, b) => {
        // Rank by fan-in from repoContext central files
        const aIdx = input.repoContext.centralFiles.findIndex((f) => f.path === a.path);
        const bIdx = input.repoContext.centralFiles.findIndex((f) => f.path === b.path);
        const aRank = aIdx === -1 ? 9999 : aIdx;
        const bRank = bIdx === -1 ? 9999 : bIdx;
        return aRank - bRank;
      })
      .slice(0, 30);
    parts.push(formatFileSummaries(topFiles));
    parts.push(`\n*(${input.summaries.length - 30} additional files documented in the Module Reference section below.)*`);
  }

  return parts.filter(Boolean).join('\n');
}

function buildModuleRefBatchContext(
  input: DocGenInput,
  batch: ModuleReferenceBatch,
  architectureAnchor: string,
): string {
  const parts: string[] = [];
  parts.push(`Repository: ${input.repoMap.likelyStack.join(', ') || 'unknown stack'}`);
  parts.push(`Module reference batch: ${batch.index}/${batch.total}`);
  parts.push(`Files in this batch: ${batch.summaries.length}`);
  parts.push(`Batch directories: ${batch.label}`);
  parts.push('');
  parts.push('Compact architecture pass context for consistency:');
  parts.push(architectureAnchor || '(architecture pass unavailable)');
  parts.push('');
  parts.push('Below is the complete per-file analysis for THIS batch only. Document every listed file at full technical depth.');
  parts.push('');
  parts.push(formatFileSummaries(batch.summaries));
  return parts.join('\n');
}

async function generateModuleReferenceBatches(
  session: ProviderSession,
  input: DocGenInput,
  pass1: string,
  opts: DocGenOptions,
): Promise<string> {
  const batches = splitModuleReferenceBatches(input.summaries);
  const limit = pLimit(MODULE_REF_CONCURRENCY);
  const architectureAnchor = compactArchitectureAnchor(pass1);
  opts.onProgress?.(`Module reference split into ${batches.length} bounded sections`, {
    instructionBatches: batches.length,
    instructionDone: 0,
  });

  // Root Cause vs Logic: one enormous module-reference prompt can trigger provider
  // context/output failures that surface as retryable 429/5xx responses, leaving
  // Document Mode in an infinite retry countdown. Generate bounded section calls
  // instead, while reusing the progressive FileSummary data already produced.
  const sections = await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        opts.onProgress?.(`Writing module reference ${batch.index}/${batch.total} (${batch.summaries.length} files: ${batch.label})`, {
          instructionBatches: batch.total,
          instructionDone: batch.index - 1,
        });
        const pass2Context = buildModuleRefBatchContext(input, batch, architectureAnchor);
        const pass2UserMsg = [
          pass2Context,
          '',
          'Generate the module-by-module reference for THIS batch now. Cover every file listed above. Do not document files outside this batch. Do not truncate or abbreviate. Group files by directory.',
          '\n\nReturn Markdown only.',
        ].join('\n');

        const section = await chatWithRetry(
          session,
          [
            { role: 'system', content: MODULE_REF_SYSTEM_PROMPT },
            { role: 'user', content: pass2UserMsg },
          ],
          { signal: opts.signal, onRetry: opts.onRetry },
        );
        opts.onProgress?.(`Finished module reference ${batch.index}/${batch.total}`, {
          instructionBatches: batch.total,
          instructionDone: batch.index,
        });
        return {
          index: batch.index,
          label: batch.label,
          markdown: stripModuleReferenceHeading(section),
        };
      }),
    ),
  );

  const ordered = sections.sort((a, b) => a.index - b.index);
  return [
    '## Module Reference',
    ...ordered.map((section) => `<!-- Module reference batch ${section.index}/${batches.length}: ${section.label} -->\n${section.markdown}`),
  ].join('\n\n');
}

// =========================================================================
// Public generator
// =========================================================================

/**
 * generateTechnicalDocumentation
 *
 * Main entry point. Produces comprehensive Markdown reference documentation
 * using one or two LLM calls depending on repo size.
 *
 * @param session  - Provider session (model, apiKey, endpoint)
 * @param input    - All analysis signals collected by the pipeline
 * @param opts     - Abort signal and retry listener
 * @returns        - Full Markdown documentation string
 */
export async function generateTechnicalDocumentation(
  session: ProviderSession,
  input: DocGenInput,
  opts: DocGenOptions = {},
): Promise<string> {
  const isLargeRepo = input.summaries.length > DOC_SPLIT_THRESHOLD;

  if (!isLargeRepo) {
    // ── Single pass ─────────────────────────────────────────────────────────
    // Unified prompt: architecture + module reference in one LLM call.
    const unifiedPrompt = ARCHITECTURE_SYSTEM_PROMPT +
      '\n\n' +
      MODULE_REF_SYSTEM_PROMPT.replace(
        '## Module Reference',
        '## 11. Module Reference (Per-File API Detail)',
      );

    const context = buildArchitectureContext(input);
    const userMsg = [
      context,
      '',
      'Generate the complete technical reference documentation now. Cover every section listed in the system prompt. Do not truncate or abbreviate any section.',
    ].join('\n');

    const result = await chatWithRetry(
      session,
      [
        { role: 'system', content: unifiedPrompt },
        { role: 'user', content: userMsg + '\n\nReturn Markdown only. Do not wrap the whole response in a code fence.' },
      ],
      { signal: opts.signal, onRetry: opts.onRetry },
    );

    return result.trim();
  }

  // ── Two-pass (large repo) ────────────────────────────────────────────────
  // Pass 1: Architecture, API, Config, Security, Testing
  const pass1Context = buildArchitectureContext(input);
  const pass1UserMsg = [
    pass1Context,
    '',
    'Generate sections 1–10 of the technical reference now (Project Overview through Module Cross-Reference Map). Be thorough. Do not produce the per-file Module Reference here — that will follow in a separate pass.',
    '\n\nReturn Markdown only.',
  ].join('\n');

  const pass1 = await chatWithRetry(
    session,
    [
      { role: 'system', content: ARCHITECTURE_SYSTEM_PROMPT },
      { role: 'user', content: pass1UserMsg },
    ],
    { signal: opts.signal, onRetry: opts.onRetry },
  );

  // Check abort between passes
  if (opts.signal?.aborted) {
    return pass1.trim();
  }

  // Motivation vs Logic: large Document Mode output is richer and more reliable
  // when independent module-reference sections are delegated to bounded calls
  // after the shared architecture pass. The calls can run in parallel because
  // each receives the architecture anchor plus its own narrow FileSummary batch.
  const pass2 = await generateModuleReferenceBatches(session, input, pass1, opts);

  return [pass1.trim(), '---', pass2.trim()].join('\n\n');
}

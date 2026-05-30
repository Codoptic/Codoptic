import path from 'node:path';
import { extractBuildPlanPath } from '@/lib/code-space/planBuild';
import { traceDependencyEdges, type DependencyEdge } from './dependencyTrace';
import { listRepositoryFiles, normalizeContextPath, safeReadTextFile } from './repoMap';
import { extractSymbols } from './symbolScanner';

export type ContextReason =
  | 'explicit_file'
  | 'explicit_folder'
  | 'open_tab'
  | 'current_editor'
  | 'recent_file'
  | 'plan_artifact'
  | 'project_rule'
  | 'package_config'
  | 'direct_import_dependency'
  | 'reverse_importer'
  | 'test_surface'
  | 'symbol_match'
  | 'content_match'
  | 'route_runtime_surface'
  | 'ui_surface'
  | 'documentation_spec'
  | 'central_node';

export interface ContextAttachment {
  kind: 'file' | 'folder';
  relativePath: string;
  displayName?: string;
}

export interface ContextGraphOptions {
  mode?: 'ask' | 'plan' | 'code';
  openTabs?: string[];
  currentEditorFile?: string;
  recentFiles?: string[];
  attachments?: ContextAttachment[];
  buildPlanPath?: string | null;
  limitHint?: number;
  /**
   * Structural prioritization signals from a precomputed repository digest or knowledge graph
   * (central/"god" files, hot routes, community hubs). Lets persistent structure improve file
   * selection without re-deriving it each run. See `deriveStructuralSignals`.
   */
  structuralSignals?: Array<{ path: string; weight: number; reason?: string }>;
}

export interface ContextGraphFile {
  path: string;
  content: string;
  truncated: boolean;
  mode: 'full' | 'partial';
  lineCount: number;
  score: number;
  reasons: ContextReason[];
  reasonDetails: string[];
  summary: string;
  symbols: string[];
}

export interface ContextGraphResult {
  filesConsidered: number;
  files: ContextGraphFile[];
  selectedFiles: string[];
  omittedRelevantCandidates: string[];
  terms: string[];
  dependencyEdges: DependencyEdge[];
  testCandidates: string[];
  validationCandidates: string[];
  missingContextWarnings: string[];
  confidence: 'low' | 'medium' | 'high';
  evidencePackArtifactId?: string;
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'you', 'your', 'are', 'can', 'into', 'from', 'mode', 'code', 'make', 'please', 'need', 'deeply', 'review', 'comprehensively', 'improve', 'plan']);
const DEFAULT_CONTEXT_CHAR_LIMIT = 22_000;
const DEEP_CONTEXT_CHAR_LIMIT = 140_000;

function promptTerms(prompt: string): string[] {
  return Array.from(new Set(prompt.toLowerCase().split(/[^a-z0-9_/-]+/).filter((term) => term.length > 2 && !STOP_WORDS.has(term)))).slice(0, 48);
}

function normalizeReason(reason: string): ContextReason {
  if (reason === 'explicit_file') return 'explicit_file';
  if (reason === 'explicit_folder') return 'explicit_folder';
  if (reason === 'open_tab') return 'open_tab';
  if (reason === 'current_editor') return 'current_editor';
  if (reason === 'recent_file') return 'recent_file';
  return 'content_match';
}

function addScore(
  scores: Map<string, { score: number; reasons: Set<ContextReason>; details: Set<string> }>,
  file: string,
  amount: number,
  reason: ContextReason,
  detail: string = reason,
) {
  const normalized = normalizeContextPath(file);
  if (!normalized || amount <= 0) return;
  const current = scores.get(normalized) ?? { score: 0, reasons: new Set<ContextReason>(), details: new Set<string>() };
  current.score += amount;
  current.reasons.add(reason);
  current.details.add(detail);
  scores.set(normalized, current);
}

function summarizeContextFile(filePath: string, content: string, symbols: string[]): string {
  const lowerPath = filePath.toLowerCase();
  const lower = content.toLowerCase();
  const symbolHint = symbols.length ? ` Key surfaces: ${symbols.slice(0, 4).join(', ')}.` : '';
  if (/readme|docs?\//i.test(filePath)) return `Project documentation, setup notes, or architecture constraints.${symbolHint}`;
  if (/agents\.md|claude\.md|instructions\.md|project[-_]?rules/i.test(filePath)) return `Project rules and coding instructions that should shape runtime behavior.${symbolHint}`;
  if (/package\.json|tsconfig|next\.config|vitest|playwright/i.test(lowerPath)) return `Package, framework, or validation configuration.${symbolHint}`;
  if (/route\.ts|app\/api|controller/i.test(lowerPath)) return `API route/runtime entrypoint selected for request handling evidence.${symbolHint}`;
  if (/agent|orchestrator|runtime|runner|manager/i.test(lowerPath)) return `Agent runtime, orchestration, state, or execution surface.${symbolHint}`;
  if (/patch|checkpoint|diff/i.test(lowerPath)) return `Patch, diff, checkpoint, or mutation lifecycle surface.${symbolHint}`;
  if (/validation|terminal|test/i.test(lowerPath)) return `Validation, terminal, test, or repair-loop surface.${symbolHint}`;
  if (/components\/code-space|panel|workspace|selector/i.test(lowerPath)) return `Code Space UI/session state surface.${symbolHint}`;
  if (/test|spec/i.test(lowerPath)) return `Executable test surface or behavior example.${symbolHint}`;
  if (/mongo|database|rag|retrieval|faiss|vector|embedding|chatbot|clinical|guideline|pubmed|mesh/.test(`${lowerPath}\n${lower}`)) return `Data, retrieval, chatbot, or clinical evidence integration surface.${symbolHint}`;
  return `Implementation surface selected by repository context scoring.${symbolHint}`;
}

function isPackageOrConfig(file: string): boolean {
  return /package\.json|tsconfig|next\.config|vitest|playwright|tailwind|postcss|eslint|instructions\.md|project[-_]?rules/i.test(file);
}

function promptNeedsCodeSpaceUi(prompt: string): boolean {
  return /\bcode\s*space\b/i.test(prompt) && /\b(page|workspace|sidebar|editor|diff|patch|accept|reject|changes?)\b/i.test(prompt);
}

function promptNeedsAgentHarness(prompt: string): boolean {
  return /\b(agent|tool|grep|shell|terminal|context|evidence|explor|self[-\s]?explor|analy[sz]e?|harness|workflow|patch|planner|runtime|apply|edit)\b/i.test(prompt);
}

function promptNeedsDataRetrievalSurface(prompt: string): boolean {
  return /\b(mongo(?:db)?|pymongo|database|db_manager|rag|retrieval|retrieve|clinical|passage|faiss|vector|embedding|chatbot|medical|guideline|pubmed)\b/i.test(prompt);
}

function contextCharLimit(filePath: string, prompt: string, reasons: Set<ContextReason>): number {
  const lowerPath = filePath.toLowerCase();
  if (reasons.has('explicit_file') || reasons.has('open_tab') || reasons.has('current_editor') || reasons.has('plan_artifact')) {
    return DEEP_CONTEXT_CHAR_LIMIT;
  }
  // Root Cause vs Logic: Code Space page work follows imports across many component surfaces
  // (workspace, bottom panel, sidebars, selectors, input widgets). If any of those are truncated,
  // the patch planner can keep requesting just one more file and never produce a patch. Treat all
  // top-level Code Space React components and tests as deep-read evidence for UI-agent work.
  if (promptNeedsCodeSpaceUi(prompt) && /^components\/code-space\/[^/]+\.tsx$/i.test(lowerPath)) {
    return DEEP_CONTEXT_CHAR_LIMIT;
  }
  if (promptNeedsCodeSpaceUi(prompt) && /^components\/code-space\/__tests__\//i.test(lowerPath)) {
    return DEEP_CONTEXT_CHAR_LIMIT;
  }
  if (promptNeedsAgentHarness(prompt) && /^lib\/code-space\/runtime\/(agentruntime|contextgraphengine|toolregistry|terminalpolicy|permissionmanager|terminalrunner|validationrunner|repairloop)\.ts$/i.test(lowerPath)) {
    return DEEP_CONTEXT_CHAR_LIMIT;
  }
  if (promptNeedsAgentHarness(prompt) && /^app\/api\/code-space\/agent\//i.test(lowerPath)) {
    return DEEP_CONTEXT_CHAR_LIMIT;
  }
  if (promptNeedsDataRetrievalSurface(prompt) && /(^|\/)(api|backend|src)\//i.test(lowerPath) && /database|db|mongo|rag|retriev|chatbot|clinical|passage|vector|embedding|faiss|app\.py|routes\.py/i.test(lowerPath)) {
    return DEEP_CONTEXT_CHAR_LIMIT;
  }
  return DEFAULT_CONTEXT_CHAR_LIMIT;
}

function extractReferencedFiles(content: string, candidateSet: Set<string>): string[] {
  const references = new Set<string>();
  const pathPattern =
    /(?<![\w./-])(?:\.{1,2}\/)?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.(?:ts|tsx|js|jsx|json|md|mdx|py|go|rs|java|kt|cs|php|rb|sh|yml|yaml|toml|css|scss))?)(?![\w./-])/g;

  for (const match of content.matchAll(pathPattern)) {
    for (const resolved of resolveCandidatePaths(match[1] ?? '', candidateSet)) references.add(resolved);
  }

  return Array.from(references);
}

function extractPromptReferencedFiles(prompt: string, candidateSet: Set<string>): string[] {
  const references = new Set<string>(extractReferencedFiles(prompt, candidateSet));
  const quotedRuntimePathPattern = /File\s+"([^"]+\.(?:py|ts|tsx|js|jsx|json|md|yml|yaml|java|kt|cs|go|rs|php|rb|sh))"/g;
  const absolutePathPattern = /(?:^|[\s'"`(])((?:\/[A-Za-z0-9_.-]+)+\.(?:py|ts|tsx|js|jsx|json|md|yml|yaml|java|kt|cs|go|rs|php|rb|sh))(?![\w./-])/g;

  for (const match of prompt.matchAll(quotedRuntimePathPattern)) {
    for (const resolved of resolveCandidatePaths(match[1] ?? '', candidateSet)) references.add(resolved);
  }
  for (const match of prompt.matchAll(absolutePathPattern)) {
    for (const resolved of resolveCandidatePaths(match[1] ?? '', candidateSet)) references.add(resolved);
  }
  return Array.from(references);
}

function resolveCandidatePaths(rawPath: string, candidateSet: Set<string>): string[] {
  const normalized = normalizeRuntimeFilePath(rawPath);
  if (!normalized) return [];
  const matches = new Set<string>();
  const variants = runtimePathVariants(normalized);
  for (const variant of variants) {
    if (candidateSet.has(variant)) matches.add(variant);
  }
  for (const candidate of candidateSet) {
    for (const variant of variants) {
      if (candidate === variant || candidate.endsWith(`/${variant}`) || variant.endsWith(`/${candidate}`)) {
        matches.add(candidate);
      }
    }
  }
  return Array.from(matches);
}

function normalizeRuntimeFilePath(rawPath: string): string {
  return rawPath
    .replace(/\\/g, '/')
    .replace(/^file:\/\//i, '')
    .replace(/^['"`(]+|['"`),.;:]+$/g, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

function runtimePathVariants(normalizedPath: string): string[] {
  const variants = new Set<string>();
  const parts = normalizedPath.split('/').filter(Boolean);
  variants.add(parts.join('/'));
  for (const prefix of ['app', 'workspace', 'workspaces', 'repo', 'project', 'src']) {
    const index = parts.indexOf(prefix);
    if (index >= 0 && index + 1 < parts.length) variants.add(parts.slice(index + 1).join('/'));
  }
  for (let index = 0; index < parts.length - 1; index += 1) {
    const suffix = parts.slice(index).join('/');
    if (suffix.includes('/')) variants.add(suffix);
  }
  return Array.from(variants).filter(Boolean);
}

export class ContextGraphEngine {
  async collectProjectContext(root: string, prompt: string, options: ContextGraphOptions = {}): Promise<ContextGraphResult> {
    const candidates = await listRepositoryFiles(root);
    const candidateSet = new Set(candidates);
    const terms = promptTerms(prompt);
    const scores = new Map<string, { score: number; reasons: Set<ContextReason>; details: Set<string> }>();
    const buildPlanPath = normalizeContextPath(options.buildPlanPath ?? extractBuildPlanPath(prompt) ?? '');
    const needsCodeSpaceUi = promptNeedsCodeSpaceUi(prompt);
    const needsAgentHarness = promptNeedsAgentHarness(prompt);
    const needsDataRetrievalSurface = promptNeedsDataRetrievalSurface(prompt);

    for (const file of candidates) {
      const lower = file.toLowerCase();
      if (isPackageOrConfig(file)) addScore(scores, file, 18, 'package_config');
      if (/^app\/api\/code-space|lib\/code-space\/runtime|app\/api\/code-space\/agent/.test(file)) addScore(scores, file, 22, 'route_runtime_surface');
      if (/^components\/code-space/.test(file)) addScore(scores, file, 18, 'ui_surface');
      // Motivation vs Logic: capable coding agents do not wait for users to paste every file; they
      // use the request shape to route initial evidence. Code Space page/review prompts must bring
      // the workspace/editor/sidebar files forward before runtime internals crowd them out.
      if (needsCodeSpaceUi && /^components\/code-space\//.test(file)) addScore(scores, file, 80, 'ui_surface', 'Code Space UI prompt');
      if (needsCodeSpaceUi && /components\/code-space\/(CodeSpaceWorkspace|AgentPanel|BottomPanel|FileMentionInput)\.tsx$/.test(file)) addScore(scores, file, 120, 'ui_surface', 'primary Code Space page surface');
      if (needsCodeSpaceUi && /^components\/code-space\/__tests__/.test(file)) addScore(scores, file, 55, 'test_surface', 'Code Space UI regression surface');
      if (needsCodeSpaceUi && file === 'app/page.tsx') addScore(scores, file, 48, 'ui_surface', 'Code Space shell entrypoint');
      if (needsAgentHarness && /lib\/code-space\/runtime\/(agentRuntime|contextGraphEngine|toolRegistry|terminalPolicy|permissionManager|terminalRunner|validationRunner|repairLoop)\.ts$/.test(file)) {
        addScore(scores, file, 85, 'route_runtime_surface', 'agent harness capability prompt');
      }
      if (needsAgentHarness && /^app\/api\/code-space\/(agent|terminal)\//.test(file)) addScore(scores, file, 70, 'route_runtime_surface', 'agent API capability prompt');
      // Motivation vs Logic: user bug reports often name a capability (MongoDB/RAG/retrieval)
      // rather than every file. Boost likely data-path modules so the agent can inspect the
      // database/bootstrap/chatbot surfaces before deciding how to disable or refactor them.
      if (needsDataRetrievalSurface && /(^|\/)(api|backend|src)\//i.test(file) && /database|db|mongo|rag|retriev|chatbot|clinical|passage|vector|embedding|faiss|app\.py|routes\.py/i.test(lower)) {
        addScore(scores, file, 150, 'route_runtime_surface', 'data/retrieval capability prompt');
      }
      if (needsDataRetrievalSurface && /requirements\.txt|pyproject\.toml|\.env|config|settings/i.test(lower)) {
        addScore(scores, file, 70, 'package_config', 'data/retrieval configuration prompt');
      }
      if (/(__tests__|\.test\.|\.spec\.|tests?\/)/i.test(file)) addScore(scores, file, 10, 'test_surface');
      if (/^(docs|README\.md)/i.test(file)) addScore(scores, file, 8, 'documentation_spec');
      if (/AGENTS\.md|CLAUDE\.md|INSTRUCTIONS\.md|PROJECT_RULES\.md/i.test(file)) addScore(scores, file, 24, 'project_rule');
      if (/^\.agent\/plans/.test(file)) addScore(scores, file, 8, 'plan_artifact');
      const pathHits = terms.reduce((sum, term) => sum + (lower.includes(term) ? 7 : 0), 0);
      if (pathHits) addScore(scores, file, pathHits, 'content_match', 'prompt/path overlap');
    }

    if (buildPlanPath) addScore(scores, buildPlanPath, candidateSet.has(buildPlanPath) ? 500 : 0, 'plan_artifact', 'approved plan artifact');

    for (const tab of options.openTabs ?? []) {
      addScore(scores, tab, 70, 'open_tab');
    }
    if (options.currentEditorFile) {
      addScore(scores, options.currentEditorFile, 80, 'current_editor');
    }
    for (const recent of options.recentFiles ?? []) {
      addScore(scores, recent, 20, 'recent_file');
    }
    for (const attachment of options.attachments ?? []) {
      const normalized = normalizeContextPath(attachment.relativePath);
      if (attachment.kind === 'file') {
        addScore(scores, normalized, 180, 'explicit_file', `@File ${attachment.displayName ?? normalized}`);
        continue;
      }
      for (const file of candidates) {
        if (file === normalized || file.startsWith(`${normalized}/`)) {
          addScore(scores, file, 130 - Math.min(file.split('/').length, 20), 'explicit_folder', `@Folder ${attachment.displayName ?? normalized}`);
        }
      }
    }

    const promptMentions = Array.from(prompt.matchAll(/@([\w./-]+)/g)).map((match) => normalizeContextPath(match[1] ?? ''));
    for (const mention of promptMentions) {
      if (candidateSet.has(mention)) addScore(scores, mention, 170, 'explicit_file');
      for (const file of candidates) {
        if (file.startsWith(`${mention.replace(/\/$/, '')}/`)) addScore(scores, file, 115, 'explicit_folder');
      }
    }

    for (const referenced of extractPromptReferencedFiles(prompt, candidateSet)) {
      addScore(scores, referenced, 520, 'explicit_file', 'file path referenced in prompt, traceback, or error output');
    }

    // Structural prioritization from a precomputed digest / knowledge graph (central files, routes,
    // community hubs). Capped so it tilts ranking toward architecturally important files without
    // overriding explicit user intent (attachments/mentions score far higher).
    for (const signal of options.structuralSignals ?? []) {
      addScore(scores, signal.path, Math.max(0, Math.min(120, signal.weight)), 'central_node', signal.reason ?? 'structural signal (import/knowledge graph)');
    }

    const baseBudget = options.mode === 'ask' ? 15 : options.mode === 'plan' ? 35 : 50;
    const budget = Math.max(8, Math.min(50, options.limitHint ?? baseBudget));
    const ranked = Array.from(scores.entries())
      .filter(([file, scored]) => candidateSet.has(file) && scored.score > 0)
      .map(([file, scored]) => ({ file, ...scored }))
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    let tracedFiles = new Set<string>(ranked.slice(0, budget).map((item) => item.file));

    // Motivation vs Logic: the first-ranked evidence set is often only the doorway into the real
    // implementation. We intentionally mine those seed files for explicit file references, then
    // re-trace dependencies so the agent can pull more context on its own instead of stopping at
    // whatever the user typed first.
    for (let pass = 0; pass < 2; pass += 1) {
      const trace = await traceDependencyEdges({ root, candidates, selected: Array.from(tracedFiles) });
      for (const edge of trace.edges) {
        addScore(scores, edge.to, 26, edge.reason === 'direct_import' ? 'direct_import_dependency' : 'reverse_importer', `${edge.reason} ${edge.from} -> ${edge.to}`);
        addScore(scores, edge.from, 22, edge.reason === 'direct_import' ? 'direct_import_dependency' : 'reverse_importer', `${edge.reason} ${edge.from} -> ${edge.to}`);
      }

      const seedFiles = Array.from(trace.files)
        .map((file) => ({
          file,
          score: scores.get(file)?.score ?? 0,
        }))
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
        .slice(0, Math.min(budget, pass === 0 ? 10 : 16))
        .map((item) => item.file);

      const discovered = new Set<string>();
      for (const seed of seedFiles) {
        const content = await safeReadTextFile(root, seed);
        if (!content) continue;
        for (const ref of extractReferencedFiles(content, candidateSet)) {
          discovered.add(ref);
        }
      }

      for (const ref of discovered) {
        addScore(scores, ref, pass === 0 ? 140 : 100, 'content_match', 'referenced by selected evidence');
      }

      const nextSelected = Array.from(scores.entries())
        .filter(([file, scored]) => candidateSet.has(file) && scored.score > 0)
        .map(([file, scored]) => ({ file, ...scored }))
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
        .slice(0, budget)
        .map((item) => item.file);
      const nextSelectedSet = new Set(nextSelected);
      const stable = nextSelected.length === tracedFiles.size && nextSelected.every((file) => tracedFiles.has(file));
      tracedFiles = nextSelectedSet;
      if (stable || discovered.size === 0) break;
    }

    const trace = await traceDependencyEdges({ root, candidates, selected: Array.from(tracedFiles) });
    const finalRanked = Array.from(trace.files)
      .map((file) => {
        const scored = scores.get(file) ?? { score: 0, reasons: new Set<ContextReason>(), details: new Set<string>() };
        return { file, ...scored };
      })
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, budget);

    const files: ContextGraphFile[] = [];
    for (const item of finalRanked) {
      const content = await safeReadTextFile(root, item.file);
      if (content == null) continue;
      const symbols = extractSymbols(content);
      const contentHits = terms.filter((term) => content.toLowerCase().includes(term)).slice(0, 6);
      const reasons = new Set(item.reasons);
      if (contentHits.length) reasons.add('content_match');
      if (symbols.some((symbol) => terms.includes(symbol.toLowerCase()))) reasons.add('symbol_match');
      const charLimit = contextCharLimit(item.file, prompt, reasons);
      const truncated = content.length > charLimit;
      files.push({
        path: item.file,
        content: content.slice(0, charLimit),
        truncated,
        mode: truncated ? 'partial' : 'full',
        lineCount: content.split('\n').length,
        score: item.score + contentHits.length * 3,
        reasons: Array.from(reasons),
        reasonDetails: Array.from(item.details),
        summary: summarizeContextFile(item.file, content, symbols),
        symbols: symbols.slice(0, 12),
      });
    }

    const selectedFiles = files.map((file) => file.path);
    const omittedRelevantCandidates = ranked
      .filter((item) => !selectedFiles.includes(item.file) && item.score >= 18)
      .slice(0, 15)
      .map((item) => item.file);
    const missingContextWarnings: string[] = [];
    for (const attachment of options.attachments ?? []) {
      const normalized = normalizeContextPath(attachment.relativePath);
      if (attachment.kind === 'file' && !selectedFiles.includes(normalized)) missingContextWarnings.push(`Mentioned file was not readable: ${normalized}`);
    }
    if (buildPlanPath && !selectedFiles.includes(buildPlanPath)) missingContextWarnings.push(`Referenced plan artifact was not readable: ${buildPlanPath}`);
    if (!files.length) missingContextWarnings.push('No high-signal project files were readable.');
    for (const file of files) {
      if (file.truncated && (file.reasons.includes('explicit_file') || file.reasons.includes('open_tab') || file.reasons.includes('current_editor'))) {
        missingContextWarnings.push(`High-priority context file is still truncated after deep read: ${file.path}`);
      }
    }

    const confidence: ContextGraphResult['confidence'] = files.length >= 24 ? 'high' : files.length >= 8 ? 'medium' : 'low';
    return {
      filesConsidered: candidates.length,
      files,
      selectedFiles,
      omittedRelevantCandidates,
      terms,
      dependencyEdges: trace.edges,
      testCandidates: selectedFiles.filter((file) => /(__tests__|\.test\.|\.spec\.|tests?\/)/i.test(file)),
      validationCandidates: selectedFiles.filter((file) => isPackageOrConfig(file) || /pytest|go\.mod|Cargo\.toml/i.test(path.basename(file))),
      missingContextWarnings,
      confidence,
    };
  }
}

export function legacyReasonLabel(reason: ContextReason): string {
  return normalizeReason(reason);
}

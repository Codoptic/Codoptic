# Multi-Layer Mode & AI Provider System — Technical Reference

---

## Overview

The multi-layer subsystem is a set of cooperating modules that let the application generate **a family of related diagrams from a single repository scan or free-form text prompt**. Rather than producing one flat diagram, the pipeline decomposes the subject into 3–10 cohesive architectural layers and emits:

1. One **Overview** diagram — all layers shown as top-level DSL groups with representative surface nodes and cross-layer edges between them.
2. One **sub-diagram per layer** — internal components of that layer at full detail, with one-hop boundary nodes from adjacent layers shown as dashed pass-throughs.

The AI provider system is an eight-adapter abstraction (`openai`, `anthropic`, `gemini`, `grok`, `mistral`, `deepseek`, `nvidia`, `foundry`) behind a single `Provider` interface. Every adapter supports plain chat calls and structured JSON output. All calls are wrapped in an infinite-retry loop with exponential backoff, Retry-After header respect, and per-attempt UI notifications via a `RetryListener` callback.

All pipelines communicate with their callers via **Server-Sent Events (SSE)** streamed over HTTP. This allows the UI to animate progress in real time while the LLM calls are in flight.

---

## Multi-Layer Architecture

### High-level data flow

```
User input (repo path / free-form prompt)
  │
  ▼
API Route (Next.js App Router)
  │  validates request, resolves repo source, builds ProviderSession
  │  opens SSE stream
  ▼
Pipeline function (runMultiLayerPipeline / runCustomMultiLayerPlan)
  │  emits stage/log/retry/result events via send()
  │
  ├─ Stage: validate          → validateWithRetry(session)
  ├─ Stage: scan              → scanResolvedRepoSource()
  ├─ Stage: classify          → classifyRelevance()
  ├─ Stage: context           → readDocPriors() + extractImportGraph()
  ├─ Stage: summarize         → analyzeRelevantFiles() (skipped in quickMode)
  ├─ Stage: layers            → identifyLayers() → LayerCatalog
  ├─ Stage: overview          → overviewDslFromCatalog() → DSL string
  │                             validateDsl() → tryRepair() if errors
  ├─ Stage: sub-plans         → [per layer, parallel p-limit(2)]
  │    └── generatePlan() → planToDsl() → validateDsl()
  └─ Stage: instruction       → generateInstructionGuide() (if instructionMode)
       └── emit: result-multilayer { output: MultiLayerOutput }
```

### Key type: MultiLayerOutput (state/store)

```typescript
interface LayerDiagram {
  name: string;
  description: string;
  dsl: string;
}

interface MultiLayerOutput {
  overview: LayerDiagram;        // the high-level cross-layer DSL
  layers: LayerDiagram[];        // one entry per identified layer
  generatedAt: number;           // Date.now() timestamp
}
```

### SSE event taxonomy

Every pipeline function calls `send(ev: SseEvent)`. The caller is the API route which passes a function returned by `makeSseStream()`.

| event type | key fields | meaning |
|---|---|---|
| `stage` | `stage`, `status` ('start'/'done'), `message?`, `counters?` | Pipeline stage lifecycle |
| `log` | `stage`, `level` ('info'/'warn'/'error'), `message` | Informational progress message |
| `retry` | `stage`, `attempt`, `delayMs`, `reason` | Retry notice for UI countdown |
| `error` | `stage`, `message` | Fatal or non-fatal error |
| `result-multilayer` | `output: MultiLayerOutput`, `instructionMarkdown?` | Final result payload |
| `result` | `dsl` | Final single-diagram result (non-multilayer pipelines) |
| `result-clarify` | `output: ClarifyingQuestions` | Clarify pipeline result |
| `done` | — | Stream termination sentinel |

---

## Module: `lib/agent/multilayer.ts`

### Purpose

Implements `runMultiLayerPipeline` — the repo-scanner-based multi-layer pipeline. Receives a resolved repository source and a `ProviderSession`, runs the full 9-stage pipeline, and streams SSE events.

### Exported interfaces

#### `MultiLayerInput`

```typescript
export interface MultiLayerInput {
  repoSource: ResolvedRepoSource;
  session: ProviderSession;
  focus: string;
  topK?: number;
  ignoredFolders?: string[];
  quickMode?: boolean;
  maxMode?: boolean;
  instructionMode?: boolean;
  signal?: AbortSignal;
}
```

| field | type | description |
|---|---|---|
| `repoSource` | `ResolvedRepoSource` | Resolved repo descriptor (local path or cloned GitHub repo) |
| `session` | `ProviderSession` | Provider ID, model, API key, optional endpoint |
| `focus` | `string` | Free-text focus hint for relevance classifier and planner |
| `topK` | `number?` | Max files to select (default 80; overridden to all files in `maxMode`) |
| `ignoredFolders` | `string[]?` | Folder names to exclude from scan |
| `quickMode` | `boolean?` | Skip per-file summarization; infer layers from structural digest only |
| `maxMode` | `boolean?` | Lift file-budget cap; pass all relevant files to the planner |
| `instructionMode` | `boolean?` | Append an Instruction Mode guide as Markdown |
| `signal` | `AbortSignal?` | Cancellation signal threaded through every async step |

### Internal functions

#### `edgeOp(kind)`

```typescript
function edgeOp(kind: LayerCatalog['cross_layer_edges'][number]['kind']): string
```

Maps an edge kind identifier to its DSL operator string.

| kind | DSL operator |
|---|---|
| `'fwd'` | `>` |
| `'bwd'` | `<` |
| `'bi'` | `<>` |
| `'dashed'` | `--` |
| `'thick'` | `=>` |

---

#### `sanitizeDslName(value, fallback)`

```typescript
function sanitizeDslName(value: string, fallback: string): string
```

Strips DSL-reserved characters (`[]{}:,`) from a string, collapses whitespace, truncates to 56 characters. Returns `fallback` if the result is empty.

**Used by:** `overviewDslFromCatalog`, `fallbackLayerDsl`, and mirrored in `customMultilayer.ts`.

---

#### `uniqueName(base, used)`

```typescript
function uniqueName(base: string, used: Set<string>): string
```

Appends an incrementing suffix (`" 2"`, `" 3"`, …) to `base` if its lowercase form already exists in `used`. Adds the chosen name to `used` before returning. This prevents duplicate node/group names within the same DSL scope, which would be a syntax error.

---

#### `validateDsl(session, dsl, send, stage, onRetry, signal?)`

```typescript
async function validateDsl(
  session: ProviderSession,
  dsl: string,
  send: (ev: SseEvent) => void,
  stage: string,
  onRetry: (stage: string) => (notice: { attempt: number; delayMs: number; reason: string }) => void,
  signal?: AbortSignal,
): Promise<string>
```

Runs the DSL through `compile()`. If there are zero errors, returns the DSL unchanged (warnings are logged). If there are errors, calls `tryRepair()` to let the LLM fix them, then re-compiles and reports remaining errors/warnings. Returns the (possibly repaired) DSL string.

---

#### `fallbackLayerDsl(layer)`

```typescript
function fallbackLayerDsl(layer: LayerCatalog['layers'][number]): string
```

Produces a minimal syntactically valid DSL for a layer when `generatePlan()` throws. Creates a single DSL group with up to 10 `[color: …, icon: file]` nodes derived from `representative_files` or `member_files`. Prevents the entire multi-layer output from failing due to one layer's planning error.

### Exported functions

#### `overviewDslFromCatalog(catalog)`

```typescript
export function overviewDslFromCatalog(catalog: LayerCatalog): string
```

**Deterministic** (no LLM call). Transforms a `LayerCatalog` into an overview DSL string.

Algorithm:
1. Builds a de-duplicated name map for each layer using `sanitizeDslName` + `uniqueName`.
2. For each layer, emits a DSL group block (`LayerName [color: …, icon: …] {`) with up to 6 surface nodes derived from `representative_files` (falling back to `member_files`). File paths are stripped to basename, extension removed, converted to Title Case.
3. After all groups, emits `// ==== Cross-layer flow ====` and one DSL edge per entry in `catalog.cross_layer_edges`, looking up both endpoint names from the layer name map (case-insensitive fallback lookup). Edges with unknown endpoints are silently skipped.

Returns a single multi-line DSL string.

---

#### `runMultiLayerPipeline(input, send)`

```typescript
export async function runMultiLayerPipeline(
  input: MultiLayerInput,
  send: (ev: SseEvent) => void,
): Promise<MultiLayerOutput | null>
```

Main entry point. Runs 9 stages sequentially (with sub-stages parallelised via `pLimit(2)`). Returns `MultiLayerOutput` on success or `null` on any fatal error (after emitting an `error` event).

**Stage sequence:**

| # | stage id | key call | notes |
|---|---|---|---|
| 1 | `validate` | `validateWithRetry()` | Checks API key by making a minimal probe call |
| 2 | `scan` | `scanResolvedRepoSource()` | Walks filesystem; populates `RepoMap` |
| 3 | `classify` | `classifyRelevance()` | Scores files; caps at `topK` (or all files in maxMode) |
| 4 | `context` | `readDocPriors()` + `extractImportGraph()` + `buildRepoContext()` | Runs in parallel with `Promise.all` |
| 5 | `summarize` | `analyzeRelevantFiles()` | Per-file LLM summarization; skipped in quickMode |
| 6 | `layers` | `identifyLayers()` | LLM returns a `LayerCatalog` JSON |
| 7 | `overview` | `overviewDslFromCatalog()` + `validateDsl()` | Deterministic; repair applied if errors |
| 8 | `sub-plans` | `generatePlan()` + `planToDsl()` + `validateDsl()` | `pLimit(2)` — up to 2 layers concurrently |
| 9 | `instruction` | `generateInstructionGuide()` | Only when `instructionMode === true` |

After stage 8, assembles `MultiLayerOutput` and emits `result-multilayer`. Emits `done` before returning.

---

## Module: `lib/agent/customMultilayer.ts`

### Purpose

Implements the **prompt-only** multi-layer pipeline (`runCustomMultiLayerPlan`). No repository scanning. The LLM constructs the entire layer catalog from a free-form description + clarifying answers.

### Constants

#### `COLORS`

```typescript
const COLORS = [
  'orange', 'green', 'yellow', 'amber', 'coral', 'teal', 'slate',
  'indigo', 'blue', 'purple', 'lime', 'sky', 'red', 'pink', 'gray',
];
```

Palette for assigning distinct colors to layers in the LLM's response.

#### `CUSTOM_LAYER_CATALOG_JSON_SCHEMA`

Raw JSON Schema object passed to providers that support structured output. Defines the shape of the `CustomLayerCatalog`.

Schema tree:
- `layers[]` — 3–8 items, each with `name`, `description`, `color` (enum over `COLORS`), `icon`, `key_elements[]` (2–10 items), `boundary_deps[]`
- `cross_layer_edges[]` — each with `source`, `target`, `kind` (enum: fwd/bwd/bi/dashed/thick), `label` (string|null)

#### `CustomLayerCatalogSchema` (Zod)

```typescript
const CustomLayerCatalogSchema = z.object({
  layers: z.array(z.object({
    name: z.string(),
    description: z.string(),
    color: z.string(),
    icon: z.string(),
    key_elements: z.array(z.string()).min(2).max(10),
    boundary_deps: z.array(z.string()),
  })).min(3).max(8),
  cross_layer_edges: z.array(z.object({
    source: z.string(),
    target: z.string(),
    kind: z.enum(['fwd', 'bwd', 'bi', 'dashed', 'thick']),
    label: z.string().nullable().optional(),
  })),
});

export type CustomLayerCatalog = z.infer<typeof CustomLayerCatalogSchema>;
```

### Exported interfaces

#### `CustomMultiLayerInput`

```typescript
export interface CustomMultiLayerInput {
  session: ProviderSession;
  prompt: string;
  intentSummary?: string;
  answers: CustomAnswer[];
  instructionMode?: boolean;
  signal?: AbortSignal;
}
```

### Internal functions

#### `sanitizeDslName(value, fallback)`, `uniqueName(base, used)`, `edgeOp(kind)`

Identical in logic to the same-named functions in `multilayer.ts`. Module-private copies to avoid cross-module coupling.

#### `validateAndRepairDsl(session, dsl, send, stage, onRetry, signal?)`

```typescript
async function validateAndRepairDsl(
  session: ProviderSession,
  dsl: string,
  send: (ev: SseEvent) => void,
  stage: string,
  onRetry: (s: string) => (n: { attempt: number; delayMs: number; reason: string }) => void,
  signal?: AbortSignal,
): Promise<string>
```

Simplified variant of `validateDsl` (no warning reporting). Compiles DSL; if errors exist, calls `tryRepair()` once and returns the repaired DSL.

### Exported functions

#### `generateCustomLayerCatalog(session, input, opts?)`

```typescript
export async function generateCustomLayerCatalog(
  session: ProviderSession,
  input: {
    prompt: string;
    intentSummary?: string;
    answers: CustomAnswer[];
  },
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<CustomLayerCatalog>
```

LLM call that produces a `CustomLayerCatalog` from a free-form description. System prompt instructs the LLM:
- Domain is open-ended (software, workflow, org chart, lifecycle, narrative, etc.)
- 3–8 distinct, cohesive layers
- Each layer: Title Case name, 1–2 sentence description, color from palette, icon, 4–8 `key_elements`, `boundary_deps`
- Also define `cross_layer_edges` between layers

Assembles user message from `prompt`, optional `intentSummary`, and `formatAnswers(answers)`. Uses `chatStructuredWithRetry` with `CUSTOM_LAYER_CATALOG_JSON_SCHEMA` and `CustomLayerCatalogSchema` for validation.

---

#### `promptOverviewDslFromCatalog(catalog)`

```typescript
export function promptOverviewDslFromCatalog(catalog: CustomLayerCatalog): string
```

Deterministic. Converts a `CustomLayerCatalog` to an overview DSL string using the same algorithm as `overviewDslFromCatalog` in `multilayer.ts`, but sourcing surface nodes from `layer.key_elements` instead of file paths.

---

#### `runCustomMultiLayerPlan(input, send)`

```typescript
export async function runCustomMultiLayerPlan(
  input: CustomMultiLayerInput,
  send: (ev: SseEvent) => void,
): Promise<MultiLayerOutput | null>
```

5-stage pipeline (no repo scan):

| # | stage id | action |
|---|---|---|
| 1 | `validate` | `validateWithRetry()` |
| 2 | `layer-plan` | `generateCustomLayerCatalog()` |
| 3 | `overview` | `promptOverviewDslFromCatalog()` + `validateAndRepairDsl()` |
| 4 | `sub-plans` | `generatePlanFromPrompt()` per layer (p-limit 2) + `planToDsl()` + `validateAndRepairDsl()` |
| 5 | `instruction` | `generateInstructionGuide()` (if `instructionMode`) |

For each sub-layer, constructs a `layerPrompt` that includes the layer name/description, its `key_elements`, `boundary_deps`, boundary interface instruction, and the first 600 characters of the original prompt for context.

On per-layer error, falls back to a hand-crafted DSL group listing `key_elements` directly.

---

## Module: `lib/agent/customPipeline.ts`

### Purpose

Implements the two-step **Custom Prompt (single diagram)** pipeline. Step 1 (`runClarify`) generates clarifying MCQs; Step 2 (`runCustomPlan`) generates the diagram from the answers.

### Exported interfaces

#### `ClarifyInput`

```typescript
export interface ClarifyInput {
  session: ProviderSession;
  prompt: string;
  signal?: AbortSignal;
}
```

#### `CustomPlanInput`

```typescript
export interface CustomPlanInput {
  session: ProviderSession;
  prompt: string;
  intentSummary?: string;
  answers: CustomAnswer[];
  instructionMode?: boolean;
  signal?: AbortSignal;
}
```

### Exported functions

#### `runClarify(input, send)`

```typescript
export async function runClarify(
  input: ClarifyInput,
  send: (ev: SseEvent) => void,
): Promise<ClarifyingQuestions | null>
```

2-stage pipeline:
1. `validate` — `validateWithRetry()`
2. `clarify` — `generateClarifyingQuestions()`

On success emits `result-clarify { output: ClarifyingQuestions }` then `done`.

---

#### `runCustomPlan(input, send)`

```typescript
export async function runCustomPlan(
  input: CustomPlanInput,
  send: (ev: SseEvent) => void,
): Promise<{ dsl: string }>
```

4-stage pipeline:
1. `validate` — `validateWithRetry()`
2. `plan` — `generatePlanFromPrompt()` → `DiagramPlan`
3. `compile` — `planToDsl(plan)` → DSL string
4. `validate-dsl` — `compile(dsl)`; if errors → `tryRepair()` (max 2 attempts)
5. `instruction` — `generateInstructionGuide()` (if `instructionMode`)

Emits `result { dsl, instructionMarkdown? }` then `done`. Returns `{ dsl: '' }` on validation failure (does not throw).

---

## Module: `lib/agent/customPrompt.ts`

### Purpose

Contains the two LLM call functions used by both the custom single-diagram and custom multi-layer pipelines, plus `generateInstructionGuide` for Instruction Mode.

### Exported types

#### `ClarifyingQuestion`

```typescript
export type ClarifyingQuestion = {
  id: string;
  question: string;
  rationale: string;          // Why this matters for the diagram
  options: Array<{
    label: string;            // Short option label (1-6 words)
    description: string;      // 1 sentence on what selecting this means
  }>;
  allow_multiple: boolean;
};
```

#### `ClarifyingQuestions`

```typescript
export type ClarifyingQuestions = {
  intent_summary: string;     // 1-2 sentence paraphrase of user's intent
  questions: ClarifyingQuestion[];
};
```

Schema constraints: 3–6 questions, each with 2–5 options.

#### `CustomAnswer`

```typescript
export interface CustomAnswer {
  question_id: string;
  question: string;
  selected_options: string[];
  custom_text?: string;
}
```

Serialisation of one user answer to a clarifying question. `selected_options` contains display labels. `custom_text` is the free-text "Other" value if provided.

### Internal constants

#### `CLARIFY_JSON_SCHEMA`

Raw JSON Schema object for `ClarifyingQuestions`. Used when calling providers that support structured JSON output.

#### `PLAN_JSON_SCHEMA`

Raw JSON Schema object for `DiagramPlan`. Constrains `kind` to `['fwd', 'bwd', 'bi', 'dashed', 'thick']` and each color to the 15-item `COLORS` array.

#### `INSTRUCTION_MODE_SYSTEM_PROMPT`

```typescript
export const INSTRUCTION_MODE_SYSTEM_PROMPT: string
```

A 4-section Markdown system prompt for the Instruction Mode LLM call. Hard rules: no preamble, no filler phrases, no optional-add-on sections. Required sections: (1) High-Level Context, (2) Diagram Overview, (3) Step-by-Step Build Guide, (4) Examples and Notes. Enforces operational, concrete language.

### Exported functions

#### `formatAnswers(answers)`

```typescript
export function formatAnswers(answers: CustomAnswer[]): string
```

Formats a `CustomAnswer[]` as a numbered human-readable list for inclusion in LLM prompts. Returns `'(no answers provided — infer reasonable defaults from the prompt)'` for an empty array.

---

#### `generateClarifyingQuestions(session, prompt, opts?)`

```typescript
export async function generateClarifyingQuestions(
  session: ProviderSession,
  prompt: string,
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<ClarifyingQuestions>
```

One LLM call. System prompt instructs:
- Domain is open-ended (not assumed to be software)
- 4–6 MCQs that cover: diagram type/structure, audience, level of detail, emphasis/omission, domain-specific axes
- 2–5 options per question; UI appends an "Other" sentinel automatically
- `allow_multiple: true` when user could reasonably choose multiple options
- Avoid yes/no questions; prefer comparative options

Uses `chatStructuredWithRetry` with `CLARIFY_JSON_SCHEMA` and `ClarifyingQuestionsSchema`.

---

#### `generatePlanFromPrompt(session, input, opts?)`

```typescript
export async function generatePlanFromPrompt(
  session: ProviderSession,
  input: {
    prompt: string;
    intentSummary?: string;
    answers: CustomAnswer[];
  },
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<DiagramPlan>
```

One LLM call producing a `DiagramPlan` (the same schema used by the repo-scanner pipeline). System prompt rules:
- Domain is not necessarily software
- 3–10 top-level groups with concrete entities/steps inside each
- Edge kinds: `fwd` by default, `bi` for bidirectional, `thick` for primary paths, `dashed` for optional/weak links
- Stable, short, human-readable node names
- Scale: 15–30 nodes for overview, up to 90 for detailed
- **Critical edge limit**: total edges must stay below 60 to avoid ELK layout crash

Uses `chatStructuredWithRetry` with `PLAN_JSON_SCHEMA` and `DiagramPlanSchema`.

---

#### `generateInstructionGuide(session, input, opts?)`

```typescript
export async function generateInstructionGuide(
  session: ProviderSession,
  input: {
    prompt: string;
    intentSummary?: string;
    answers: CustomAnswer[];
    diagramStyle: 'single' | 'multi-layer';
    diagramContext?: string;
  },
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<string>
```

One LLM call producing a Markdown string. Uses `chatWithRetry` (not structured output) because the result is free-form Markdown, not JSON. System prompt is `INSTRUCTION_MODE_SYSTEM_PROMPT`. User message includes original prompt, restated intent, formatted answers, and diagram output context. Returns the trimmed raw string.

---

## Module: `lib/agent/splitLayer.ts`

### Purpose

**Purely deterministic** (no LLM calls). Splits a compiled `Diagram` IR that exceeds ELK's complexity limit into 2–10 `LayerDiagram` sub-partitions. Used when the renderer encounters an ELK crash on a large layer.

### Exported functions

#### `splitDiagramIntoLayers(diagram, baseLayerName)`

```typescript
export function splitDiagramIntoLayers(
  diagram: Diagram,
  baseLayerName: string,
): LayerDiagram[]
```

**Parameters:**
- `diagram` — Compiled IR with `roots`, `groups`, `nodes`, `edges`, `meta` populated.
- `baseLayerName` — Display name of the current layer (e.g. `"Frontend and UX Flow"`).

**Returns:** Array of `LayerDiagram` objects with names `"${baseLayerName} #N"`.

**Algorithm:**
1. If `roots.length < 2`, returns a single-element array with the original formatted DSL.
2. Computes `complexityScore` using `diagramComplexity(diagram)` from `lib/layout/constants`.
3. Calculates `k = clamp(ceil(score / ELK_COMPLEXITY_LIMIT), 2, min(10, roots.length))`.
4. Distributes `roots` across `k` buckets round-robin (`roots[i] → buckets[i % k]`).
5. For each non-empty bucket:
   a. Recursively collects all descendant IDs via `collectDescendants()`.
   b. Builds a `subDiagram` with filtered `groups`, `nodes`, edges where **both** endpoints are in `allIds`, and roots filtered to this partition's root set.
   c. Detects cross-partition edges (one endpoint inside, one outside) and emits them as `// cross-ref: SrcName → TgtName (other partition)` DSL comments.
   d. Serialises with `formatDiagram(subDiagram)` and appends the cross-ref block.
6. Returns the array.

### Internal functions

#### `collectDescendants(diagram, id, out)`

```typescript
function collectDescendants(diagram: Diagram, id: string, out: Set<string>): void
```

Recursive DFS. Adds `id` to `out`; if `id` is a group, recurses into `group.children`. Terminates at leaf nodes.

---

## Module: `lib/agent/dslCompiler.ts` (agent-side)

### Purpose

**Deterministic, no LLM.** Converts a `DiagramPlan` (the structured JSON output from the planner) into a DSL string for the renderer.

### Internal functions

#### `fmtProps(entries)`

```typescript
function fmtProps(entries: Array<[string, string]>): string
```

Formats a property list as a bracketed DSL attribute string: `" [key: value, key: value]"`. Returns empty string if `entries` is empty.

---

#### `edgeOp(kind)`

```typescript
function edgeOp(kind: DiagramPlan['edges'][number]['kind']): string
```

Maps edge kind to DSL operator. Same mapping as the multilayer module.

---

#### `writeGroup(g, indent)` (closure inside `planToDsl`)

Recursively emits a group block with its children. Traverses `g.children` by name — looks up each child first in `plan.groups` (recurse as nested group), then in `plan.nodes` (emit as leaf). Uses `fmtProps` for the attribute list.

### Exported functions

#### `planToDsl(plan)`

```typescript
export function planToDsl(plan: DiagramPlan): string
```

**Parameters:** `DiagramPlan` from `planner.ts`.
**Returns:** Multi-line DSL string.

**Algorithm:**
1. Emits optional `// ${plan.title}` header comment.
2. Groups nodes and groups by their `parent` value using two `Map<string|null, …>` objects.
3. Emits all top-level groups (parent = null) via `writeGroup()`.
4. Collects emitted child names from top-level groups (to avoid double-emission).
5. Emits orphan nodes (parent = null, not already emitted as group children).
6. Emits `// ==== Connections ====` section with one line per edge: `source OPERATOR target: label`.
7. Emits `// ==== Notes ====` section with `// uncertain:` and `// omitted:` comments.

---

## Module: `lib/agent/requestValidation.ts`

### Purpose

Shared Zod preprocessing utilities for API route validation.

### Exports

#### `optionalUrl`

```typescript
export const optionalUrl = z.preprocess(blankStringToUndefined, z.string().url().optional());
```

A Zod schema that:
- Preprocesses empty/blank strings to `undefined` (so an empty `repoUrl` from the UI does not fail URL validation).
- Validates the value as a URL if present.
- Makes the field optional.

Used in all routes that accept a `repoUrl` field (analyze, multilayer, repo/scan, etc.).

### Internal functions

#### `blankStringToUndefined(value)`

```typescript
function blankStringToUndefined(value: unknown): unknown
```

Returns `undefined` if `value` is a string consisting only of whitespace. Otherwise passes through unchanged.

---

## Module: `lib/agent/provider-models.ts`

### Purpose

Centralised registry of supported model names and environment variable mappings for each provider.

### Exports

#### Model lists (const arrays)

```typescript
export const OPENAI_MODELS = ['gpt-5.5', 'gpt-5.3-codex', 'gpt-5.4-mini', 'gpt-4o', 'gpt-5-nano'] as const;
export const ANTHROPIC_MODELS = ['opus-4.7', 'sonnet-4.6', 'haiku-4.5'] as const;
export const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'] as const;
export const GROK_MODELS = ['grok-3', 'grok-3-mini', 'grok-2-1212', 'grok-2-vision-1212'] as const;
```

#### `PROVIDER_DEFAULTS`

```typescript
export const PROVIDER_DEFAULTS: Record<ProviderId, string> = {
  openai: 'gpt-5.5',
  anthropic: 'opus-4.7',
  gemini: 'gemini-2.5-flash',
  foundry: '',           // No sensible universal default for Foundry deployments
  grok: 'grok-3',
};
```

#### `PROVIDER_MODEL_ENV`

```typescript
export const PROVIDER_MODEL_ENV: Record<ProviderId, string> = {
  openai: 'OPENAI_MODEL',
  anthropic: 'CLAUDE_MODEL',
  gemini: 'GEMINI_MODEL',
  foundry: 'FOUNDRY_MODEL',
  grok: 'GROK_MODEL',
};
```

Maps each provider to the environment variable that overrides its default model.

#### `getProviderDefaultModel(provider)`

```typescript
export function getProviderDefaultModel(provider: ProviderId): string
```

Returns the effective default model for a provider. Reads `PROVIDER_MODEL_ENV[provider]` from `process.env`; if set and non-empty, returns that value. Otherwise falls back to `PROVIDER_DEFAULTS[provider]`.

---

## AI Provider System

### Provider Abstraction (`providers/types.ts`, `providers/index.ts`)

#### Core types (`types.ts`)

##### `ProviderId`

```typescript
export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'foundry' | 'grok';
```

Union of all supported LLM backend identifiers.

##### `ChatMessage`

```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
```

##### `ChatParams`

```typescript
export interface ChatParams {
  messages: ChatMessage[];
  model: string;
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}
```

`jsonSchema` is a raw JSON Schema object for structured output. Each provider adapter translates this to its native equivalent (tool-use for Anthropic, `response_format` for OpenAI/Grok/Foundry, `responseMimeType` + `responseSchema` for Gemini).

##### `ValidationResult`

```typescript
export interface ValidationResult {
  ok: boolean;
  error?: string;
}
```

##### `RetryNotice`

```typescript
export interface RetryNotice {
  attempt: number;
  delayMs: number;
  reason: string;
}
```

##### `ProviderConfig`

```typescript
export interface ProviderConfig {
  apiKey: string;
  endpoint?: string;
}
```

##### `Provider`

```typescript
export interface Provider {
  id: ProviderId;
  validate(model: string): Promise<ValidationResult>;
  chat(params: ChatParams): Promise<string>;
}
```

The minimal interface all provider classes implement.

##### `RetryListener`

```typescript
export type RetryListener = (notice: RetryNotice) => void;
```

Callback invoked on each retry. Used to drive UI countdown animations.

---

#### Provider index (`providers/index.ts`)

##### `PROVIDER_ENV`

```typescript
export const PROVIDER_ENV: Record<ProviderId, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'CLAUDE_API_KEY',
  gemini: 'GEMINI_API_KEY',
  foundry: 'FOUNDRY_API_KEY',
  grok: 'GROK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
};
```

Maps each provider to the environment variable that holds its API key.

##### `ProviderSession`

```typescript
export interface ProviderSession {
  id: ProviderId;
  model: string;
  endpoint?: string;
  apiKey: string;
}
```

A resolved, call-ready session object passed through every pipeline. Created by API routes from request body + environment variables.

##### `getDefaultProvider()`

```typescript
export function getDefaultProvider(): ProviderId
```

Reads `CODOPTIC_DEFAULT_PROVIDER` env var (lowercased) and returns it if it matches a known `ProviderId`. Falls back to `'openai'`.

##### `makeProvider(id, cfg)`

```typescript
export function makeProvider(id: ProviderId, cfg: ProviderConfig): Provider
```

Factory function. Instantiates and returns the correct provider class for the given `ProviderId`. A `switch` statement over `id` maps each value to its class constructor.

##### `validateWithRetry(session, opts?)`

```typescript
export async function validateWithRetry(
  session: ProviderSession,
  opts: {
    signal?: AbortSignal;
    onRetry?: RetryListener;
  } = {},
): Promise<ValidationResult>
```

Wraps `provider.validate()` in `withRetry()`. The inner function:
1. Calls `provider.validate(session.model)`.
2. If `!result.ok`, constructs a `RetryError` with the error message. If that error passes `defaultIsRetryable`, throws it (causing a retry). Otherwise returns the failure result.
3. Returns the successful `ValidationResult`.

##### `chatWithRetry(session, messages, opts?)`

```typescript
export async function chatWithRetry(
  session: ProviderSession,
  messages: ChatMessage[],
  opts: {
    signal?: AbortSignal;
    onRetry?: RetryListener;
    jsonSchema?: Record<string, unknown>;
  } = {},
): Promise<string>
```

Wraps `provider.chat()` in `withRetry()`. Constructs `ChatParams` from `session.model`, `messages`, `opts.signal`, and `opts.jsonSchema`. Re-instantiates the provider on every attempt (stateless).

---

### Anthropic Provider (`providers/anthropic.ts`)

#### `AnthropicProvider`

```typescript
export class AnthropicProvider implements Provider {
  id = 'anthropic' as const;
  private client: Anthropic;
  constructor(cfg: ProviderConfig)
  async validate(model: string): Promise<ValidationResult>
  async chat(params: ChatParams): Promise<string>
}
```

**Constructor:** Creates an `Anthropic` SDK client with `apiKey` and optional `baseURL` (for custom endpoint).

**`validate(model)`:**
Makes a minimal `messages.create` call (`max_tokens: 8`, content `'ping'`). Returns `{ ok: true }` or `{ ok: false, error: message }`.

**`chat(params)`:**
1. Separates `system` messages (joined with `\n\n`) from `user`/`assistant` messages.
2. If `params.jsonSchema` is provided, uses the Anthropic **tool-use** pattern:
   - Adds a single tool `{ name: 'emit', description: 'emit structured output', input_schema: params.jsonSchema }`.
   - Sets `tool_choice: { type: 'tool', name: 'emit' }`.
   - Extracts `toolUse.input` from the response and returns `JSON.stringify(toolUse.input)`.
3. Otherwise concatenates all `TextBlock` content items and returns the string.
4. Always sets `max_tokens: 4096`.

---

### OpenAI Provider (`providers/openai.ts`)

#### `OpenAIProvider`

```typescript
export class OpenAIProvider implements Provider {
  id = 'openai' as const;
  private client: OpenAI;
  constructor(cfg: ProviderConfig)
  async validate(model: string): Promise<ValidationResult>
  async chat(params: ChatParams): Promise<string>
}
```

**Constructor:** Creates an `OpenAI` SDK client with `apiKey` and optional `baseURL`.

**`validate(model)`:**
Routes to `completions.create` (legacy endpoint) if `usesCompletionsEndpoint(model)` is true (i.e., the model name contains "codex"). Otherwise routes to `chat.completions.create`.

**`chat(params)`:**
1. Checks `usesCompletionsEndpoint(params.model)`. If true, converts the message array to a flat `ROLE:\ncontent` prompt via `toCompletionsPrompt()` and calls the legacy completions endpoint (`max_tokens: 4096` for structured, 2048 otherwise).
2. For chat completions:
   - If `params.jsonSchema`: sets `response_format: { type: 'json_schema', json_schema: { name: 'output', schema: …, strict: true } }`.
   - Returns `choices[0].message.content ?? ''`.

**Internal functions:**

`usesCompletionsEndpoint(model)` — Returns `true` if `model.toLowerCase()` contains `'codex'`.

`toCompletionsPrompt(messages, jsonSchema?)` — Formats messages as `ROLE:\ncontent` blocks separated by `\n\n`. Appends a JSON Schema instruction block if `jsonSchema` is provided. Ends with `ASSISTANT:\n` to prime completion.

---

### Gemini Provider (`providers/gemini.ts`)

#### `GeminiProvider`

```typescript
export class GeminiProvider implements Provider {
  id = 'gemini' as const;
  private client: GoogleGenerativeAI;
  constructor(cfg: ProviderConfig)
  async validate(model: string): Promise<ValidationResult>
  async chat(params: ChatParams): Promise<string>
}
```

**Constructor:** Creates a `GoogleGenerativeAI` client with `apiKey`. Note: Gemini does not support a custom `baseURL` through this SDK.

**`validate(model)`:**
Calls `generateContent('ping')` on the model. Returns `{ ok: true }` or `{ ok: false, error }`.

**`chat(params)`:**
1. Separates `system` messages and sets them as `systemInstruction`.
2. If `params.jsonSchema`:
   - Sets `generationConfig.responseMimeType = 'application/json'`.
   - Sets `generationConfig.responseSchema = toGeminiResponseSchema(params.jsonSchema)`.
3. Maps `assistant` → `'model'` role for Gemini's chat history format.
4. Uses `model.startChat({ history })` with all but the last message as history. Sends the last message via `chat.sendMessage(last.content)`.
5. Returns `res.response.text()`.

**Internal functions:**

`toGeminiResponseSchema(schema)` — Recursively strips `additionalProperties` keys (Gemini doesn't support them) and converts union `type: ['string', 'null']` arrays to `{ type: 'string', nullable: true }` (Gemini's nullable syntax).

---

### Grok Provider (`providers/grok.ts`)

#### `GrokProvider`

```typescript
export class GrokProvider implements Provider {
  id = 'grok' as const;
  private apiKey: string;
  private baseUrl: string;
  constructor(cfg: ProviderConfig)
  async validate(model: string): Promise<ValidationResult>
  async chat(params: ChatParams): Promise<string>
  private async callChat(params: ChatParams): Promise<string>
}
```

Does not use an SDK. Uses raw `fetch` to call xAI's OpenAI-compatible REST API.

**Default base URL:** `https://api.x.ai/v1`

**Constructor:** Resolves `baseUrl` from (in priority order): `cfg.endpoint`, `process.env.GROK_API_BASE`, `DEFAULT_BASE_URL`. Trims trailing slashes.

**`validate(model)`:**
Calls `callChat` with a minimal `ping` message.

**`chat(params)`:**
Delegates to `callChat(params)`.

**`callChat(params)`:**
1. POSTs to `${baseUrl}/chat/completions`.
2. If `params.jsonSchema`: adds `response_format: { type: 'json_schema', json_schema: { name: 'output', schema: …, strict: true } }`.
3. On non-OK response, calls `makeRetryError(res)` and throws.
4. Returns `json.choices[0].message.content ?? ''`.

**Internal functions:**

`normalizeUrl(value?)` — Trims and strips trailing slash from a URL string. Returns `''` if blank.

---

### Azure Foundry Provider (`providers/foundry.ts`)

#### `FoundryProvider`

```typescript
export class FoundryProvider implements Provider {
  id = 'foundry' as const;
  private apiKey: string;
  private endpoint: string;
  constructor(cfg: ProviderConfig)
  async validate(model: string): Promise<ValidationResult>
  async chat(params: ChatParams): Promise<string>
  private async callChat(params: ChatParams): Promise<string>
}
```

Uses Azure AI Foundry's OpenAI-compatible REST API. Does not use an SDK.

**Constructor:** Strips trailing slash from `cfg.endpoint`. Throws `Error('FoundryProvider requires endpoint URL')` if endpoint is empty.

**`validate(model)`:**
Calls `callChat` with a minimal `ping` message.

**`chat(params)`:**
Delegates to `callChat(params)`.

**`callChat(params)`:**
1. Constructs URL: `${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-08-01-preview`.
2. Authenticates with `api-key` header (Azure convention, not Bearer).
3. If `params.jsonSchema`: adds `response_format` with `json_schema` structure.
4. On non-OK response, throws `makeRetryError(res)`.
5. Returns `json.choices[0].message.content ?? ''`.

---

### Retry Logic (`providers/retry.ts`)

#### `RetryError`

```typescript
export interface RetryError extends Error {
  status?: number;
  retryAfterMs?: number;
  code?: string;
  headers?: Headers | Record<string, string | string[] | undefined>;
}
```

Extended `Error` that providers and the retry wrapper use to carry HTTP status, Retry-After, and network error codes.

#### `RetryOptions`

```typescript
export interface RetryOptions {
  signal?: AbortSignal;
  onRetry?: RetryListener;
  isRetryable?: (err: unknown) => boolean;
  baseDelayMs?: number;
  capDelayMs?: number;
}
```

#### `TRANSIENT_ERROR_CODES`

```typescript
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);
```

Node.js network error codes that are always retried.

#### `TRANSIENT_MESSAGE_RE`

```typescript
const TRANSIENT_MESSAGE_RE = /\b(?:5\d\d|server had an error|...)\b/i;
```

Regex that matches transient error indicators in error messages. Covers HTTP 5xx status codes in text, rate limit signals, gateway errors, timeout/socket keywords.

#### `defaultIsRetryable(err)`

```typescript
export function defaultIsRetryable(err: unknown): boolean
```

Returns `true` if the error is worth retrying. Checks (in order):
1. `err.status` is 429 (rate limit).
2. `err.status` is 500–599 (server error).
3. `err.code` is in `TRANSIENT_ERROR_CODES`.
4. `err` is a `TypeError` (network-level fetch failures).
5. `err.message` matches `TRANSIENT_MESSAGE_RE`.

`statusFromMessage(message)` is a helper that extracts a numeric HTTP status from a message string like `"500 The server had an error"`.

#### `withRetry<T>(fn, opts?)`

```typescript
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T>
```

Infinite retry loop with exponential backoff and jitter.

**Algorithm:**
1. Check `opts.signal?.aborted`; throw `AbortError` if already cancelled.
2. `await fn()`. On success, return immediately.
3. On error: if `!isRetryable(err)`, rethrow (non-retryable errors propagate immediately).
4. Increment `attempt`. Calculate delay:
   - `exponential = min(capDelayMs, baseDelayMs * 2^(attempt-1))` (base: 2000ms, cap: 60000ms)
   - `jittered = fromHeader ?? round(exponential * (0.5 + random * 0.5))` (50–100% of exponential)
   - If `Retry-After` header is present (`retryAfterMs` or parsed from `headers`), use that value directly.
5. Emit `opts.onRetry({ attempt, delayMs: jittered, reason })`.
6. `await delay(jittered, signal)` — abortable sleep.
7. Loop.

`reason` is set to `HTTP ${status}`, `err.code`, or the first 80 chars of `err.message`.

#### `makeRetryError(res)`

```typescript
export async function makeRetryError(res: Response): Promise<RetryError>
```

Constructs a `RetryError` from a failed `fetch` `Response`. Sets `err.status`, parses `Retry-After` header into `err.retryAfterMs` (seconds → ms), and appends the first 240 characters of the response body to the error message.

#### Internal `delay(ms, signal?)`

```typescript
function delay(ms: number, signal?: AbortSignal): Promise<void>
```

Returns a `Promise` that resolves after `ms` milliseconds. Rejects immediately with `AbortError` if `signal` is already aborted. Registers an abort listener to cancel the timeout early.

---

## API Routes

### POST `/api/agent/multilayer`

**File:** `app/api/agent/multilayer/route.ts`

**Runtime:** Node.js. `force-dynamic` to prevent caching of SSE streams.

**GET / HEAD:** Returns 405 with explanation.

#### Request body schema

```typescript
{
  provider: 'openai' | 'anthropic' | 'gemini' | 'foundry' | 'grok',
  model: string,
  apiKey?: string,
  endpoint?: string,
  rootPath?: string,
  allowSensitive?: boolean,
  focus?: string,                         // default ''
  topK?: number,                          // 10–200
  ignoredFolders?: string[],              // max 100 items
  quickMode?: boolean,                    // default false
  maxMode?: boolean,                      // default false
  instructionMode?: boolean,              // default false
  source?: {
    sourceType?: 'local' | 'github',
    repoPath?: string,
    repoUrl?: string,                     // optionalUrl — blank treated as absent
    authMode?: 'none' | 'pat',
    pat?: string,
  },
}
```

#### Response

`Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`.

SSE stream of `SseEvent` objects serialised as `data: <json>\n\n`.

**Error responses:**
- `400` — Zod validation failure or repo source resolution error.
- `401` — `RepoSourceError` with `code === 'PAT_REQUIRED'` (private GitHub repo without PAT).
- `400` — Missing API key.

**Processing:**
1. Validates body with Zod.
2. Resolves API key from body or `PROVIDER_ENV[provider]` env var.
3. Resolves `repoSource` via `resolveRepoSource()`.
4. Resolves `endpoint` from body, or `FOUNDRY_ENDPOINT`/`GROK_API_BASE` env vars.
5. Creates SSE stream with `makeSseStream()`.
6. Creates `AbortController`; bridges `req.signal` → `ac.signal`.
7. Calls `runMultiLayerPipeline()` as a fire-and-forget async task (errors caught and sent as SSE error events).
8. Returns the stream immediately.

---

### POST `/api/agent/custom-multilayer`

**File:** `app/api/agent/custom-multilayer/route.ts`

#### Request body schema

```typescript
{
  provider: ProviderId,
  model: string,
  apiKey?: string,
  endpoint?: string,
  prompt: string,             // min length 4
  intentSummary?: string,
  answers?: CustomAnswer[],   // max 20 items, default []
  instructionMode?: boolean,  // default false
}
```

#### Response

SSE stream identical format to multilayer. No GET/HEAD handlers (returns Next.js default 404 — unlike `/multilayer` which has explicit 405).

**Processing:** Same key steps as multilayer route, but calls `runCustomMultiLayerPlan()` instead.

---

### POST `/api/agent/analyze`

**File:** `app/api/agent/analyze/route.ts`

Single-diagram repo-scanner pipeline.

#### Request body schema

Adds `kind` field to the multilayer body:

```typescript
{
  ...multilayerBody,
  kind: 'architecture' | 'sequence' | 'class' | 'data-flow' | 'deployment',  // default 'architecture'
  topK?: number,  // 5–120 (vs multilayer's 10–200)
}
```

**Processing:** Calls `runPipeline()` (single-diagram pipeline, not documented here). Same SSE stream pattern. Explicit GET/HEAD 405 responses.

---

### POST `/api/agent/custom`

**File:** `app/api/agent/custom/route.ts`

Step 2 of the Custom Prompt flow. Generates a single diagram from prompt + answers.

#### Request body schema

```typescript
{
  provider: ProviderId,
  model: string,
  apiKey?: string,
  endpoint?: string,
  prompt: string,
  intentSummary?: string,
  answers?: CustomAnswer[],
  instructionMode?: boolean,
}
```

**Processing:** Calls `runCustomPlan()`. Explicit GET/HEAD 405 responses.

---

### POST `/api/agent/clarify`

**File:** `app/api/agent/clarify/route.ts`

Step 1 of the Custom Prompt flow. Generates clarifying MCQs.

#### Request body schema

```typescript
{
  provider: ProviderId,
  model: string,
  apiKey?: string,
  endpoint?: string,
  prompt: string,   // min length 4
}
```

**Processing:** Calls `runClarify()`. Explicit GET/HEAD 405 responses.

---

### POST `/api/agent/fix`

**File:** `app/api/agent/fix/route.ts`

Applies a user-described change to an existing DSL.

#### Request body schema

```typescript
{
  provider: ProviderId,
  model: string,
  apiKey?: string,
  endpoint?: string,
  dsl: string,                        // min length 1
  changeDescription: string,          // min length 4
  intentSummary?: string,
  answers?: CustomAnswer[],           // max 20 items
}
```

**Processing:** Calls `runFix()` from `lib/agent/fixPipeline`. Explicit GET/HEAD 405 responses.

---

### POST `/api/agent/fix-clarify`

**File:** `app/api/agent/fix-clarify/route.ts`

Step 1 of the AI Fix flow — generates clarifying MCQs about a requested change to an existing DSL.

#### Request body schema

```typescript
{
  provider: ProviderId,
  model: string,
  apiKey?: string,
  endpoint?: string,
  dsl: string,
  changeDescription: string,
}
```

**Processing:** Calls `runFixClarify()` from `lib/agent/fixPipeline`. Explicit GET/HEAD 405 responses.

---

### POST `/api/agent/repair`

**File:** `app/api/agent/repair/route.ts`

Standalone DSL repair endpoint. Validates and repairs DSL syntax errors without any diagram planning.

#### Request body schema

```typescript
{
  provider: ProviderId,
  model: string,
  apiKey?: string,
  endpoint?: string,
  dsl: string,
}
```

**Processing:**
1. Validates body.
2. Resolves API key and endpoint.
3. Builds `session`.
4. In an immediately-invoked async IIFE:
   a. `validate` stage — `validateWithRetry(session)`.
   b. `repair` stage — `tryRepair(session, dsl, { maxAttempts: 3 })`.
   c. Emits `result { dsl: result.dsl }` then `done`.
5. On error: emits `error` then `done`.
6. `finally: close()`.

Explicit GET/HEAD 405 responses.

---

### POST `/api/agent/validate`

**File:** `app/api/agent/validate/route.ts`

Synchronous (non-streaming) provider credential validation endpoint.

#### Request body schema

```typescript
{
  provider: ProviderId,
  model: string,
  apiKey?: string,
  endpoint?: string,
}
```

#### Response

`application/json` — `ValidationResult`:

```typescript
{ ok: boolean, error?: string }
```

**Processing:**
1. Validates body.
2. Resolves API key and endpoint.
3. Calls `makeProvider(cfg.provider, { apiKey, endpoint })`.
4. Calls `provider.validate(model)`.
5. Returns `NextResponse.json(result)`.

On error, returns `{ ok: false, error: message }`. Explicit GET/HEAD 405 responses.

---

### POST `/api/repo/scan`

**File:** `app/api/repo/scan/route.ts`

Scans a repository and returns file statistics without running any LLM calls.

#### Request body schema

```typescript
{
  path?: string,
  rootPath?: string,
  repoUrl?: string,
  pat?: string,
  source?: {
    sourceType?: 'local' | 'github',
    repoPath?: string,
    repoUrl?: string,
    authMode?: 'none' | 'pat',
    pat?: string,
  },
  allowSensitive?: boolean,
  ignoredFolders?: string[],
}
```

(`path` and `rootPath` are aliases; `path` takes precedence.)

#### GET response

`{ defaultPath: string }` — returns `defaultRepoPath()`.

#### POST response

```typescript
{
  sourceType: string,
  clonedFrom?: string,
  resolved: string,
  root: string,
  fileCount: number,
  totalBytes: number,
  byExt: Record<string, number>,
  manifests: string[],
  entrypoints: string[],
  apiRoutes: string[],
  components: string[],       // sliced to 80
  schemas: string[],
  configs: string[],
  infra: string[],
  tests: number,
  docs: string[],             // sliced to 30
  depHints: unknown,
  ignoredFolders: string[],
  likelyStack: string[],
}
```

**Error:** `401` with `{ error, code: 'PAT_REQUIRED' }` for private GitHub repos without a PAT.

---

### POST `/api/repo/directories`

**File:** `app/api/repo/directories/route.ts`

Lists directory entries for the folder browser UI.

#### Request body schema

```typescript
{
  rootPath?: string,
  parent?: string,
}
```

`rootPath` is passed through `resolveBrowsePath()` (security sandboxing). `parent` is a relative path within the browse root.

#### Response

```typescript
{
  root: string,
  resolved: string,
  prefix: string | undefined,
  parent: string,
  entries: Array<{
    name: string,
    path: string,            // relative to browse root, normalized separators
    type: 'dir' | 'file',
  }>,
  directories: Array<{ name: string; path: string }>,   // legacy alias, dirs only
}
```

**Filtering:** Uses `isHiddenByDefault(name, isDir)` to exclude hidden/system entries. Excludes the application's own directory (`SELF_ROOT`). When `browse.prefix` is set and `parent` is empty, restricts to directories starting with that prefix.

**Sorting:** Directories before files; alphabetical within each group.

**Error:** `400` for invalid path; `500` for filesystem errors.

---

## UI Components

### `MultiLayerPanel.tsx`

**File:** `components/multilayer/MultiLayerPanel.tsx`

**Type:** `'use client'` React function component.

#### Purpose

Renders the Multi-Layer mode configuration panel. Provides the user interface for configuring a provider, selecting a repository, setting pipeline options, and launching the multi-layer generation pipeline. Displays the `AnalysisAnimation` overlay during execution.

#### Store subscriptions (via `useDiagramStore`)

| selector | state used |
|---|---|
| `s.provider` | Current provider config (id, model, apiKey, endpoint, customModel) |
| `s.focusPrompt` | Focus/context text field value |
| `s.quickMode` | Quick Mode toggle state |
| `s.maxMode` | MAX Mode toggle state |
| `s.instructionMode` | Instruction/Document Mode toggle |
| `s.agentRunning` | Whether an agent pipeline is currently running |

#### Store actions (via `useDiagramStore`)

| action | called when |
|---|---|
| `setMaxMode` | MAX toggle changes |
| `setInstructionMode` | Document Mode toggle changes |
| `setInstructionMarkdown` | After `result-multilayer` event received |
| `setMode` | Switches to `'editor'` after result |
| `setDsl` | Sets overview DSL after result |
| `addGeneratedProject` | Persists result to project store |
| `setMultiLayer` | Stores `MultiLayerOutput` in global state |
| `setActiveLayer` | Sets active tab to `'overview'` after result |
| `setAgentStage` | Tracks current pipeline stage |
| `pushAgentLog` | Appends log entry |
| `startAgent` | Marks agent as running with a session ID |
| `stopAgent` | Marks agent as stopped |
| `clearOverrides` | Clears layout overrides after result |

#### Local state

| variable | type | description |
|---|---|---|
| `rootPath` | `string` | Resolved local path from `RepoInput` |
| `ignoredFolders` | `string[]` | Excluded folder list from `RepoInput` |
| `scanInfo` | `{ resolved: string; fileCount: number } \| null` | Populated after a successful scan preview |
| `repoSource` | `RepoSourceConfig` | Repository source descriptor |
| `retryNotice` | `{stage, attempt, delayMs, reason} \| null` | Current retry being displayed |
| `counters` | `Record<string, number>` | Stage progress counters (files, layers, etc.) |
| `terminalState` | `{status: 'failed'\|'cancelled', message} \| null` | Terminal error/cancellation state |

#### Refs

`abortRef: RefObject<AbortController | null>` — Holds the `AbortController` for the current fetch. Set in `onStart`, cleared in finally block. Used by `onCancel`.

#### `onStart()` handler

```typescript
const onStart = async () => { ... }
```

1. Guards against missing `rootPath`.
2. Generates `sessionId = 'ml-' + Date.now()`.
3. Calls `startAgent(sessionId)`, resets local state.
4. Creates `AbortController`, stores in `abortRef`.
5. POSTs to `/api/agent/multilayer` with full config body.
6. On non-OK response or missing body: reads error via `readErrorMessage(res)`, sets `terminalState`.
7. On OK response: calls `readAgentStream(res.body, handleEvent)` to process the SSE stream.
8. On `AbortError`: sets `terminalState { status: 'cancelled' }`.
9. In `finally`: if no result and no explicit failure, sets generic failure terminal state. Calls `stopAgent()`. Clears `abortRef`.

**`handleEvent(ev: AgentStreamEvent)` (closure within `onStart`):**

| event type | action |
|---|---|
| `'stage'` | `setAgentStage(ev.stage)`, merge counters, push log |
| `'retry'` | `setRetryNotice(…)`, push warn log |
| `'log'` | `pushLog(…)` |
| `'error'` | Set `sawFailure`, `setTerminalState`, push error log |
| `'result-multilayer'` | Set `sawResult`, store `instructionMarkdown`, call `setMultiLayer(out)`, `clearOverrides()`, `setActiveLayer('overview')`, `setDsl(out.overview.dsl)`, `addGeneratedProject(…)`, `setMode('editor')` |
| `'done'` | `setAgentStage(null)` |

#### `onCancel()` handler

```typescript
const onCancel = () => abortRef.current?.abort();
```

Aborts the current `AbortController`, which cancels the fetch and propagates to the pipeline's `signal`.

#### Rendered structure

```
<>
  <div.grid> (2-column on large screens)
    <ProviderConfig />
    <RepoInput
      maxMode, onMaxModeChange,
      instructionMode, onInstructionModeChange,
      onConfigChange (updates rootPath, ignoredFolders, repoSource, clears scanInfo),
      onScan (updates all + sets scanInfo),
    />
    <div>  (description box — Multi-Layer mode explanation)
    <FocusPromptBox />
    <QuickModeToggle />
    <div.col-span-full>  (status bar + "Generate layered diagrams" button)
      Status text: shows resolved path, file count, ignored folder count,
                   provider/model, and active modes (Quick/MAX/Document)
      Button: disabled when !scanInfo || agentRunning
  </div.grid>

  {(agentRunning || terminalState) &&
    <AnalysisAnimation
      retryNotice, counters, onCancel, onDismiss, terminalState,
      stages=[validate, scan, classify, context, summarize, layers,
              overview, sub-plans, ?instruction]
    />
  }
</>
```

---

### `LayerNavigator.tsx`

**File:** `components/multilayer/LayerNavigator.tsx`

**Type:** `'use client'` React function component.

#### Purpose

Renders a horizontal tab bar at the top of the editor viewport for navigating between multi-layer diagrams. Always shows an "Overview" tab; one tab per generated layer. Each layer tab has an inline delete button. Switching tabs loads the layer's DSL into the editor.

#### Props

None. All state is sourced from the global diagram store.

#### Store subscriptions

| selector | state used |
|---|---|
| `s.multiLayer` | The `MultiLayerOutput` object (null → component returns null) |
| `s.activeLayer` | Currently active layer name (or `'overview'`) |

#### Store actions

| action | called when |
|---|---|
| `setActiveLayer(name)` | Tab clicked |
| `setDsl(dsl)` | Tab clicked (loads layer DSL into editor) |
| `clearOverrides()` | Tab clicked (removes drag/layout overrides from previous layer) |
| `removeLayer(name)` | Deletion confirmed |

#### Local state

| variable | type | description |
|---|---|---|
| `pendingDelete` | `string \| null` | Name of the layer awaiting deletion confirmation |

#### Early return

Returns `null` if `ml` (multiLayer) is falsy. This means the component is fully absent when not in multi-layer mode.

#### `select(name, dsl)` handler

```typescript
const select = (name: string, dsl: string) => {
  setActive(name);
  clearOverrides();
  setDsl(dsl);
};
```

Updates active layer, clears layout overrides, loads DSL.

#### `requestDelete(name)` handler

```typescript
const requestDelete = (name: string) => setPendingDelete(name);
```

Opens the confirmation dialog by setting `pendingDelete`.

#### `confirmDelete()` handler

```typescript
const confirmDelete = () => {
  if (!pendingDelete) return;
  const wasActive = active === pendingDelete;
  removeLayer(pendingDelete);
  if (wasActive) clearOverrides();
  setPendingDelete(null);
};
```

Removes the layer from the store. If the deleted layer was active, clears layout overrides (the store's `removeLayer` will have already switched active layer to the next available one). Closes dialog.

#### Rendered structure

```
<>
  <div.flex.overflow-x-auto>  (horizontal scrollable tab bar)
    <span>Layers</span>  (label)

    <button>Overview</button>  (never deletable; active style when active === 'overview')

    {ml.layers.map(l => (
      <span.group key={l.name}>
        <button>  (layer name; left-rounded; title=description)
        <button>  (X delete; right-rounded; opacity-0, group-hover:opacity-100)
      </span>
    ))}
  </div>

  <ConfirmDialog
    open={pendingDelete !== null}
    title="Delete layer"
    message={`Delete "${pendingDelete}" permanently? ...`}
    confirmLabel="Delete layer"
    onConfirm={confirmDelete}
    onCancel={() => setPendingDelete(null)}
  />
</>
```

The active tab uses `border-accent/60 bg-accent/15 text-ink-100` styling. Inactive tabs use `border-ink-700 bg-ink-800 text-ink-300`. The delete button on the active layer transitions to `hover:bg-red-500/20 hover:text-red-300`.

---

## End-to-End Flow: Multi-Layer Mode (Repo-Based)

This is the complete trace of a successful multi-layer generation starting from user action in the browser.

### Step 1: UI configuration

The user opens the **Multi-Layer** tab in the application. `MultiLayerPanel` renders. The user:
1. Configures provider (selects provider type, enters API key, selects model) via `ProviderConfig`.
2. Configures repository source via `RepoInput` (local path, GitHub URL, or PAT-protected repo). Clicks "Preview" which calls `POST /api/repo/scan` to validate the path and get file counts. `setScanInfo()` is called on success.
3. Optionally sets a `FocusPromptBox` value (e.g., "authentication and authorization flows").
4. Optionally toggles Quick Mode, MAX mode, or Document Mode.
5. Clicks "Generate layered diagrams".

### Step 2: Request dispatched

`onStart()` fires:
- Creates `AbortController`, stores in `abortRef`.
- `startAgent('ml-<timestamp>')` — sets `agentRunning = true` in store.
- `AnalysisAnimation` becomes visible.
- POSTs JSON to `/api/agent/multilayer`.

### Step 3: Route handler

`POST /api/agent/multilayer/route.ts`:
1. Parses body with Zod `Body` schema.
2. Resolves API key from body or env.
3. `resolveRepoSource()` — for `local` sourceType, validates the path exists and is within the security-allowed browse root. For `github`, clones the repo to a temp directory.
4. Creates SSE stream with `makeSseStream()`.
5. Bridges `req.signal` → `ac.signal`.
6. Fires `runMultiLayerPipeline(…, send)` as a background task (not awaited in the response path).
7. Returns the `ReadableStream` immediately with SSE headers.

### Step 4: Pipeline execution (`runMultiLayerPipeline`)

**Stage: validate**
`validateWithRetry()` → `makeProvider()` → `provider.validate(model)` — makes a minimal LLM API call (8 tokens, content `'ping'`). If OK, emits `{ type: 'stage', stage: 'validate', status: 'done' }`.

**Stage: scan**
`scanResolvedRepoSource(repoSource, { allowlist: AGENT_FILE_ALLOWLIST })` — walks the filesystem tree applying the allowlist extension filter, respecting `ignoredFolders`. Returns a `RepoMap` with categorised file lists.

**Stage: classify**
`classifyRelevance(repoMap, 'architecture', focus, relevantCap)` — scores each file by relevance heuristics (extension, path, imports, content). `relevantCap = maxMode ? all files : topK ?? 80`.

**Stage: context**
Runs in parallel:
- `readDocPriors(repoMap)` — reads README, CONTRIBUTING, doc files.
- `extractImportGraph(repoMap.root, filePaths, { maxFiles: 800 })` — builds a static import dependency graph.
Then `buildRepoContext(repoMap, importGraph)` — derives folder clusters, external dep counts.

**Stage: summarize**
If `quickMode`: skips to `quickAnalysisDigest()` (structural digest only, no LLM).
Otherwise: `analyzeRelevantFiles()` — for each relevant file, calls the LLM to produce a 1–3 sentence architectural summary. Emits `summarize` progress events with `{ done, total }` counters.

**Stage: layers**
`identifyLayers(session, { repoMap, summaries, imports, docs, repoContext, analysisDigest, kind: 'architecture', focus })` — single LLM call returning a `LayerCatalog` JSON with 3–10 layers. Each layer has `name`, `description`, `color`, `icon`, `member_files`, `representative_files`, `boundary_deps`. Also includes `cross_layer_edges`.

**Stage: overview**
`overviewDslFromCatalog(catalog)` — deterministic DSL generation (no LLM). Then `validateDsl()` — compile and optionally repair with LLM.

**Stage: sub-plans** (parallel, p-limit 2)
For each layer in `catalog.layers`:
1. `selectLayerContextSummaries(layer, summaries, importGraph, { min: 8, max: 35 })` — picks the most relevant file summaries for this layer.
2. `generatePlan(session, { repoMap, summaries: used, …, focus: 'Layer "${layer.name}" - ${layer.description}. Show internal structure…' })` — LLM returns a `DiagramPlan`.
3. `planToDsl(plan)` — deterministic conversion to DSL string.
4. `validateDsl()` — compile and repair.
5. Returns `{ name: layer.name, description: layer.description, dsl }`.
On error: falls back to `fallbackLayerDsl(layer)`.

**Stage: instruction** (only if `instructionMode`)
`generateInstructionGuide(session, { prompt, intentSummary, answers, diagramStyle: 'multi-layer', diagramContext })` — generates a Markdown implementation guide using `chatWithRetry` with `INSTRUCTION_MODE_SYSTEM_PROMPT`.

**Emit result:**
```typescript
send({ type: 'result-multilayer', output: { overview, layers, generatedAt }, instructionMarkdown });
send({ type: 'done' });
```

### Step 5: Client receives SSE events

`readAgentStream(res.body, handleEvent)` — processes the SSE stream line by line.

- `stage` events → `setAgentStage()` + merge counters + `pushLog()` (drives `AnalysisAnimation`)
- `retry` events → `setRetryNotice()` (drives countdown display in animation)
- `log` events → `pushLog()`
- `result-multilayer` → stores result and switches UI mode:
  - `setInstructionMarkdown(ev.instructionMarkdown)`
  - `setMultiLayer(ev.output)` — stores `MultiLayerOutput` in Zustand store
  - `clearOverrides()` — clears any stale drag/layout overrides
  - `setActiveLayer('overview')` — selects the overview tab
  - `setDsl(out.overview.dsl)` — loads overview DSL into the editor
  - `addGeneratedProject(projectName, dsl, out, instructionMarkdown)` — persists to IndexedDB
  - `setMode('editor')` — switches the app to editor view
- `done` → `setAgentStage(null)`

### Step 6: Editor renders

The app switches to editor mode. `LayerNavigator` renders at the top of the editor because `multiLayer` is now non-null.

The editor loads `out.overview.dsl` into the Monaco editor and renders the overview diagram via the DSL compiler → ELK layout → renderer pipeline.

### Step 7: Layer navigation

The user clicks a layer tab in `LayerNavigator`:
1. `select(l.name, l.dsl)` fires.
2. `setActiveLayer(l.name)` updates the active tab indicator.
3. `clearOverrides()` removes any drag positions from the previous layer.
4. `setDsl(l.dsl)` loads the sub-layer DSL into the editor and triggers re-render.

### Step 8: Layer deletion (optional)

The user hovers over a layer tab, sees the X button, clicks it:
1. `requestDelete(l.name)` opens the `ConfirmDialog`.
2. User confirms → `confirmDelete()`:
   - `removeLayer(l.name)` removes from store.
   - If the deleted layer was active, `clearOverrides()` clears leftover overrides (store switches active to next layer automatically).
3. `LayerNavigator` re-renders without the deleted tab.

---

*End of technical reference.*

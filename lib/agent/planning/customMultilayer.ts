/**
 * Custom-Prompt multi-layer pipeline.
 *
 * Generates an overview + per-layer diagram set from a free-form
 * description + clarifying answers. No repo scanning needed — the LLM
 * builds the layer plan entirely from the user's text.
 *
 * Steps:
 *   1. Validate provider
 *   2. Generate a layer catalog (3-8 layers) from prompt + answers
 *   3. Compile a deterministic overview DSL from the catalog
 *   4. Generate one focused sub-diagram per layer (parallel, p-limit 6)
 *   5. Emit result-multilayer
 *
 * Reuses MultiLayerOutput / LayerDiagram from the store so the
 * LayerNavigator in editor mode works without any extra wiring.
 */

import pLimit from 'p-limit';
import { z } from 'zod';
import type { ProviderSession, RetryListener } from '../providers';
import { validateWithRetry } from '../providers';
import { chatStructuredWithRetry } from './structuredOutput';
import { generateInstructionGuide, generatePlanFromPrompt, formatAnswers, type CustomAnswer } from './customPrompt';
import { planToDsl } from './dslCompiler';
import { tryRepair } from './repair';
import { compile } from '../../dsl/compiler';
import type { SseEvent } from '../../util/stream';
import type { LayerDiagram, MultiLayerOutput } from '../../state/store';
import { COLOR_NAMES } from '../../ir/types';
import { knownIconNames } from '../../icons/registry';

// =========================================================================
// Layer catalog for prompt-based flow
// =========================================================================

const COLORS = [
  'orange', 'green', 'yellow', 'amber', 'coral', 'teal', 'slate',
  'indigo', 'blue', 'purple', 'lime', 'sky', 'red', 'pink', 'gray',
];

const CUSTOM_LAYER_CATALOG_JSON_SCHEMA = {
  type: 'object',
  properties: {
    layers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          color: { type: 'string', enum: COLORS },
          icon: { type: 'string' },
          key_elements: {
            type: 'array',
            items: { type: 'string' },
            description: '4-8 main components, entities, steps, or nodes in this layer',
          },
          boundary_deps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names of other layers or external systems this layer connects to',
          },
        },
        required: ['name', 'description', 'color', 'icon', 'key_elements', 'boundary_deps'],
        additionalProperties: false,
      },
    },
    cross_layer_edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          kind: { type: 'string', enum: ['fwd', 'bwd', 'bi', 'dashed', 'thick'] },
          label: { type: ['string', 'null'] },
        },
        required: ['source', 'target', 'kind', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: ['layers', 'cross_layer_edges'],
  additionalProperties: false,
};

const CustomLayerCatalogSchema = z.object({
  layers: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        color: z.string(),
        icon: z.string(),
        key_elements: z.array(z.string()).min(2).max(10),
        boundary_deps: z.array(z.string()),
      }),
    )
    .min(3)
    .max(8),
  cross_layer_edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      kind: z.enum(['fwd', 'bwd', 'bi', 'dashed', 'thick']),
      label: z.string().nullable().optional(),
    }),
  ),
});

export type CustomLayerCatalog = z.infer<typeof CustomLayerCatalogSchema>;

const ICON_GUIDANCE = `Available icons: ${knownIconNames().join(', ')}.`;
const COLOR_GUIDANCE = `Color palette: ${COLOR_NAMES.join(', ')}. Use a distinct color per layer.`;

export async function generateCustomLayerCatalog(
  session: ProviderSession,
  input: {
    prompt: string;
    intentSummary?: string;
    answers: CustomAnswer[];
  },
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<CustomLayerCatalog> {
  const userMsg = [
    `## Description`,
    input.prompt.trim(),
    '',
    input.intentSummary ? `## Restated intent\n${input.intentSummary}` : '',
    '',
    `## Clarifying answers`,
    formatAnswers(input.answers),
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    {
      role: 'system' as const,
      content:
        `You are a diagram architect decomposing a described system, process, or concept into 3-8 distinct LAYERS for a multi-layer diagram. ` +
        `Each layer must be cohesive (one concern or phase), clearly distinct from others, and substantial enough to deserve its own sub-diagram. ` +
        `The domain is open-ended — it could be software, a workflow, a lifecycle, an org structure, a narrative, a user journey, a business process, etc. Do NOT assume code. ` +
        `For each layer provide: a short Title Case name, a 1-2 sentence description, a color, an icon, ` +
        `4-8 key_elements (the main components / entities / steps / nodes that belong here — short readable labels), ` +
        `and boundary_deps (names of other layers or external systems this layer directly connects to). ` +
        `Also define cross_layer_edges that capture how data, control, or relationships flow BETWEEN layers (not inside). ` +
        `Output JSON strictly matching the schema; no prose outside it.\n\n` +
        ICON_GUIDANCE + '\n\n' + COLOR_GUIDANCE,
    },
    { role: 'user' as const, content: userMsg },
  ];

  return chatStructuredWithRetry(session, messages, {
    signal: opts.signal,
    onRetry: opts.onRetry,
    jsonSchema: CUSTOM_LAYER_CATALOG_JSON_SCHEMA,
    schema: CustomLayerCatalogSchema,
  });
}

// =========================================================================
// Overview DSL from catalog
// =========================================================================

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

function edgeOp(kind: 'fwd' | 'bwd' | 'bi' | 'dashed' | 'thick'): string {
  return kind === 'fwd' ? '>' : kind === 'bwd' ? '<' : kind === 'bi' ? '<>' : kind === 'dashed' ? '--' : '=>';
}

export function promptOverviewDslFromCatalog(catalog: CustomLayerCatalog): string {
  const lines: string[] = ['// Overview — multi-layer diagram', ''];
  const layerDslNames = new Map<string, string>();
  const usedLayerNames = new Set<string>();

  for (const layer of catalog.layers) {
    layerDslNames.set(layer.name, uniqueName(sanitizeDslName(layer.name, 'Layer'), usedLayerNames));
  }

  for (const layer of catalog.layers) {
    const layerDslName = layerDslNames.get(layer.name)!;
    lines.push(`${layerDslName} [color: ${layer.color}, icon: ${layer.icon}] {`);
    const usedElementNames = new Set<string>();
    for (const element of layer.key_elements.slice(0, 6)) {
      const elName = uniqueName(sanitizeDslName(element, 'Item'), usedElementNames);
      lines.push(`  ${elName} [color: ${layer.color}, icon: circle]`);
    }
    lines.push('}');
    lines.push('');
  }

  lines.push('// ==== Cross-layer flow ====');
  for (const e of catalog.cross_layer_edges) {
    const src =
      layerDslNames.get(e.source) ??
      layerDslNames.get(
        catalog.layers.find((l) => l.name.toLowerCase() === e.source.toLowerCase())?.name ?? '',
      );
    const tgt =
      layerDslNames.get(e.target) ??
      layerDslNames.get(
        catalog.layers.find((l) => l.name.toLowerCase() === e.target.toLowerCase())?.name ?? '',
      );
    if (!src || !tgt) continue;
    const label = e.label ? `: ${sanitizeDslName(e.label, 'flow')}` : '';
    lines.push(`${src} ${edgeOp(e.kind)} ${tgt}${label}`);
  }
  return lines.join('\n');
}

// =========================================================================
// DSL validation helper
// =========================================================================

async function validateAndRepairDsl(
  session: ProviderSession,
  dsl: string,
  send: (ev: SseEvent) => void,
  stage: string,
  onRetry: (s: string) => (n: { attempt: number; delayMs: number; reason: string }) => void,
  signal?: AbortSignal,
): Promise<string> {
  const compiled = compile(dsl);
  const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length === 0) return dsl;
  send({ type: 'log', stage, level: 'warn', message: `${errors.length} syntax errors — attempting repair` });
  const repaired = await tryRepair(session, dsl, { signal, onRetry: onRetry(`${stage}-repair`) });
  return repaired.dsl;
}

// =========================================================================
// Pipeline
// =========================================================================

export interface CustomMultiLayerInput {
  session: ProviderSession;
  prompt: string;
  intentSummary?: string;
  answers: CustomAnswer[];
  instructionMode?: boolean;
  signal?: AbortSignal;
}

export async function runCustomMultiLayerPlan(
  input: CustomMultiLayerInput,
  send: (ev: SseEvent) => void,
): Promise<MultiLayerOutput | null> {
  const onRetry = (stage: string) => (notice: { attempt: number; delayMs: number; reason: string }) => {
    send({ type: 'retry', stage, attempt: notice.attempt, delayMs: notice.delayMs, reason: notice.reason });
  };

  try {
    // 1. Validate
    send({ type: 'stage', stage: 'validate', status: 'start', message: 'Checking provider credentials…' });
    const v = await validateWithRetry(input.session, { signal: input.signal, onRetry: onRetry('validate') });
    if (!v.ok) {
      send({ type: 'error', stage: 'validate', message: v.error ?? 'Provider validation failed' });
      send({ type: 'done' });
      return null;
    }
    send({ type: 'stage', stage: 'validate', status: 'done', message: 'Provider ready' });

    // 2. Layer catalog
    send({ type: 'stage', stage: 'layer-plan', status: 'start', message: 'Planning layer structure…' });
    const catalog = await generateCustomLayerCatalog(
      input.session,
      { prompt: input.prompt, intentSummary: input.intentSummary, answers: input.answers },
      { signal: input.signal, onRetry: onRetry('layer-plan') },
    );
    send({
      type: 'stage',
      stage: 'layer-plan',
      status: 'done',
      message: `Identified ${catalog.layers.length} layers: ${catalog.layers.map((l) => l.name).join(', ')}`,
      counters: { layers: catalog.layers.length },
    });

    // 3. Overview DSL (deterministic from catalog key_elements)
    send({ type: 'stage', stage: 'overview', status: 'start', message: 'Compiling overview diagram…' });
    const rawOverview = promptOverviewDslFromCatalog(catalog);
    const overviewDsl = await validateAndRepairDsl(
      input.session,
      rawOverview,
      send,
      'overview',
      onRetry,
      input.signal,
    );
    send({ type: 'stage', stage: 'overview', status: 'done', message: 'Overview compiled' });

    // 4. Per-layer sub-diagrams (parallel, max 6 concurrent)
    send({ type: 'stage', stage: 'sub-plans', status: 'start', message: 'Generating per-layer diagrams…' });
    const layerLimit = pLimit(6);

    const subLayers: LayerDiagram[] = await Promise.all(
      catalog.layers.map((layer) =>
        layerLimit(async (): Promise<LayerDiagram> => {
          try {
            send({ type: 'log', stage: 'sub-plans', level: 'info', message: `planning layer: ${layer.name}` });

            const layerPrompt = [
              `Sub-diagram for the "${layer.name}" layer: ${layer.description}`,
              `Key elements in this layer: ${layer.key_elements.join(', ')}.`,
              `Boundary connections to other layers/systems: ${layer.boundary_deps.join(', ') || 'none'}.`,
              `Show the internal structure of this layer in detail. Include one-hop boundary nodes (shown dashed) where this layer interfaces with adjacent layers.`,
              `Broader context: ${input.prompt.slice(0, 600)}`,
            ].join(' ');

            const plan = await generatePlanFromPrompt(
              input.session,
              {
                prompt: layerPrompt,
                intentSummary: `Sub-diagram for the "${layer.name}" layer`,
                answers: [],
              },
              { signal: input.signal, onRetry: onRetry('sub-plan') },
            );

            const rawDsl = planToDsl(plan);
            const dsl = await validateAndRepairDsl(
              input.session,
              rawDsl,
              send,
              'sub-plans',
              onRetry,
              input.signal,
            );

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
              message: `${layer.name} failed; using fallback — ${message}`,
            });
            // Fallback: single group with key elements as nodes
            const safeName = sanitizeDslName(layer.name, 'Layer');
            const usedFallback = new Set<string>();
            const fallbackLines = [
              `// ${safeName} (fallback)`,
              '',
              `${safeName} [color: ${layer.color}, icon: ${layer.icon}] {`,
              ...layer.key_elements
                .slice(0, 8)
                .map((e, i) => `  ${uniqueName(sanitizeDslName(e, `Item ${i + 1}`), usedFallback)} [color: ${layer.color}, icon: circle]`),
              '}',
            ];
            return { name: layer.name, description: layer.description, dsl: fallbackLines.join('\n') };
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
      overview: { name: 'Overview', description: 'Multi-layer overview', dsl: overviewDsl },
      layers: subLayers,
      generatedAt: Date.now(),
    };

    let instructionMarkdown: string | undefined;
    if (input.instructionMode) {
      send({ type: 'stage', stage: 'instruction', status: 'start', message: 'Writing Instruction Mode guide…' });
      instructionMarkdown = await generateInstructionGuide(
        input.session,
        {
          prompt: input.prompt,
          intentSummary: input.intentSummary,
          answers: input.answers,
          diagramStyle: 'multi-layer',
        },
        { signal: input.signal, onRetry: onRetry('instruction') },
      );
      send({ type: 'stage', stage: 'instruction', status: 'done', message: 'Instruction guide ready' });
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

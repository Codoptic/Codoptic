/**
 * Intermediate Representation for Codoptic diagrams.
 * The DSL parser → AST → compiler produces a Diagram which is the
 * single shape consumed by layout, renderer, exporter, and the AI pipeline.
 */

export type ColorName =
  | 'orange'
  | 'green'
  | 'yellow'
  | 'amber'
  | 'coral'
  | 'teal'
  | 'cyan'
  | 'mint'
  | 'emerald'
  | 'slate'
  | 'zinc'
  | 'stone'
  | 'neutral'
  | 'white'
  | 'indigo'
  | 'blue'
  | 'purple'
  | 'violet'
  | 'fuchsia'
  | 'lime'
  | 'sky'
  | 'red'
  | 'rose'
  | 'pink'
  | 'gray';

export type DiagramKind = 'flow' | 'sequence' | 'class' | 'deployment' | 'data-flow';

export type EdgeKind = 'fwd' | 'bwd' | 'bi' | 'dashed' | 'thick';

export interface Point {
  x: number;
  y: number;
}

export interface Diagnostic {
  message: string;
  line: number;
  column: number;
  length?: number;
  severity: 'error' | 'warning' | 'info';
}

export interface Meta {
  kind: DiagramKind;
  title?: string;
  source: string;
  generatedAt?: number;
}

export interface IRGroup {
  id: string;
  name: string;
  parentId: string | null;
  color: ColorName | null;
  icon: string | null;
  label: string | null;
  collapsed: boolean;
  direction: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT' | null;
  padding: number;
  children: string[]; // child ids (nodes + groups)
  note: string | null;
}

export interface IRNode {
  id: string;
  name: string;
  parentId: string | null;
  color: ColorName | null;
  icon: string | null;
  label: string | null;
  width: number | null;
  height: number | null;
  shape: 'rect' | 'class' | 'participant' | null;
  note: string | null;
  /** Class-diagram extension */
  fields?: string[];
  methods?: string[];
}

export interface IREdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string | null;
  color: ColorName | null;
  style: 'solid' | 'dashed' | 'thick' | null;
}

export interface Diagram {
  meta: Meta;
  groups: IRGroup[];
  nodes: IRNode[];
  edges: IREdge[];
  /** Top-level (root) child ids, in source order */
  roots: string[];
  diagnostics: Diagnostic[];
}

export const COLOR_NAMES: ColorName[] = [
  'orange',
  'green',
  'yellow',
  'amber',
  'coral',
  'teal',
  'cyan',
  'mint',
  'emerald',
  'slate',
  'zinc',
  'stone',
  'neutral',
  'white',
  'indigo',
  'blue',
  'purple',
  'violet',
  'fuchsia',
  'lime',
  'sky',
  'red',
  'rose',
  'pink',
  'gray',
];

export function isColorName(value: unknown): value is ColorName {
  return typeof value === 'string' && (COLOR_NAMES as string[]).includes(value);
}

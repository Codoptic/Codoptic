/**
 * Pure-string SVG renderer.
 *
 * Mirrors lib/render/svgScene.tsx but produces a standalone SVG string —
 * usable in Node (script-side rendering, agent pre-rendering, server export)
 * without any React runtime. The on-screen and Node renderers agree visually
 * because both consume the same theme, layout, and icon registry.
 */

import type { Diagram, IRGroup, IRNode, IREdge, Point } from '../ir/types';
import type { LayoutResult, LayoutRect } from '../layout/elk';
import { paletteFor, THEME } from './theme';
import { getIcon } from '../icons/registry';
import { ARROW_FWD_ID, ARROW_BWD_ID, ARROW_THICK_ID, MARKER_DEFS } from './markers';
import { edgeLabelSize, groupTitleSize, nodeLabelLayout } from '../layout/measure';
import { collectLabelObstacles, placeEdgeLabel, rectAtCenter, type RectLike } from './labelPlacement';
import { edgeLaneOffsets, routeEdgePath } from './edgePath';

const ICON_SIZE = 14;
const NODE_BASELINE_CENTER_FACTOR = 1.05;

export interface RenderOptions {
  padding?: number;
  withBackground?: boolean;
  overrides?: {
    nodes?: Record<string, Partial<LayoutRect>>;
    groups?: Record<string, Partial<LayoutRect>>;
    edges?: Record<string, { bends: Point[] }>;
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rectFor(
  id: string,
  layout: LayoutResult,
  overrides?: RenderOptions['overrides'],
): LayoutRect | undefined {
  const ov = overrides?.nodes?.[id] ?? overrides?.groups?.[id];
  const base = layout.nodes.get(id) ?? layout.groups.get(id);
  if (!base) return undefined;
  return {
    x: ov?.x ?? base.x,
    y: ov?.y ?? base.y,
    width: ov?.width ?? base.width,
    height: ov?.height ?? base.height,
  };
}

function effectiveColor(
  item: IRNode | IRGroup,
  groupsById: Map<string, IRGroup>,
): IRGroup['color'] {
  if (item.color) return item.color;
  let parentId = item.parentId;
  while (parentId) {
    const g = groupsById.get(parentId);
    if (!g) break;
    if (g.color) return g.color;
    parentId = g.parentId;
  }
  return null;
}

function groupDepth(g: IRGroup, groupsById: Map<string, IRGroup>): number {
  let d = 0;
  let p: string | null = g.parentId;
  while (p) {
    const parent = groupsById.get(p);
    if (!parent) break;
    d++;
    p = parent.parentId;
  }
  return d;
}

function renderGroup(g: IRGroup, layout: LayoutResult, opts: RenderOptions, groupsById: Map<string, IRGroup>): string {
  const rect = rectFor(g.id, layout, opts.overrides);
  if (!rect) return '';
  const color = effectiveColor(g, groupsById);
  const pal = paletteFor(color);
  const title = (g.label ?? g.name).toUpperCase();
  const titleSize = groupTitleSize(title);
  const icon = getIcon(g.icon);
  const radius = 14;

  const iconPaths = icon.paths.join('');
  return `
    <g data-id="${escapeXml(g.id)}" data-kind="group">
      <rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"
            rx="${radius}" ry="${radius}"
            fill="${pal.groupFill}" stroke="${pal.groupBorder}" stroke-width="1"
            style="filter: drop-shadow(0 0 12px ${pal.groupGlow})" />
      <g transform="translate(${rect.x + 10}, ${rect.y + 8})">
        <rect x="0" y="0" width="${titleSize.width}" height="${titleSize.height}"
              rx="${titleSize.height / 2}" ry="${titleSize.height / 2}"
              fill="${pal.groupTitleBg}" stroke="${pal.groupBorder}" stroke-width="0.5" />
        <g transform="translate(6, ${(titleSize.height - ICON_SIZE) / 2})">
          <svg width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="${icon.viewBox}"
               fill="none" stroke="${pal.groupTitleText}" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">${iconPaths}</svg>
        </g>
        <text x="${6 + ICON_SIZE + 6}" y="${titleSize.height / 2}"
              dominant-baseline="middle" fill="${pal.groupTitleText}"
              font-size="10" font-family="Inter, sans-serif"
              font-weight="600" letter-spacing="0.5">${escapeXml(title)}</text>
      </g>
    </g>`;
}

function renderNode(n: IRNode, layout: LayoutResult, opts: RenderOptions, groupsById: Map<string, IRGroup>): string {
  const rect = rectFor(n.id, layout, opts.overrides);
  if (!rect) return '';
  const color = effectiveColor(n, groupsById);
  const pal = paletteFor(color);
  const icon = getIcon(n.icon);
  const label = n.label ?? n.name;
  const labelBox = nodeLabelLayout(label);
  const labelX = rect.x + 8 + ICON_SIZE + 6;
  const labelY =
    rect.y + rect.height / 2 - labelBox.textHeight / 2 + labelBox.fontSize * NODE_BASELINE_CENTER_FACTOR;
  const iconPaths = icon.paths.join('');
  const labelXml = labelBox.lines
    .map((line, index) =>
      `<tspan x="${labelX}" dy="${index === 0 ? 0 : labelBox.lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join('');

  return `
    <g data-id="${escapeXml(n.id)}" data-kind="node">
      <rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"
            rx="8" ry="8" fill="${pal.nodeFill}" stroke="${pal.nodeBorder}" stroke-width="1" />
      <g transform="translate(${rect.x + 8}, ${rect.y + (rect.height - ICON_SIZE) / 2})">
        <svg width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="${icon.viewBox}"
             fill="none" stroke="${pal.nodeIcon}" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">${iconPaths}</svg>
      </g>
      <text x="${labelX}" y="${labelY}" fill="${pal.nodeLabel}" font-size="${labelBox.fontSize}"
            font-family="Inter, sans-serif" font-weight="500">${labelXml}</text>
    </g>`;
}

function renderEdge(
  edge: IREdge,
  layout: LayoutResult,
  opts: RenderOptions,
  edgeOffsets: Map<string, number>,
  edgeLabelRects: RectLike[],
  labelObstacles: RectLike[],
): string {
  const routed = routeEdgePath(edge, layout, opts.overrides, edgeOffsets.get(edge.id) ?? 0);
  if (!routed?.path) return '';
  const fwdMarker = edge.kind === 'thick' ? ARROW_THICK_ID : ARROW_FWD_ID;
  const markerEnd = edge.kind === 'bwd' ? '' : ` marker-end="url(#${fwdMarker})"`;
  const markerStart =
    edge.kind === 'bwd' || edge.kind === 'bi' ? ` marker-start="url(#${ARROW_BWD_ID})"` : '';
  const dash = edge.kind === 'dashed' ? ' stroke-dasharray="4 4"' : '';
  const strokeWidth = edge.kind === 'thick' ? 2 : 1.1;

  let label = '';
  if (edge.label) {
    const labelSize = edgeLabelSize(edge.label);
    // Motivation vs Logic: labels are placed greedily so each new annotation
    // treats earlier labels and nearby components as already occupied space.
    const labelCenter = placeEdgeLabel(routed.points, labelSize, edgeLabelRects, labelObstacles);
    const labelRect = rectAtCenter(labelCenter, labelSize);
    edgeLabelRects.push(labelRect);
    label = `<g data-kind="edge-label" transform="translate(${labelCenter.x}, ${labelCenter.y})">
        <rect x="${-labelSize.width / 2}" y="${-labelSize.height / 2}"
              width="${labelSize.width}" height="${labelSize.height}"
              rx="5" ry="5" fill="${THEME.background}" fill-opacity="0.86"
              stroke="${THEME.edgeStroke}" stroke-opacity="0.35" stroke-width="0.8" />
        <text x="0" y="0" fill="${THEME.labelFill}" font-size="9.5"
              font-family="Inter, sans-serif" text-anchor="middle"
              dominant-baseline="middle">${escapeXml(edge.label)}</text>
      </g>`;
  }

  return `
    <g data-id="${escapeXml(edge.id)}" data-kind="edge">
      <path d="${routed.path}" fill="none" stroke="${THEME.edgeStroke}" stroke-width="${strokeWidth}"
            stroke-linejoin="round" stroke-linecap="round"${dash}${markerEnd}${markerStart} />
      ${label}
    </g>`;
}

export function renderSvg(diagram: Diagram, layout: LayoutResult, opts: RenderOptions = {}): string {
  const padding = opts.padding ?? 32;
  const groupsById = new Map(diagram.groups.map((g) => [g.id, g]));
  const sortedGroups = [...diagram.groups].sort(
    (a, b) => groupDepth(a, groupsById) - groupDepth(b, groupsById),
  );

  const minX = layout.bbox.x - padding;
  const minY = layout.bbox.y - padding;
  const width = layout.bbox.width + padding * 2;
  const height = layout.bbox.height + padding * 2;

  const background = opts.withBackground
    ? `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${THEME.background}" />`
    : '';

  const groupsXml = sortedGroups.map((g) => renderGroup(g, layout, opts, groupsById)).join('\n');
  const nodesXml = diagram.nodes.map((n) => renderNode(n, layout, opts, groupsById)).join('\n');
  const edgeOffsets = edgeLaneOffsets(diagram.edges);
  const labelObstacles = collectLabelObstacles(layout, opts.overrides);
  const edgeLabelRects: RectLike[] = [];
  const edgesXml = diagram.edges
    .map((e) => renderEdge(e, layout, opts, edgeOffsets, edgeLabelRects, labelObstacles))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${width}" height="${height}"
     viewBox="${minX} ${minY} ${width} ${height}">
  <defs>${MARKER_DEFS}</defs>
  ${background}
  <g>${groupsXml}</g>
  <g>${nodesXml}</g>
  <g>${edgesXml}</g>
</svg>`;
}

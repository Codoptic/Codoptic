/**
 * Pure SVG scene builder.
 *
 * Builds the content of an SVG (a `<g>` tree of groups, nodes, edges) and
 * the surrounding `<defs>` (markers). Consumers wrap this in their own
 * `<svg>` element to control the viewBox / interaction model.
 *
 * Used by:
 *   - <DiagramCanvas/> for on-screen rendering (wraps in interactive <svg>)
 *   - lib/export/svg.ts for export (wraps in plain <svg> at full bbox)
 *
 * Same builder → PNG-equals-screen by construction.
 */

import React from 'react';
import type { Diagram, IRGroup, IRNode, IREdge, Point } from '../ir/types';
import type { LayoutResult, LayoutRect } from '../layout/elk';
import { paletteFor, themeFor, type RenderThemeMode } from './theme';
import { getIcon } from '../icons/registry';
import { ARROW_FWD_ID, ARROW_BWD_ID, ARROW_THICK_ID, MARKER_DEFS } from './markers';
import { edgeLabelSize, groupTitleSize, nodeLabelLayout } from '../layout/measure';
import {
  collectLabelObstacles,
  placeEdgeLabel,
  rectAtCenter,
  type RectLike,
} from './labelPlacement';
import {
  edgeLaneOffsets,
  hasNodeGroupOverrides,
  routeEdgePath,
  type RoutedEdgePath,
} from './edgePath';

export interface SceneOptions {
  selectedId?: string | null;
  /** All IDs in the current multi-selection (drawn with the same selection ring). */
  multiSelectedIds?: ReadonlySet<string>;
  onSelect?: (id: string | null, kind: 'node' | 'group' | 'edge') => void;
  overrides?: {
    nodes?: Record<string, Partial<LayoutRect>>;
    groups?: Record<string, Partial<LayoutRect>>;
    edges?: Record<string, { bends: Point[] }>;
  };
  theme?: RenderThemeMode;
  /**
   * Current canvas viewport — when provided, `buildScene` skips rendering
   * nodes, groups, and edges that are entirely outside the visible area.
   * This reduces the SVG DOM size for large diagrams (100+ nodes) and speeds
   * up edge routing, which runs once per `buildScene` call.
   *
   * Omit (or pass undefined) to disable culling — export paths always omit it
   * so the full diagram is captured. Culling is also automatically disabled
   * when `scale < 0.3` because all elements are visible at that zoom level.
   */
  viewport?: {
    x: number;
    y: number;
    scale: number;
    containerW: number;
    containerH: number;
  };
  /**
   * Pre-routed edge paths from the worker. When provided, edges use these
   * paths instead of computing them synchronously. Enables responsive UI
   * while edge routing happens off the main thread.
   */
  preRoutedEdges?: Map<string, RoutedEdgePath>;
  /**
   * Controls what screen rendering does while progressive routing is still
   * missing some worker-produced edge paths. Exports omit this and keep the
   * original full-fidelity synchronous fallback.
   */
  missingPreRoutedEdge?: 'sync' | 'skip';
}

export interface SceneResult {
  /** <defs> contents string (for dangerouslySetInnerHTML) */
  defsHtml: string;
  /** Array of <g> elements ordered: groups, nodes, edges */
  layers: React.ReactElement[];
  /** Bounding box of the content (no padding) */
  bbox: { x: number; y: number; width: number; height: number };
}

const ICON_SIZE = 14;
const NODE_BASELINE_CENTER_FACTOR = 1.05;

// Extra padding around the visible rect so nodes pop into existence
// before they touch the viewport edge (in scene-space pixels).
const CULL_MARGIN_PX = 200;

export function buildScene(
  diagram: Diagram,
  layout: LayoutResult,
  opts: SceneOptions = {},
): SceneResult {
  const theme = themeFor(opts.theme);
  const groupsById = new Map(diagram.groups.map((g) => [g.id, g]));
  const edgeOffsets = edgeLaneOffsets(diagram.edges);
  const labelObstacles = collectLabelObstacles(layout, opts.overrides);
  const edgeLabelRects: RectLike[] = [];

  // ── Viewport culling ─────────────────────────────────────────────────────
  // When the caller provides a viewport, compute the visible rect in scene
  // coordinates and skip rendering elements outside it. Culling is disabled
  // when scale < 0.3 because all elements fit on screen at that zoom level.
  const vp = opts.viewport;
  const cullActive = vp !== undefined && vp.scale >= 0.3;
  const visX  = vp ? -vp.x / vp.scale : 0;
  const visY  = vp ? -vp.y / vp.scale : 0;
  const visW  = vp ? vp.containerW / vp.scale : Infinity;
  const visH  = vp ? vp.containerH / vp.scale : Infinity;
  const margin = vp ? CULL_MARGIN_PX / vp.scale : 0;

  function isRectVisible(rect: LayoutRect): boolean {
    if (!cullActive) return true;
    return (
      rect.x             < visX + visW + margin &&
      rect.x + rect.width > visX          - margin &&
      rect.y             < visY + visH + margin &&
      rect.y + rect.height > visY          - margin
    );
  }

  function isEdgeVisible(edgeId: string): boolean {
    if (!cullActive) return true;
    const le = layout.edges.get(edgeId);
    if (!le) return true; // no ELK data — let routeEdgePath decide
    const pts = [le.start, le.end, ...le.bends];
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    return (
      minX < visX + visW + margin &&
      maxX > visX          - margin &&
      minY < visY + visH + margin &&
      maxY > visY          - margin
    );
  }

  function rectFor(id: string): LayoutRect | undefined {
    const ov = opts.overrides?.nodes?.[id] ?? opts.overrides?.groups?.[id];
    const base = layout.nodes.get(id) ?? layout.groups.get(id);
    if (!base) return undefined;
    return {
      x: ov?.x ?? base.x,
      y: ov?.y ?? base.y,
      width: ov?.width ?? base.width,
      height: ov?.height ?? base.height,
    };
  }

  function effectiveColor(item: IRNode | IRGroup): IRGroup['color'] {
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

  function renderGroup(g: IRGroup): React.ReactElement | null {
    const rect = rectFor(g.id);
    if (!rect) return null;
    // Groups that contain visible children must still render even if the group
    // header is offscreen, so we skip culling for groups (they act as containers).
    // Culling is still effective for nodes and edges.
    const color = effectiveColor(g);
    const pal = paletteFor(color, opts.theme);
    const title = (g.label ?? g.name).toUpperCase();
    const titleSize = groupTitleSize(title);
    const icon = getIcon(g.icon);
    const radius = 14;
    const isSelected = opts.selectedId === g.id || (opts.multiSelectedIds?.has(g.id) ?? false);

    return (
      <g key={`g-${g.id}`} data-id={g.id} data-kind="group">
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={radius}
          ry={radius}
          fill={pal.groupFill}
          stroke={isSelected ? theme.selectionRing : pal.groupBorder}
          strokeWidth={isSelected ? 2 : 1}
          style={{ filter: `drop-shadow(0 0 12px ${pal.groupGlow})` }}
        />
        <g transform={`translate(${rect.x + 10}, ${rect.y + 8})`}>
          <rect
            x={0}
            y={0}
            width={titleSize.width}
            height={titleSize.height}
            rx={titleSize.height / 2}
            ry={titleSize.height / 2}
            fill={pal.groupTitleBg}
            stroke={pal.groupBorder}
            strokeWidth={0.5}
          />
          <g transform={`translate(6, ${(titleSize.height - ICON_SIZE) / 2})`}>
            <svg
              width={ICON_SIZE}
              height={ICON_SIZE}
              viewBox={icon.viewBox}
              fill="none"
              stroke={pal.groupTitleText}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dangerouslySetInnerHTML={{ __html: icon.paths.join('') }}
            />
          </g>
          <text
            x={6 + ICON_SIZE + 6}
            y={titleSize.height / 2}
            dominantBaseline="middle"
            fill={pal.groupTitleText}
            fontSize={10}
            fontFamily="Inter, sans-serif"
            fontWeight={600}
            letterSpacing={0.5}
          >
            {title}
          </text>
        </g>
      </g>
    );
  }

  function renderNode(n: IRNode): React.ReactElement | null {
    const rect = rectFor(n.id);
    if (!rect) return null;
    if (!isRectVisible(rect)) return null; // viewport culling
    const color = effectiveColor(n);
    const pal = paletteFor(color, opts.theme);
    const icon = getIcon(n.icon);
    const label = n.label ?? n.name;
    const labelBox = nodeLabelLayout(label);
    const labelX = rect.x + 8 + ICON_SIZE + 6;
    const labelY =
      rect.y + rect.height / 2 - labelBox.textHeight / 2 + labelBox.fontSize * NODE_BASELINE_CENTER_FACTOR;
    const isSelected = opts.selectedId === n.id || (opts.multiSelectedIds?.has(n.id) ?? false);

    return (
      <g key={`n-${n.id}`} data-id={n.id} data-kind="node">
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={8}
          ry={8}
          fill={pal.nodeFill}
          stroke={isSelected ? theme.selectionRing : pal.nodeBorder}
          strokeWidth={isSelected ? 2 : 1}
        />
        <g transform={`translate(${rect.x + 8}, ${rect.y + (rect.height - ICON_SIZE) / 2})`}>
          <svg
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox={icon.viewBox}
            fill="none"
            stroke={pal.nodeIcon}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dangerouslySetInnerHTML={{ __html: icon.paths.join('') }}
          />
        </g>
        <text
          x={labelX}
          y={labelY}
          fill={pal.nodeLabel}
          fontSize={labelBox.fontSize}
          fontFamily="Inter, sans-serif"
          fontWeight={500}
        >
          {labelBox.lines.map((line, index) => (
            <tspan key={`${n.id}-${index}`} x={labelX} dy={index === 0 ? 0 : labelBox.lineHeight}>
              {line}
            </tspan>
          ))}
        </text>
      </g>
    );
  }

  function renderEdge(edge: IREdge): React.ReactElement | null {
    if (!isEdgeVisible(edge.id)) return null; // viewport culling (fast check before routing)

    // Root Cause vs Logic: worker-routed edges were being reused after node or
    // group overrides changed, so arrows could keep following the pristine
    // layout and cut straight through moved components. Only reuse the cached
    // worker path when the geometry is still pristine; any dragged component
    // forces a fresh obstacle-aware route from the current layout state.
    const hasConnectedOverride =
      !!(opts.overrides?.nodes?.[edge.source] ||
         opts.overrides?.nodes?.[edge.target] ||
         opts.overrides?.groups?.[edge.source] ||
         opts.overrides?.groups?.[edge.target]);
    const hasEdgeBendOverride = !!(opts.overrides?.edges?.[edge.id]?.bends?.length);
    const shouldUsePrerouted =
      !hasNodeGroupOverrides(opts.overrides) && !hasConnectedOverride && !hasEdgeBendOverride;
    const prerouted = shouldUsePrerouted ? opts.preRoutedEdges?.get(edge.id) : undefined;

    if (
      shouldUsePrerouted &&
      opts.preRoutedEdges &&
      !prerouted &&
      opts.missingPreRoutedEdge === 'skip'
    ) {
      return null;
    }

    const routed =
      prerouted ?? routeEdgePath(edge, layout, opts.overrides, edgeOffsets.get(edge.id) ?? 0);
    if (!routed?.path) return null;
    const isSelected = opts.selectedId === edge.id || (opts.multiSelectedIds?.has(edge.id) ?? false);
    const fwdMarker = edge.kind === 'thick' ? ARROW_THICK_ID : ARROW_FWD_ID;
    const markerEnd = edge.kind === 'bwd' ? undefined : `url(#${fwdMarker})`;
    const markerStart =
      edge.kind === 'bwd' || edge.kind === 'bi' ? `url(#${ARROW_BWD_ID})` : undefined;
    const dash = edge.kind === 'dashed' ? '4 4' : undefined;
    const strokeWidth = edge.kind === 'thick' ? 2 : 1.1;
    let label: React.ReactElement | null = null;
    if (edge.label) {
      const labelSize = edgeLabelSize(edge.label);
      // Motivation vs Logic: labels are placed greedily so each new annotation
      // treats earlier labels and nearby components as already occupied space.
      const labelCenter = placeEdgeLabel(routed.points, labelSize, edgeLabelRects, labelObstacles);
      const labelRect = rectAtCenter(labelCenter, labelSize);
      edgeLabelRects.push(labelRect);
      label = (
        <g data-kind="edge-label" transform={`translate(${labelCenter.x}, ${labelCenter.y})`}>
          <rect
            x={-labelSize.width / 2}
            y={-labelSize.height / 2}
            width={labelSize.width}
            height={labelSize.height}
            rx={5}
            ry={5}
            fill={theme.background}
            fillOpacity={0.86}
            stroke={isSelected ? theme.edgeHover : theme.edgeStroke}
            strokeOpacity={0.35}
            strokeWidth={0.8}
          />
          <text
            x={0}
            y={0}
            fill={theme.labelFill}
            fontSize={9.5}
            fontFamily="Inter, sans-serif"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {edge.label}
          </text>
        </g>
      );
    }

    return (
      <g key={`e-${edge.id}`} data-id={edge.id} data-kind="edge">
        <path
          d={routed.path}
          fill="none"
          stroke="transparent"
          strokeWidth={12}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={isSelected ? 'cursor-default' : 'cursor-pointer'}
        />
        <path
          d={routed.path}
          fill="none"
          stroke={isSelected ? theme.edgeHover : theme.edgeStroke}
          strokeWidth={isSelected ? strokeWidth + 0.6 : strokeWidth}
          strokeDasharray={dash}
          strokeLinejoin="round"
          strokeLinecap="round"
          markerEnd={markerEnd}
          markerStart={markerStart}
        />
        {isSelected &&
          routed.points.slice(0, -1).map((point, index) => {
            const next = routed.points[index + 1]!;
            const isVertical = Math.abs(point.x - next.x) < 0.001;
            const isHorizontal = Math.abs(point.y - next.y) < 0.001;
            const isTerminalSegment = index === 0 || index + 1 === routed.points.length - 1;
            const length = Math.hypot(next.x - point.x, next.y - point.y);
            if ((!isVertical && !isHorizontal) || isTerminalSegment || length < 18) return null;
            const mid = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
            const axis = isVertical ? 'vertical' : 'horizontal';

            return (
              <g
                key={`edge-handle-${edge.id}-${index}`}
                data-id={edge.id}
                data-kind="edge"
                data-edge-segment={index}
                data-edge-axis={axis}
                className={isVertical ? 'cursor-ew-resize' : 'cursor-ns-resize'}
              >
                <line
                  x1={point.x}
                  y1={point.y}
                  x2={next.x}
                  y2={next.y}
                  stroke="transparent"
                  strokeWidth={16}
                  strokeLinecap="round"
                />
                <circle
                  cx={mid.x}
                  cy={mid.y}
                  r={4.5}
                  fill={theme.background}
                  stroke={theme.selectionRing}
                  strokeWidth={1.4}
                />
                {isVertical ? (
                  <line
                    x1={mid.x - 7}
                    y1={mid.y}
                    x2={mid.x + 7}
                    y2={mid.y}
                    stroke={theme.selectionRing}
                    strokeWidth={1.2}
                    strokeLinecap="round"
                  />
                ) : (
                  <line
                    x1={mid.x}
                    y1={mid.y - 7}
                    x2={mid.x}
                    y2={mid.y + 7}
                    stroke={theme.selectionRing}
                    strokeWidth={1.2}
                    strokeLinecap="round"
                  />
                )}
              </g>
            );
          })}
        {label}
      </g>
    );
  }

  function groupDepth(g: IRGroup): number {
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

  void opts.onSelect; // selection handled at canvas via event delegation

  const sortedGroups = [...diagram.groups].sort((a, b) => groupDepth(a) - groupDepth(b));

  const layers: React.ReactElement[] = [
    <g key="edges">{diagram.edges.map((e) => renderEdge(e)).filter(Boolean)}</g>,
    <g key="groups">{sortedGroups.map((g) => renderGroup(g)).filter(Boolean)}</g>,
    <g key="nodes">{diagram.nodes.map((n) => renderNode(n)).filter(Boolean)}</g>,
  ];

  return {
    defsHtml: MARKER_DEFS,
    layers,
    bbox: {
      x: layout.bbox.x,
      y: layout.bbox.y,
      width: layout.bbox.width,
      height: layout.bbox.height,
    },
  };
}

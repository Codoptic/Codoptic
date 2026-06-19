import type { IREdge, Point } from '../ir/types';
import type { LayoutEdge, LayoutRect, LayoutResult } from '../layout/elk';

interface EdgeOverrides {
  nodes?: Record<string, Partial<LayoutRect>>;
  groups?: Record<string, Partial<LayoutRect>>;
  edges?: Record<string, { bends: Point[] }>;
}

export function hasNodeGroupOverrides(overrides?: EdgeOverrides): boolean {
  return (
    Object.keys(overrides?.nodes ?? {}).length > 0 ||
    Object.keys(overrides?.groups ?? {}).length > 0
  );
}

export interface RoutedEdgePath {
  path: string;
  points: Point[];
  labelPoint: Point;
}

const CORNER_RADIUS = 0;
const EPSILON = 0.001;
const EDGE_LANE_SPACING = 28;
const EDGE_FAN_LANE_SPACING = 12;
const MAX_EDGE_LANE_OFFSET = 42;
const EDGE_CLEARANCE = 18;
const OBSTACLE_PADDING = 8;
const TURN_PENALTY = 36;
const LOCAL_OBSTACLE_MARGIN = 180;
const ROUTING_OBSTACLE_CAP = 24;
const GRID_ROUTE_STATE_LIMIT = 4_000;

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function boundsBetween(from: Point, to: Point, margin = LOCAL_OBSTACLE_MARGIN): Bounds {
  return {
    minX: Math.min(from.x, to.x) - margin,
    maxX: Math.max(from.x, to.x) + margin,
    minY: Math.min(from.y, to.y) - margin,
    maxY: Math.max(from.y, to.y) + margin,
  };
}

function rectIntersectsBounds(rect: LayoutRect, bounds: Bounds): boolean {
  return (
    rect.x <= bounds.maxX &&
    rect.x + rect.width >= bounds.minX &&
    rect.y <= bounds.maxY &&
    rect.y + rect.height >= bounds.minY
  );
}

type Side = 'left' | 'right' | 'top' | 'bottom';
type Axis = 'horizontal' | 'vertical';
type Direction = 'left' | 'right' | 'up' | 'down';

interface Obstacle {
  id: string;
  rect: LayoutRect;
}

function rectFor(
  id: string,
  layout: LayoutResult,
  overrides?: EdgeOverrides,
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

function center(rect: LayoutRect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
}

function insideRect(point: Point, rect: LayoutRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function expandedRect(rect: LayoutRect, padding: number): LayoutRect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPSILON * EPSILON) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / len2),
  );
  const proj = { x: start.x + t * dx, y: start.y + t * dy };
  return Math.hypot(point.x - proj.x, point.y - proj.y);
}

function segmentAxis(from: Point | undefined, to: Point | undefined): Axis | null {
  if (!from || !to) return null;
  return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? 'horizontal' : 'vertical';
}

function segmentAxisStrict(from: Point, to: Point): Axis | null {
  if (Math.abs(from.x - to.x) < EPSILON) return 'vertical';
  if (Math.abs(from.y - to.y) < EPSILON) return 'horizontal';
  return null;
}

function rectAnchor(rect: LayoutRect, toward: Point, axis: Axis | null): Point {
  const c = center(rect);
  if (axis === 'horizontal') {
    const right = toward.x >= c.x;
    return {
      x: right ? rect.x + rect.width : rect.x,
      y: clamp(toward.y, rect.y, rect.y + rect.height),
    };
  }
  if (axis === 'vertical') {
    const bottom = toward.y >= c.y;
    return {
      x: clamp(toward.x, rect.x, rect.x + rect.width),
      y: bottom ? rect.y + rect.height : rect.y,
    };
  }

  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) return { x: c.x, y: c.y };

  const tx = dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx);
  const ty = dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function compactPoints(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    if (!out.length || !samePoint(out[out.length - 1]!, point)) out.push(point);
  }
  return out;
}

function removeCollinear(points: Point[]): Point[] {
  const compacted = compactPoints(points);
  if (compacted.length <= 2) return compacted;
  const out: Point[] = [compacted[0]!];
  for (let i = 1; i < compacted.length - 1; i++) {
    const prev = out[out.length - 1]!;
    const curr = compacted[i]!;
    const next = compacted[i + 1]!;
    const axisA = segmentAxisStrict(prev, curr);
    const axisB = segmentAxisStrict(curr, next);
    if (axisA && axisA === axisB) continue;
    out.push(curr);
  }
  out.push(compacted[compacted.length - 1]!);
  return out;
}

// Maximum perpendicular deviation (layout-pixels) below which an intermediate
// bend point is treated as "nearly collinear" and removed.  4 px is
// sub-visual at any practical zoom level but large enough to collapse the
// tiny perpendicular stubs (2–3 px Z-shapes) that the router occasionally
// produces when source/target nodes are nearly aligned on one axis.
const NEAR_COLLINEAR_PX = 4;

/**
 * Remove intermediate points whose perpendicular deviation from the straight
 * line through their two neighbours is ≤ NEAR_COLLINEAR_PX.
 *
 * Purpose: merge "broken" segments that visually lie on the same line but
 * carry a small perpendicular stub — e.g. two long horizontal runs joined by
 * a 2 px vertical connector.  Removing the stub makes the two runs merge into
 * one continuous segment, eliminating the spurious bend handle and the visual
 * "break" in the arrow.
 *
 * The resulting path is technically non-orthogonal by up to NEAR_COLLINEAR_PX
 * pixels, but the tiny diagonal is imperceptible at any practical zoom level.
 *
 * Runs in a loop until stable because dropping one point can expose another.
 */
function removeNearCollinear(points: Point[]): Point[] {
  if (points.length <= 2) return points;
  let current = points;
  let changed = true;
  while (changed && current.length > 2) {
    changed = false;
    const out: Point[] = [current[0]!];
    for (let i = 1; i < current.length - 1; i++) {
      const prev = out[out.length - 1]!;
      const curr = current[i]!;
      const next = current[i + 1]!;
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < EPSILON * EPSILON) {
        // prev and next coincide — keep curr to avoid a degenerate segment.
        out.push(curr);
        continue;
      }
      // Perpendicular distance from curr to the line through prev→next.
      const cross = (curr.x - prev.x) * dy - (curr.y - prev.y) * dx;
      if (Math.abs(cross) / Math.sqrt(len2) <= NEAR_COLLINEAR_PX) {
        changed = true; // drop this near-collinear bend
        continue;
      }
      out.push(curr);
    }
    out.push(current[current.length - 1]!);
    current = out;
  }
  return current;
}

function buildRoundedPath(points: Point[]): string {
  if (points.length < 2) return '';
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const next = points[i + 1]!;
    const inDx = Math.sign(curr.x - prev.x);
    const inDy = Math.sign(curr.y - prev.y);
    const outDx = Math.sign(next.x - curr.x);
    const outDy = Math.sign(next.y - curr.y);
    const inLen = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const outLen = Math.hypot(next.x - curr.x, next.y - curr.y);
    const r = Math.min(CORNER_RADIUS, inLen / 2, outLen / 2);
    const beforeX = curr.x - inDx * r;
    const beforeY = curr.y - inDy * r;
    const afterX = curr.x + outDx * r;
    const afterY = curr.y + outDy * r;
    d +=
      r > 0
        ? ` L ${beforeX} ${beforeY} Q ${curr.x} ${curr.y} ${afterX} ${afterY}`
        : ` L ${curr.x} ${curr.y}`;
  }
  d += ` L ${points[points.length - 1]!.x} ${points[points.length - 1]!.y}`;
  return d;
}

function midpointOnPolyline(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;

  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const len = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    lengths.push(len);
    total += len;
  }

  let remaining = total / 2;
  for (let i = 1; i < points.length; i++) {
    const len = lengths[i - 1]!;
    if (remaining <= len) {
      const prev = points[i - 1]!;
      const curr = points[i]!;
      const t = len === 0 ? 0 : remaining / len;
      return { x: prev.x + (curr.x - prev.x) * t, y: prev.y + (curr.y - prev.y) * t };
    }
    remaining -= len;
  }

  return points[points.length - 1]!;
}

function directAxis(from: Point, to: Point): Axis {
  return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? 'horizontal' : 'vertical';
}

function segmentLength(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function rangesOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
  const minA = Math.min(a1, a2);
  const maxA = Math.max(a1, a2);
  const minB = Math.min(b1, b2);
  const maxB = Math.max(b1, b2);
  return Math.max(minA, minB) < Math.min(maxA, maxB) - EPSILON;
}

function segmentIntersectsRect(a: Point, b: Point, rect: LayoutRect): boolean {
  const axis = segmentAxisStrict(a, b);
  if (axis === 'vertical') {
    return (
      a.x > rect.x + EPSILON &&
      a.x < rect.x + rect.width - EPSILON &&
      rangesOverlap(a.y, b.y, rect.y, rect.y + rect.height)
    );
  }
  if (axis === 'horizontal') {
    return (
      a.y > rect.y + EPSILON &&
      a.y < rect.y + rect.height - EPSILON &&
      rangesOverlap(a.x, b.x, rect.x, rect.x + rect.width)
    );
  }
  return true;
}

function pathIntersections(points: Point[], obstacles: Obstacle[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    for (const obstacle of obstacles) {
      if (segmentIntersectsRect(prev, curr, obstacle.rect)) total++;
    }
  }
  return total;
}

function cleanBends(bends: Point[], sourceRect: LayoutRect, targetRect: LayoutRect): Point[] {
  return bends.filter((point) => !insideRect(point, sourceRect) && !insideRect(point, targetRect));
}

function collectObstacles(
  layout: LayoutResult,
  overrides: EdgeOverrides | undefined,
  sourceId: string,
  targetId: string,
  start: Point,
  end: Point,
): Obstacle[] {
  const out: Array<Obstacle & { score: number }> = [];
  // Root Cause vs Logic: checking every node/group for every edge blew up for huge diagrams, so we clamp obstacles to the local corridor before routing.
  const localBounds = boundsBetween(start, end);
  const addNode = (id: string, rect: LayoutRect): void => {
    if (id === sourceId || id === targetId) return;
    const padded = expandedRect(rect, OBSTACLE_PADDING);
    if (!rectIntersectsBounds(padded, localBounds)) return;
    const score = pointToSegmentDistance(center(padded), start, end) - Math.min(padded.width, padded.height) * 0.05;
    out.push({ id, rect: padded, score });
  };
  const addGroup = (id: string, rect: LayoutRect): void => {
    if (id === sourceId || id === targetId) return;
    const padded = expandedRect(rect, OBSTACLE_PADDING);
    if (!rectIntersectsBounds(padded, localBounds)) return;
    if (insideRect(start, padded) || insideRect(end, padded)) return;
    const score = pointToSegmentDistance(center(padded), start, end) - Math.min(padded.width, padded.height) * 0.05;
    out.push({ id, rect: padded, score });
  };

  for (const [id, base] of layout.nodes) {
    const ov = overrides?.nodes?.[id];
    addNode(id, {
      x: ov?.x ?? base.x,
      y: ov?.y ?? base.y,
      width: ov?.width ?? base.width,
      height: ov?.height ?? base.height,
    });
  }
  for (const [id, base] of layout.groups) {
    const ov = overrides?.groups?.[id];
    addGroup(id, {
      x: ov?.x ?? base.x,
      y: ov?.y ?? base.y,
      width: ov?.width ?? base.width,
      height: ov?.height ?? base.height,
    });
  }

  out.sort((a, b) => a.score - b.score);
  return out.slice(0, ROUTING_OBSTACLE_CAP).map(({ score: _score, ...obstacle }) => obstacle);
}

function sideNormal(side: Side): Point {
  switch (side) {
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
  }
}

function sideAxis(side: Side): Axis {
  return side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
}

function sideAnchor(rect: LayoutRect, side: Side, reference: Point): Point {
  const inset = Math.min(10, rect.width / 3, rect.height / 3);
  if (side === 'left' || side === 'right') {
    return {
      x: side === 'right' ? rect.x + rect.width : rect.x,
      y: clamp(reference.y, rect.y + inset, rect.y + rect.height - inset),
    };
  }
  return {
    x: clamp(reference.x, rect.x + inset, rect.x + rect.width - inset),
    y: side === 'bottom' ? rect.y + rect.height : rect.y,
  };
}

function sidePairs(sourceRect: LayoutRect, targetRect: LayoutRect): Array<[Side, Side]> {
  const s = center(sourceRect);
  const t = center(targetRect);
  const horizontal: [Side, Side] = t.x >= s.x ? ['right', 'left'] : ['left', 'right'];
  const vertical: [Side, Side] = t.y >= s.y ? ['bottom', 'top'] : ['top', 'bottom'];
  const primary = Math.abs(t.x - s.x) >= Math.abs(t.y - s.y) ? horizontal : vertical;
  const secondary = Math.abs(t.x - s.x) >= Math.abs(t.y - s.y) ? vertical : horizontal;
  const all: Array<[Side, Side]> = [
    primary,
    secondary,
    ['right', 'right'],
    ['left', 'left'],
    ['bottom', 'bottom'],
    ['top', 'top'],
    ['right', 'left'],
    ['left', 'right'],
    ['bottom', 'top'],
    ['top', 'bottom'],
  ];
  const seen = new Set<string>();
  return all.filter(([a, b]) => {
    const key = `${a}:${b}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function outPoint(anchor: Point, side: Side): Point {
  const normal = sideNormal(side);
  return {
    x: anchor.x + normal.x * EDGE_CLEARANCE,
    y: anchor.y + normal.y * EDGE_CLEARANCE,
  };
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value * 1000) / 1000))].sort((a, b) => a - b);
}

function coordinateIndex(values: number[], value: number): number {
  return values.findIndex((candidate) => Math.abs(candidate - value) <= EPSILON);
}

interface QueueItem {
  key: string;
  priority: number;
}

class MinQueue {
  private items: QueueItem[] = [];

  get length(): number {
    return this.items.length;
  }

  push(item: QueueItem) {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): QueueItem | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (last && this.items.length) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  private bubbleUp(index: number) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent]!.priority <= this.items[index]!.priority) break;
      [this.items[parent], this.items[index]] = [this.items[index]!, this.items[parent]!];
      index = parent;
    }
  }

  private bubbleDown(index: number) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.items[left]!.priority < this.items[smallest]!.priority)
        smallest = left;
      if (right < this.items.length && this.items[right]!.priority < this.items[smallest]!.priority)
        smallest = right;
      if (smallest === index) break;
      [this.items[smallest], this.items[index]] = [this.items[index]!, this.items[smallest]!];
      index = smallest;
    }
  }
}

function gridRoute(start: Point, end: Point, obstacles: Obstacle[]): Point[] | null {
  const direct = removeCollinear([start, end]);
  if (
    direct.length === 2 &&
    segmentAxisStrict(start, end) &&
    pathIntersections(direct, obstacles) === 0
  )
    return direct;

  const localBounds = boundsBetween(start, end);
  const routeObstacles = obstacles.filter((obstacle) => rectIntersectsBounds(obstacle.rect, localBounds));
  const blockers = routeObstacles.length ? routeObstacles : obstacles;
  const minX = Math.min(start.x, end.x, ...blockers.map((o) => o.rect.x)) - EDGE_CLEARANCE * 2;
  const maxX =
    Math.max(start.x, end.x, ...blockers.map((o) => o.rect.x + o.rect.width)) + EDGE_CLEARANCE * 2;
  const minY = Math.min(start.y, end.y, ...blockers.map((o) => o.rect.y)) - EDGE_CLEARANCE * 2;
  const maxY =
    Math.max(start.y, end.y, ...blockers.map((o) => o.rect.y + o.rect.height)) + EDGE_CLEARANCE * 2;
  const xs = uniqueSorted([
    start.x,
    end.x,
    (start.x + end.x) / 2,
    minX,
    maxX,
    ...blockers.flatMap((o) => [
      o.rect.x - EDGE_CLEARANCE,
      o.rect.x + o.rect.width + EDGE_CLEARANCE,
    ]),
  ]);
  const ys = uniqueSorted([
    start.y,
    end.y,
    (start.y + end.y) / 2,
    minY,
    maxY,
    ...blockers.flatMap((o) => [
      o.rect.y - EDGE_CLEARANCE,
      o.rect.y + o.rect.height + EDGE_CLEARANCE,
    ]),
  ]);

  // Root Cause vs Logic: ELK often emits fractional coordinates; uniqueSorted()
  // rounds grid lines to stable 0.001px values, so exact indexOf() can miss the
  // start/end line and seed A* at -1,-1. Use tolerant lookup and cap the search
  // grid so hard diagrams fall back to simple Manhattan routing instead of
  // allocating until the browser or worker runs out of memory.
  if (xs.length * ys.length * 4 > GRID_ROUTE_STATE_LIMIT) return null;
  const startX = coordinateIndex(xs, start.x);
  const startY = coordinateIndex(ys, start.y);
  const endX = coordinateIndex(xs, end.x);
  const endY = coordinateIndex(ys, end.y);
  if (startX < 0 || startY < 0 || endX < 0 || endY < 0) return null;
  const startKey = `${startX},${startY},none`;
  const endPrefix = `${endX},${endY},`;
  const pointFor = (ix: number, iy: number): Point => ({ x: xs[ix]!, y: ys[iy]! });
  const heuristic = (ix: number, iy: number) =>
    Math.abs(xs[ix]! - end.x) + Math.abs(ys[iy]! - end.y);
  const queue = new MinQueue();
  const costs = new Map<string, number>([[startKey, 0]]);
  const cameFrom = new Map<string, string>();
  queue.push({ key: startKey, priority: 0 });

  while (queue.length) {
    const current = queue.pop()!;
    const cost = costs.get(current.key);
    if (cost === undefined) continue;
    const [ixRaw, iyRaw, dirRaw] = current.key.split(',');
    const ix = Number(ixRaw);
    const iy = Number(iyRaw);
    const previousDirection = dirRaw as Direction | 'none';
    if (current.key.startsWith(endPrefix)) {
      const path: Point[] = [];
      let key: string | undefined = current.key;
      while (key) {
        const [xRaw, yRaw] = key.split(',');
        path.push(pointFor(Number(xRaw), Number(yRaw)));
        key = cameFrom.get(key);
      }
      return removeCollinear(path.reverse());
    }

    const neighbors: Array<[number, number, Direction]> = [
      [ix - 1, iy, 'left'],
      [ix + 1, iy, 'right'],
      [ix, iy - 1, 'up'],
      [ix, iy + 1, 'down'],
    ];
    for (const [nx, ny, direction] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
      const from = pointFor(ix, iy);
      const to = pointFor(nx, ny);
      if (pathIntersections([from, to], blockers)) continue;
      const turnCost =
        previousDirection !== 'none' && previousDirection !== direction ? TURN_PENALTY : 0;
      const nextCost = cost + segmentLength(from, to) + turnCost;
      const nextKey = `${nx},${ny},${direction}`;
      if (nextCost >= (costs.get(nextKey) ?? Infinity)) continue;
      costs.set(nextKey, nextCost);
      cameFrom.set(nextKey, current.key);
      queue.push({ key: nextKey, priority: nextCost + heuristic(nx, ny) });
    }
  }

  return null;
}

function simpleRoute(
  start: Point,
  end: Point,
  obstacles: Obstacle[],
): { points: Point[]; intersections: number } {
  const candidates: Point[][] = [];
  if (segmentAxisStrict(start, end)) candidates.push([start, end]);
  candidates.push([start, { x: end.x, y: start.y }, end], [start, { x: start.x, y: end.y }, end]);

  const xs = uniqueSorted([
    start.x,
    end.x,
    (start.x + end.x) / 2,
    ...obstacles.flatMap((obstacle) => [
      obstacle.rect.x - EDGE_CLEARANCE,
      obstacle.rect.x + obstacle.rect.width + EDGE_CLEARANCE,
    ]),
  ]);
  const ys = uniqueSorted([
    start.y,
    end.y,
    (start.y + end.y) / 2,
    ...obstacles.flatMap((obstacle) => [
      obstacle.rect.y - EDGE_CLEARANCE,
      obstacle.rect.y + obstacle.rect.height + EDGE_CLEARANCE,
    ]),
  ]);

  for (const x of xs) candidates.push([start, { x, y: start.y }, { x, y: end.y }, end]);
  for (const y of ys) candidates.push([start, { x: start.x, y }, { x: end.x, y }, end]);

  let best: { points: Point[]; intersections: number; score: number } | null = null;
  for (const candidate of candidates) {
    const points = removeCollinear(candidate);
    const intersections = pathIntersections(points, obstacles);
    let length = 0;
    let longest = 0;
    for (let i = 1; i < points.length; i++) {
      const len = segmentLength(points[i - 1]!, points[i]!);
      length += len;
      longest = Math.max(longest, len);
    }
    const score =
      intersections * 1_000_000 + (points.length - 2) * TURN_PENALTY + length - longest * 0.15;
    if (!best || score < best.score) best = { points, intersections, score };
    if (intersections === 0 && points.length <= 4) break;
  }

  return best ?? { points: orthogonalizePolyline([start, end]), intersections: Infinity };
}

function orthogonalizePolyline(points: Point[], preserveCollinear = false): Point[] {
  const out: Point[] = [];
  for (const point of compactPoints(points)) {
    if (!out.length) {
      out.push(point);
      continue;
    }
    const prev = out[out.length - 1]!;
    if (segmentAxisStrict(prev, point)) {
      out.push(point);
      continue;
    }
    const prevPrev = out[out.length - 2];
    const prevAxis = prevPrev ? segmentAxisStrict(prevPrev, prev) : null;
    const dx = Math.abs(point.x - prev.x);
    const dy = Math.abs(point.y - prev.y);
    const corner =
      prevAxis === 'vertical' || (!prevAxis && dy > dx)
        ? { x: prev.x, y: point.y }
        : { x: point.x, y: prev.y };
    out.push(corner, point);
  }
  return preserveCollinear ? compactPoints(out) : removeCollinear(out);
}

function applyLane(points: Point[], laneOffset: number): Point[] {
  if (Math.abs(laneOffset) < EPSILON || points.length < 2) return points;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const axis = directAxis(start, end);
  if (axis === 'vertical') {
    const laneX = start.x + laneOffset;
    return removeCollinear([
      start,
      { x: laneX, y: start.y },
      ...points.slice(1, -1).map((point) => ({ ...point, x: point.x + laneOffset })),
      { x: laneX, y: end.y },
      end,
    ]);
  }
  const laneY = start.y + laneOffset;
  return removeCollinear([
    start,
    { x: start.x, y: laneY },
    ...points.slice(1, -1).map((point) => ({ ...point, y: point.y + laneOffset })),
    { x: end.x, y: laneY },
    end,
  ]);
}

function scorePath(
  points: Point[],
  obstacles: Obstacle[],
  preferredAxis: Axis,
  sideRank: number,
): number {
  let length = 0;
  let turns = 0;
  let longest = 0;
  let previousAxis: Axis | null = null;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const axis = segmentAxisStrict(prev, curr);
    const len = segmentLength(prev, curr);
    length += len;
    longest = Math.max(longest, len);
    if (axis && previousAxis && axis !== previousAxis) turns++;
    if (axis) previousAxis = axis;
  }
  const axisBonus = previousAxis === preferredAxis ? -8 : 0;
  return (
    pathIntersections(points, obstacles) * 1_000_000 +
    turns * TURN_PENALTY +
    length -
    longest * 0.15 +
    sideRank * 12 +
    axisBonus
  );
}

function automaticRoute(
  sourceRect: LayoutRect,
  targetRect: LayoutRect,
  layout: LayoutResult,
  overrides: EdgeOverrides | undefined,
  sourceId: string,
  targetId: string,
  laneOffset: number,
): Point[] {
  const sourceCenter = center(sourceRect);
  const targetCenter = center(targetRect);
  const preferredAxis = directAxis(sourceCenter, targetCenter);
  let best: { points: Point[]; score: number } | null = null;

  for (const [[sourceSide, targetSide], sideRank] of sidePairs(sourceRect, targetRect).map(
    (pair, index) => [pair, index] as const,
  )) {
    const start = sideAnchor(sourceRect, sourceSide, targetCenter);
    const end = sideAnchor(targetRect, targetSide, sourceCenter);
    const startOut = outPoint(start, sourceSide);
    const endOut = outPoint(end, targetSide);
    const obstacles = collectObstacles(layout, overrides, sourceId, targetId, startOut, endOut);
    const simple = simpleRoute(startOut, endOut, obstacles);
    const grid =
      simple.intersections > 0 && obstacles.length <= 28
        ? gridRoute(startOut, endOut, obstacles)
        : null;
    const middle =
      grid && pathIntersections(grid, obstacles) <= simple.intersections ? grid : simple.points;
    const lane = laneOffset && sideAxis(sourceSide) === sideAxis(targetSide) ? laneOffset : 0;
    const points = applyLane(removeCollinear([start, ...middle, end]), lane);
    const score = scorePath(points, obstacles, preferredAxis, sideRank);
    if (!best || score < best.score) best = { points, score };
  }

  if (best) return best.points;

  const fallbackStart = rectAnchor(sourceRect, targetCenter, preferredAxis);
  const fallbackEnd = rectAnchor(targetRect, sourceCenter, preferredAxis);
  return orthogonalizePolyline([fallbackStart, fallbackEnd]);
}

function manualRoute(
  sourceRect: LayoutRect,
  targetRect: LayoutRect,
  bends: Point[],
  laid?: LayoutEdge,
): Point[] {
  const sourceCenter = center(sourceRect);
  const targetCenter = center(targetRect);
  const firstReference = bends[0] ?? targetCenter;
  const lastReference = bends[bends.length - 1] ?? sourceCenter;
  const laidBends = laid?.bends ?? [];
  const sourceAxis =
    segmentAxis(laid?.start, laidBends[0] ?? laid?.end) ?? directAxis(sourceCenter, targetCenter);
  const targetAxis =
    segmentAxis(laidBends[laidBends.length - 1] ?? laid?.start, laid?.end) ??
    directAxis(sourceCenter, targetCenter);
  const start = rectAnchor(
    sourceRect,
    firstReference,
    bends.length ? sourceAxis : directAxis(sourceCenter, targetCenter),
  );
  const end = rectAnchor(
    targetRect,
    lastReference,
    bends.length ? targetAxis : directAxis(sourceCenter, targetCenter),
  );

  // Root Cause vs Logic: user-edited and ELK-provided bend points can drift off-axis after node movement, which used to create diagonal arrow runs. We rebuild the visible route as a Manhattan polyline through the requested bends so every segment is horizontal or vertical while retaining the user's editable cuts.
  return orthogonalizePolyline([start, ...bends, end], true);
}

export function edgeLaneOffsets(edges: IREdge[]): Map<string, number> {
  const byPair = new Map<string, IREdge[]>();
  const byEndpoint = new Map<string, IREdge[]>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const key = [edge.source, edge.target].sort().join('\u0000');
    byPair.set(key, [...(byPair.get(key) ?? []), edge]);
    byEndpoint.set(`source:${edge.source}`, [...(byEndpoint.get(`source:${edge.source}`) ?? []), edge]);
    byEndpoint.set(`target:${edge.target}`, [...(byEndpoint.get(`target:${edge.target}`) ?? []), edge]);
  }

  const offsets = new Map<string, number>();
  const addOffset = (edgeId: string, offset: number) => {
    const next = (offsets.get(edgeId) ?? 0) + offset;
    offsets.set(edgeId, clamp(next, -MAX_EDGE_LANE_OFFSET, MAX_EDGE_LANE_OFFSET));
  };

  for (const pairEdges of byPair.values()) {
    if (pairEdges.length < 2) continue;
    const centerIndex = (pairEdges.length - 1) / 2;
    pairEdges.forEach((edge, index) => {
      addOffset(edge.id, (index - centerIndex) * EDGE_LANE_SPACING);
    });
  }

  for (const endpointEdges of byEndpoint.values()) {
    if (endpointEdges.length < 2) continue;
    const centerIndex = (endpointEdges.length - 1) / 2;
    endpointEdges.forEach((edge, index) => {
      addOffset(edge.id, (index - centerIndex) * EDGE_FAN_LANE_SPACING);
    });
  }

  return offsets;
}

export function routeEdgePath(
  edge: IREdge,
  layout: LayoutResult,
  overrides?: EdgeOverrides,
  laneOffset = 0,
): RoutedEdgePath | null {
  const sourceRect = rectFor(edge.source, layout, overrides);
  const targetRect = rectFor(edge.target, layout, overrides);
  if (!sourceRect || !targetRect) return null;

  const laid: LayoutEdge | undefined = layout.edges.get(edge.id);
  const override = overrides?.edges?.[edge.id];
  const hasManualOverride = !!override?.bends?.length;
  const bends = cleanBends(override?.bends ?? laid?.bends ?? [], sourceRect, targetRect);

  // Motivation vs Logic: default rendering should choose readable, obstacle-aware Manhattan routes, while manual edge overrides should remain user-authored even if the user intentionally drags a cut across a component.
  // After automatic routing, removeNearCollinear collapses any tiny perpendicular
  // stubs (≤ 4 px deviation) into their neighbouring segments.  This merges the
  // "broken arrow" effect where two nearly-collinear runs are separated by a
  // tiny Z-shaped jog that the router produces when source/target nodes are
  // almost (but not exactly) aligned on one axis.
  // Manual routes are intentionally left unfiltered so user-placed bends are
  // never silently dropped (compactManualBends handles cleanup on drag end).
  const points = hasManualOverride
    ? manualRoute(sourceRect, targetRect, bends, laid)
    : removeNearCollinear(
        automaticRoute(
          sourceRect,
          targetRect,
          layout,
          overrides,
          edge.source,
          edge.target,
          laneOffset,
        ),
      );

  return {
    path: buildRoundedPath(points),
    points,
    labelPoint: midpointOnPolyline(points),
  };
}

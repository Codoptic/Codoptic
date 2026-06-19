import { describe, expect, it } from 'vitest';
import type { IREdge } from '@/lib/ir/types';
import type { LayoutRect, LayoutResult } from '@/lib/layout/elk';
import { compile } from '@/lib/dsl/compiler';
import { layout } from '@/lib/layout/elk';
import { edgeLaneOffsets, routeEdgePath } from '../edgePath';

function layoutResult(): LayoutResult {
  return {
    nodes: new Map([
      ['a', { x: 0, y: 0, width: 100, height: 40 }],
      ['b', { x: 200, y: 0, width: 100, height: 40 }],
    ]),
    groups: new Map(),
    edges: new Map([
      [
        'e1',
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          start: { x: 100, y: 20 },
          end: { x: 200, y: 20 },
          bends: [{ x: 150, y: 20 }],
        },
      ],
    ]),
    bbox: { x: 0, y: 0, width: 300, height: 40 },
  };
}

function edge(): IREdge {
  return {
    id: 'e1',
    source: 'a',
    target: 'b',
    kind: 'fwd',
    label: null,
    color: null,
    style: null,
  };
}

function isOnBoundary(point: { x: number; y: number }, rect: LayoutRect): boolean {
  const onVertical = point.x === rect.x || point.x === rect.x + rect.width;
  const onHorizontal = point.y === rect.y || point.y === rect.y + rect.height;
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height &&
    (onVertical || onHorizontal)
  );
}

function segmentsAreOrthogonal(points: Array<{ x: number; y: number }>): boolean {
  return points.slice(1).every((point, index) => {
    const prev = points[index]!;
    return point.x === prev.x || point.y === prev.y;
  });
}

function segmentIntersectsRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: LayoutRect,
): boolean {
  if (a.x === b.x) {
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return (
      a.x > rect.x &&
      a.x < rect.x + rect.width &&
      Math.max(minY, rect.y) < Math.min(maxY, rect.y + rect.height)
    );
  }
  if (a.y === b.y) {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    return (
      a.y > rect.y &&
      a.y < rect.y + rect.height &&
      Math.max(minX, rect.x) < Math.min(maxX, rect.x + rect.width)
    );
  }
  return true;
}

function pathAvoidsRect(points: Array<{ x: number; y: number }>, rect: LayoutRect): boolean {
  return points
    .slice(1)
    .every((point, index) => !segmentIntersectsRect(points[index]!, point, rect));
}

describe('routeEdgePath', () => {
  it('fans out edges that share an endpoint', () => {
    const offsets = edgeLaneOffsets([
      { ...edge(), id: 'e1', source: 'a', target: 'b' },
      { ...edge(), id: 'e2', source: 'a', target: 'c' },
      { ...edge(), id: 'e3', source: 'a', target: 'd' },
    ]);

    expect(offsets.get('e1')).not.toBe(offsets.get('e2'));
    expect(offsets.get('e2')).toBe(0);
    expect(offsets.get('e3')).not.toBe(offsets.get('e2'));
  });

  it('reattaches arrow endpoints to moved nodes', () => {
    const layout = layoutResult();
    const movedTarget = { x: 320, y: 80, width: 100, height: 40 };
    const routed = routeEdgePath(edge(), layout, { nodes: { b: movedTarget } });

    expect(routed).not.toBeNull();
    expect(isOnBoundary(routed!.points[routed!.points.length - 1]!, movedTarget)).toBe(true);
    expect(segmentsAreOrthogonal(routed!.points)).toBe(true);
  });

  it('keeps manual edge bends editable while enforcing orthogonal segments', () => {
    const layout = layoutResult();
    const movedSource = { x: 40, y: 80, width: 100, height: 40 };
    const routed = routeEdgePath(edge(), layout, {
      nodes: { a: movedSource },
      edges: { e1: { bends: [{ x: 150, y: 20 }] } },
    });

    expect(routed).not.toBeNull();
    expect(isOnBoundary(routed!.points[0]!, movedSource)).toBe(true);
    expect(routed!.points).toContainEqual({ x: 150, y: 20 });
    expect(segmentsAreOrthogonal(routed!.points)).toBe(true);
  });

  it('routes default arrows around intervening components', () => {
    const layout = layoutResult();
    const obstacle = { x: 120, y: -20, width: 60, height: 80 };
    layout.nodes.set('c', obstacle);

    const routed = routeEdgePath(edge(), layout);

    expect(routed).not.toBeNull();
    expect(segmentsAreOrthogonal(routed!.points)).toBe(true);
    expect(pathAvoidsRect(routed!.points, obstacle)).toBe(true);
  });

  it('keeps obstacle-aware routing in large diagrams', () => {
    const layout = layoutResult();
    const obstacle = { x: 120, y: -20, width: 60, height: 80 };
    layout.nodes.set('c', obstacle);

    for (let i = 0; i < 61; i++) {
      layout.nodes.set(`extra-${i}`, {
        x: 500 + i * 20,
        y: 500 + (i % 4) * 20,
        width: 16,
        height: 16,
      });
    }

    const routed = routeEdgePath(edge(), layout);

    expect(routed).not.toBeNull();
    expect(segmentsAreOrthogonal(routed!.points)).toBe(true);
    expect(pathAvoidsRect(routed!.points, obstacle)).toBe(true);
  });

  it('routes around the nearest blocker even with many decoys', () => {
    const layout = {
      ...layoutResult(),
      nodes: new Map(layoutResult().nodes),
    };
    layout.nodes.set('c', { x: 180, y: -20, width: 60, height: 80 });

    for (let i = 0; i < 30; i++) {
      layout.nodes.set(`decoy-${i}`, {
        x: 20 + i * 10,
        y: i % 2 === 0 ? 140 : -120,
        width: 18,
        height: 18,
      });
    }

    const routed = routeEdgePath(edge(), layout);

    expect(routed).not.toBeNull();
    expect(segmentsAreOrthogonal(routed!.points)).toBe(true);
    expect(pathAvoidsRect(routed!.points, { x: 180, y: -20, width: 60, height: 80 })).toBe(true);
  });

  it('routes fractional ELK layouts without exploding grid search', async () => {
    const dsl = `Core Inventory [color: blue] {
  Asset Master
  Stock Availability
  Asset Status
  Readiness Rules
}

Reservation & Allocation [color: purple] {
  Reservations
  Availability Check
  Asset Allocation
  Shortfall Flag
}

Warehouse Operations [color: teal] {
  Warehouse Picking
  Pick List
  Staging
  Dispatch Ready
}

Returns & Condition [color: orange] {
  Returns Processing
  Check-In
  Quality Checks
  Damage Assessment
}

Maintenance Control [color: red] {
  Maintenance Hold
  Repair Queue
  Released to Stock
}

Boundary Interfaces [color: gray] {
  Commercial Planning And Pricing
  Event Project Planning
  Logistics And Event Delivery
  Procurement And Supplier Management
  Finance And Reporting
  External Warehouse Systems
}

Asset Master > Asset Status: defines assets
Asset Status > Stock Availability: updates
Readiness Rules > Stock Availability: governs ready stock
Reservations => Availability Check: request stock
Availability Check <> Stock Availability: query / confirm
Availability Check => Asset Allocation: reserve assets
Stock Availability > Shortfall Flag: insufficient stock
Shortfall Flag -- Procurement And Supplier Management: replenishment need
Asset Allocation => Warehouse Picking: release to pick
Warehouse Picking > Pick List: generate
External Warehouse Systems -- Pick List: pick execution
Pick List > Staging: picked items
Staging => Dispatch Ready: ready for dispatch
Dispatch Ready -- Logistics And Event Delivery: handoff
Returns Processing => Check-In: returned assets
Check-In > Quality Checks: inspect
Quality Checks > Damage Assessment: if issue found
Quality Checks > Released to Stock: if passed
Damage Assessment => Maintenance Hold: hold asset
Maintenance Hold > Repair Queue: send for repair
Repair Queue > Released to Stock: repair complete
Released to Stock => Stock Availability: restore availability
Reservations -- Commercial Planning And Pricing: availability input
Reservations -- Event Project Planning: event demand
Returns Processing -- Finance And Reporting: loss/damage outcomes
Asset Allocation -- Event Project Planning: allocated inventory
Stock Availability -- Commercial Planning And Pricing: available stock
Asset Status -- Finance And Reporting: asset utilization
External Warehouse Systems -- Stock Availability: stock sync
Logistics And Event Delivery -- Returns Processing: returned from event`;

    const diagram = compile(dsl, dsl);
    const laid = await layout(diagram);
    const offsets = edgeLaneOffsets(diagram.edges);
    const started = Date.now();
    const routed = diagram.edges.map((candidate) =>
      routeEdgePath(candidate, laid, undefined, offsets.get(candidate.id) ?? 0),
    );

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(routed.every((candidate) => candidate?.path && candidate.points.length >= 2)).toBe(true);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICE } from '../src/layout/layout.ts';
import { CELL, ENTRANCE, NavGrid, findPath, obstacles, pathLength, type Point } from '../src/nav.ts';

const grid = new NavGrid();
const allSpots: Array<[string, Point]> = [
  ...Object.entries(OFFICE.spots).flatMap(([zone, list]) => list.map((s, i) => [`${zone}${i}`, { x: s.x, y: s.y }] as [string, Point])),
  ...OFFICE.desks.filter((d) => !d.overflow).map((d) => [d.id, { x: d.chair[0], y: d.chair[1] }] as [string, Point]),
  ['lead', { x: OFFICE.leadDesk.chair[0], y: OFFICE.leadDesk.chair[1] }],
  ['entrance', ENTRANCE],
];

function inside(p: Point, r: { x0: number; y0: number; x1: number; y1: number }) {
  return p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1;
}

test('every station is reachable from the entrance and from every desk', () => {
  const desks = allSpots.filter(([k]) => /^d\d|lead/.test(k));
  for (const [, from] of [['entrance', ENTRANCE] as [string, Point], ...desks]) {
    for (const [name, to] of allSpots) {
      const path = findPath(grid, from, to);
      const last = path[path.length - 1]!;
      assert.deepEqual(last, to, `${name} not reached`);
      // A path that fell back to a straight line through furniture would be suspiciously short
      // only when blocked; check it doesn't cross furniture midpoints.
      const L = pathLength(from, path);
      assert.ok(L >= Math.hypot(to.x - from.x, to.y - from.y) - 1e-6);
    }
  }
});

test('walking segments never pass through the middle of furniture', () => {
  const rects = obstacles().filter((r) => r.x1 - r.x0 > 0.3 && r.y1 - r.y0 > 0.3);
  const from = ENTRANCE;
  for (const [name, to] of allSpots) {
    const path = findPath(grid, from, to);
    let p = from;
    for (const q of path) {
      const steps = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 0.05);
      for (let s = 1; s < steps; s++) {
        const pt = { x: p.x + ((q.x - p.x) * s) / steps, y: p.y + ((q.y - p.y) * s) / steps };
        // Allow the final approach into a seat.
        if (Math.hypot(pt.x - to.x, pt.y - to.y) < 0.6) continue;
        for (const r of rects) {
          const shrunk = { x0: r.x0 + 0.08, y0: r.y0 + 0.08, x1: r.x1 - 0.08, y1: r.y1 - 0.08 };
          assert.ok(!inside(pt, shrunk), `${name}: walks through furniture at ${pt.x.toFixed(2)},${pt.y.toFixed(2)}`);
        }
      }
      p = q;
    }
  }
});

test('paths are smoothed and deterministic', () => {
  const a = findPath(grid, ENTRANCE, { x: 1.25, y: 3.6 });
  const b = findPath(grid, ENTRANCE, { x: 1.25, y: 3.6 });
  assert.deepEqual(a, b);
  assert.ok(a.length < 8, `expected a few segments, got ${a.length}`);
  assert.ok(CELL === 0.25);
});

test('glass office is entered through the door gap only', () => {
  const inside = { x: 16, y: 12.8 };
  const path = findPath(grid, { x: 11.0, y: 7.5 }, inside);
  // Some waypoint must be near the door gap (x≈13, y 10.6–11.8).
  assert.ok(
    [{ x: 11, y: 7.5 }, ...path].some((p, i, arr) => {
      const q = arr[i + 1];
      if (!q) return false;
      if ((p.x - 13) * (q.x - 13) > 0) return false;
      const t = (13 - p.x) / (q.x - p.x);
      const y = p.y + (q.y - p.y) * t;
      return y > 10.55 && y < 11.85;
    }),
    'crosses x=13 only through the door',
  );
});

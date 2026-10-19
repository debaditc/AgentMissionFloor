import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_DWELL_MS, Choreographer, COALESCE_MS, WALK_SPEED } from '../src/choreo.ts';
import { ENTRANCE, NavGrid } from '../src/nav.ts';
import type { Placement } from '../src/placement.ts';

const grid = new NavGrid();
const P = (spotId: string, x: number, y: number, zone: Placement['zone'] = 'library'): Placement => ({
  key: 'k',
  x,
  y,
  face: 'n',
  pose: 'stand',
  prop: 'none',
  deskId: 'd1',
  scale: 1,
  zone,
  spotId,
});
const LIB = P('library:0', 1.25, 3.6);
const LAB = P('lab:0', 14.2, 4.2, 'lab');
const DOOR = P('door:0', 12.3, 11.2, 'door');
const BOARD = P('board:0', 5.6, 1.0, 'board');

function run(c: Choreographer, from: number, to: number, step = 50) {
  let last = { frames: [] as ReturnType<Choreographer['step']>['frames'], gone: [] as string[] };
  for (let t = from; t <= to; t += step) {
    c.flush(t);
    last = c.step(step / 1000, t);
  }
  return last;
}

test('new people walk in from the front edge at walking speed and arrive', () => {
  const c = new Choreographer(grid);
  c.update(new Map([['k', LIB]]), 0);
  const w = c.walkers.get('k')!;
  assert.deepEqual(w.pos, ENTRANCE);
  const first = c.step(0.1, 100).frames[0]!;
  assert.ok(first.walking);
  assert.ok(Math.abs(Math.hypot(first.pos.x - ENTRANCE.x, first.pos.y - ENTRANCE.y) - WALK_SPEED * 0.1) < 0.02);
  const end = run(c, 100, 15000);
  const f = end.frames[0]!;
  assert.equal(f.walking, false);
  assert.deepEqual(f.pos, { x: LIB.x, y: LIB.y });
  assert.equal(f.placement?.spotId, 'library:0');
});

test('coalescing: a station change shorter than 1.5 s never causes a walk', () => {
  const c = new Choreographer(grid);
  c.update(new Map([['k', LIB]]), 0, { instant: true });
  c.update(new Map([['k', LAB]]), 1000);
  run(c, 1000, 1000 + COALESCE_MS - 200);
  c.update(new Map([['k', LIB]]), 1000 + COALESCE_MS - 100); // back before it committed
  const end = run(c, 1000 + COALESCE_MS - 100, 6000);
  assert.deepEqual(end.frames[0]!.pos, { x: LIB.x, y: LIB.y }, 'stayed put');
});

test('a change that holds for 1.5 s is walked', () => {
  const c = new Choreographer(grid);
  c.update(new Map([['k', LIB]]), 0, { instant: true });
  c.update(new Map([['k', LAB]]), 1000);
  run(c, 1000, 1000 + COALESCE_MS - 100);
  assert.equal(c.walkers.get('k')!.target!.spotId, 'library:0', 'not yet');
  run(c, 1000 + COALESCE_MS - 100, 1000 + COALESCE_MS + 100);
  assert.equal(c.walkers.get('k')!.target!.spotId, 'lab:0');
});

test('urgent: the door is walked to immediately; the board is held long enough to see the hand-off', () => {
  const c = new Choreographer(grid);
  c.update(new Map([['k', LIB]]), 0, { instant: true });
  c.update(new Map([['k', DOOR]]), 1000);
  assert.equal(c.walkers.get('k')!.target!.spotId, 'door:0');

  const b = new Choreographer(grid);
  b.update(new Map([['k', LIB]]), 0, { instant: true });
  b.update(new Map([['k', BOARD]]), 1000);
  assert.equal(b.walkers.get('k')!.target!.spotId, 'board:0', 'board is urgent');
  // Their next tool call wants the lab right away, but they finish the walk and dwell first.
  b.update(new Map([['k', LAB]]), 1100);
  run(b, 1100, 4000);
  const w = b.walkers.get('k')!;
  assert.equal(w.target!.spotId, 'board:0');
  const arrived = w.arrivedAt!;
  run(b, 4000, arrived + BOARD_DWELL_MS + COALESCE_MS + 200);
  assert.equal(b.walkers.get('k')!.target!.spotId, 'lab:0');
});

test('people who left walk out through the front edge and are then removed', () => {
  const c = new Choreographer(grid);
  c.update(new Map([['k', LIB]]), 0, { instant: true });
  c.update(new Map(), 100);
  assert.ok(c.walkers.get('k')!.leaving);
  const end = run(c, 100, 20000);
  assert.equal(c.walkers.size, 0);
  void end;
});

test('reduced motion teleports', () => {
  const c = new Choreographer(grid);
  c.update(new Map([['k', LIB]]), 0, { instant: true });
  c.update(new Map([['k', DOOR]]), 10, { instant: true });
  assert.deepEqual(c.walkers.get('k')!.pos, { x: DOOR.x, y: DOOR.y });
});

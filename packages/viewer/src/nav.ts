// Walking paths (spec §8): A* on a 0.25-unit grid over the office floor, obstacles from the
// layout (inflated by a body radius), then string-pulled into a few straight segments.
// Pure and deterministic; built once per layout (and when overflow desks appear).

import { OFFICE, type OfficeLayout } from './layout/layout.ts';

export const CELL = 0.25;
const BODY = 0.2;

export interface Point {
  x: number;
  y: number;
}

/** Where people come in and leave: the open front edge between the lounge and the glass office. */
export const ENTRANCE: Point = { x: 9.6, y: 14.4 };

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly blocked: Uint8Array;

  constructor(layout: OfficeLayout = OFFICE, activeDesks?: Set<string>) {
    // One extra row past the front edge so people can step in from outside.
    this.cols = Math.ceil(layout.grid.w / CELL);
    this.rows = Math.ceil((layout.grid.d + 0.75) / CELL);
    this.blocked = new Uint8Array(this.cols * this.rows);
    for (const r of obstacles(layout, activeDesks)) this.block(r);
    // Walls and floor edges.
    this.block({ x0: -1, y0: -1, x1: layout.grid.w + 1, y1: 0.3 });
    this.block({ x0: -1, y0: -1, x1: 0.3, y1: layout.grid.d + 1 });
    this.block({ x0: layout.grid.w - 0.3, y0: -1, x1: layout.grid.w + 1, y1: layout.grid.d + 1 });
    // Beyond the front edge only the entrance corridor is open.
    this.block({ x0: -1, y0: layout.grid.d - 0.05, x1: ENTRANCE.x - 0.8, y1: layout.grid.d + 1 });
    this.block({ x0: ENTRANCE.x + 0.8, y0: layout.grid.d - 0.05, x1: layout.grid.w + 1, y1: layout.grid.d + 1 });
  }

  private block(r: Rect) {
    const c0 = Math.max(0, Math.floor((r.x0 - BODY) / CELL));
    const c1 = Math.min(this.cols - 1, Math.floor((r.x1 + BODY) / CELL));
    const r0 = Math.max(0, Math.floor((r.y0 - BODY) / CELL));
    const r1 = Math.min(this.rows - 1, Math.floor((r.y1 + BODY) / CELL));
    for (let row = r0; row <= r1; row++) for (let c = c0; c <= c1; c++) this.blocked[row * this.cols + c] = 1;
  }

  cellOf(p: Point): [number, number] {
    return [Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / CELL))), Math.min(this.rows - 1, Math.max(0, Math.floor(p.y / CELL)))];
  }

  isBlocked(c: number, r: number): boolean {
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows || this.blocked[r * this.cols + c] === 1;
  }
}

/** Furniture footprints from the layout. Seats themselves are destinations, so only their backs block. */
export function obstacles(L: OfficeLayout = OFFICE, activeDesks?: Set<string>): Rect[] {
  const out: Rect[] = [];
  const rect = (x: number, y: number, w: number, d: number) => out.push({ x0: x, y0: y, x1: x + w, y1: y + d });
  for (const D of [L.leadDesk, ...L.desks]) {
    if (D.overflow && activeDesks && !activeDesks.has(D.id)) continue;
    rect(D.x, D.y, D.w, D.d);
  }
  for (const s of L.shelves) rect(0.1, s.y0, 0.65, s.y1 - s.y0);
  for (const a of L.archive) rect(0.1, a.y0, 0.7, a.y1 - a.y0);
  for (const r of L.racks) rect(r.x0, 0.12, r.x1 - r.x0, 0.85);
  rect(L.bench.x, L.bench.y, L.bench.w, L.bench.d);
  rect(L.whiteboard.x0, L.whiteboard.y - 0.06, L.whiteboard.x1 - L.whiteboard.x0, 0.12);
  const { sofa, coffee, cooler, tables } = L.lounge;
  rect(sofa.x - 0.05, sofa.y - 0.05, 0.35, sofa.d + 0.1); // the back; the seat is a destination
  for (const tb of tables) rect(tb.x - 0.3, tb.y - 0.3, 0.6, 0.6); // café bistro tables
  rect(L.pingpong.x, L.pingpong.y, L.pingpong.w, L.pingpong.d);
  rect(coffee.x, coffee.y, coffee.w, coffee.d);
  rect(cooler.x - 0.2, cooler.y - 0.2, 0.4, 0.4);
  const B = L.boss;
  rect(B.desk.x, B.desk.y, B.desk.w, B.desk.d);
  rect(B.x0, B.y0 - 0.03, B.x1 - B.x0, 0.06); // glass back wall
  rect(B.x0 - 0.03, B.y0, 0.06, B.doorGap[0] - B.y0); // glass left wall, door gap left open
  rect(B.x0 - 0.03, B.doorGap[1], 0.06, B.y1 - B.doorGap[1]);
  for (const [px, py] of L.plants) rect(px - 0.2, py - 0.2, 0.4, 0.4);
  return out;
}

const SQRT2 = Math.SQRT2;

/**
 * Shortest walkable path from `from` to `to` (both may sit inside an inflated obstacle, e.g. a
 * chair: the area right around start and goal is treated as walkable). Returns waypoints
 * excluding `from`, ending exactly at `to`. Falls back to a straight line if no path exists.
 */
export function findPath(grid: NavGrid, from: Point, to: Point): Point[] {
  const [sc, sr] = grid.cellOf(from);
  const [gc, gr] = grid.cellOf(to);
  if (sc === gc && sr === gr) return [to];
  const relax = (c: number, r: number) => (Math.abs(c - sc) <= 2 && Math.abs(r - sr) <= 2) || (Math.abs(c - gc) <= 2 && Math.abs(r - gr) <= 2);
  const free = (c: number, r: number) => c >= 0 && r >= 0 && c < grid.cols && r < grid.rows && (!grid.isBlocked(c, r) || relax(c, r));

  const n = grid.cols * grid.rows;
  const g = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = new MinHeap();
  const idx = (c: number, r: number) => r * grid.cols + c;
  const h = (c: number, r: number) => {
    const dx = Math.abs(c - gc);
    const dy = Math.abs(r - gr);
    return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
  };
  const start = idx(sc, sr);
  const goal = idx(gc, gr);
  g[start] = 0;
  open.push(start, h(sc, sr));
  while (open.size) {
    const cur = open.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const c = cur % grid.cols;
    const r = (cur - c) / grid.cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dc && !dr) continue;
        const nc = c + dc;
        const nr = r + dr;
        if (!free(nc, nr)) continue;
        // No corner cutting past furniture.
        if (dc && dr && (!free(c + dc, r) || !free(c, r + dr))) continue;
        const ni = idx(nc, nr);
        const cost = g[cur]! + (dc && dr ? SQRT2 : 1);
        if (cost < g[ni]!) {
          g[ni] = cost;
          came[ni] = cur;
          open.push(ni, cost + h(nc, nr));
        }
      }
    }
  }
  if (came[goal] === -1) return [to];

  const cells: Point[] = [];
  for (let i = goal; i !== start && i !== -1; i = came[i]!) {
    const c = i % grid.cols;
    const r = (i - c) / grid.cols;
    cells.push({ x: (c + 0.5) * CELL, y: (r + 0.5) * CELL });
  }
  cells.reverse();
  cells[cells.length - 1] = to;
  return smooth(cells, from, free, grid);
}

/** String-pulling: keep only waypoints needed to stay in line of sight. */
function smooth(path: Point[], from: Point, free: (c: number, r: number) => boolean, grid: NavGrid): Point[] {
  const out: Point[] = [];
  let anchor = from;
  let i = 0;
  while (i < path.length) {
    let j = path.length - 1;
    while (j > i && !lineOfSight(anchor, path[j]!, free, grid)) j--;
    out.push(path[j]!);
    anchor = path[j]!;
    i = j + 1;
  }
  return out;
}

function lineOfSight(a: Point, b: Point, free: (c: number, r: number) => boolean, grid: NavGrid): boolean {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / (CELL / 3)));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const [c, r] = grid.cellOf({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    if (!free(c, r)) return false;
  }
  return true;
}

export function pathLength(from: Point, path: Point[]): number {
  let len = 0;
  let p = from;
  for (const q of path) {
    len += Math.hypot(q.x - p.x, q.y - p.y);
    p = q;
  }
  return len;
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= key) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.ids[0]!;
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.keys[l]! < this.keys[m]!) m = l;
        if (r < this.ids.length && this.keys[r]! < this.keys[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.ids[a], this.ids[b]] = [this.ids[b]!, this.ids[a]!];
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
  }
}

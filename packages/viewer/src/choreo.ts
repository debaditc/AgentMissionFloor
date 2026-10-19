// Movement rules (spec §8): who walks where, and when. Pure and time-driven so it can be tested
// without a renderer.
// - A new person walks in from the front edge; someone who left walks out.
// - A change of station only happens once it has held for 1.5 s, so rapid tool calls don't
//   ping-pong people around. The label swaps immediately; the walk waits.
// - The door (needs you) and the mission board (taking / pinning a card) are urgent: walk now,
//   and stay at the board for at least a moment so the card hand-off is visible.

import type { Placement } from './placement.ts';
import { ENTRANCE, findPath, type NavGrid, type Point } from './nav.ts';

export const WALK_SPEED = 2.5;
export const COALESCE_MS = 1500;
export const BOARD_DWELL_MS = 1200;

export interface Walker {
  key: string;
  pos: Point;
  heading: number;
  path: Point[];
  /** Where they are going / standing (null while leaving). */
  target: Placement | null;
  arrivedAt: number | null;
  pending: { p: Placement; since: number } | null;
  leaving: boolean;
}

export interface Frame {
  key: string;
  pos: Point;
  heading: number;
  walking: boolean;
  /** Pose and prop apply only after arrival. */
  placement: Placement | null;
}

const urgent = (p: Placement) => p.zone === 'door' || p.zone === 'board';

export class Choreographer {
  readonly walkers = new Map<string, Walker>();
  private grid: NavGrid;

  constructor(grid: NavGrid) {
    this.grid = grid;
  }

  setGrid(grid: NavGrid) {
    this.grid = grid;
  }

  /** Feed the latest desired placements. `instant`: reduced motion, teleport instead of walking. */
  update(desired: Map<string, Placement>, now: number, opts: { instant?: boolean; spawnNear?: (key: string) => Point | undefined } = {}) {
    for (const [key, p] of desired) {
      let w = this.walkers.get(key);
      if (!w) {
        const start = opts.spawnNear?.(key) ?? ENTRANCE;
        w = { key, pos: { ...start }, heading: 0, path: [], target: null, arrivedAt: null, pending: null, leaving: false };
        this.walkers.set(key, w);
        this.commit(w, p, now, opts.instant);
        continue;
      }
      if (w.leaving) {
        // Came back (e.g. a resumed session): walk back in.
        w.leaving = false;
        this.commit(w, p, now, opts.instant);
        continue;
      }
      const same = w.target && w.target.spotId === p.spotId;
      if (same) {
        w.target = p; // pose / prop / face may change in place
        w.pending = null;
        continue;
      }
      if (!w.pending || w.pending.p.spotId !== p.spotId) w.pending = { p, since: now };
      else w.pending.p = p;
    }
    for (const w of this.walkers.values()) {
      if (desired.has(w.key) || w.leaving) continue;
      w.leaving = true;
      w.pending = null;
      w.target = null;
      w.arrivedAt = null;
      w.path = opts.instant ? [] : findPath(this.grid, w.pos, ENTRANCE);
      if (opts.instant) this.walkers.delete(w.key);
    }
    this.flush(now, opts.instant);
  }

  /** Commit pending moves whose time has come. Call every frame. */
  flush(now: number, instant?: boolean) {
    for (const w of this.walkers.values()) {
      const pend = w.pending;
      if (!pend || w.leaving) continue;
      const atBoard = w.target?.zone === 'board' && w.arrivedAt !== null;
      const dwellOk = !atBoard || now - w.arrivedAt! >= BOARD_DWELL_MS;
      const stillWalkingToBoard = w.target?.zone === 'board' && w.arrivedAt === null;
      if (stillWalkingToBoard) continue;
      if ((urgent(pend.p) && dwellOk) || (now - pend.since >= COALESCE_MS && dwellOk)) {
        this.commit(w, pend.p, now, instant);
        w.pending = null;
      }
    }
  }

  private commit(w: Walker, p: Placement, now: number, instant?: boolean) {
    w.target = p;
    w.pending = null;
    if (instant) {
      w.pos = { x: p.x, y: p.y };
      w.path = [];
      w.arrivedAt = now;
      return;
    }
    w.path = findPath(this.grid, w.pos, { x: p.x, y: p.y });
    w.arrivedAt = w.path.length === 0 ? now : null;
  }

  /** Advance everyone along their path. Returns per-person frames and the keys that walked out. */
  step(dt: number, now: number): { frames: Frame[]; gone: string[] } {
    const frames: Frame[] = [];
    const gone: string[] = [];
    for (const w of this.walkers.values()) {
      let budget = WALK_SPEED * dt;
      while (budget > 0 && w.path.length) {
        const next = w.path[0]!;
        const dx = next.x - w.pos.x;
        const dy = next.y - w.pos.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 1e-4) w.heading = Math.atan2(dx, dy);
        if (dist <= budget) {
          w.pos = { x: next.x, y: next.y };
          w.path.shift();
          budget -= dist;
        } else {
          w.pos = { x: w.pos.x + (dx / dist) * budget, y: w.pos.y + (dy / dist) * budget };
          budget = 0;
        }
      }
      const walking = w.path.length > 0;
      if (!walking && w.arrivedAt === null && !w.leaving) w.arrivedAt = now;
      if (!walking && w.leaving) {
        gone.push(w.key);
        continue;
      }
      frames.push({ key: w.key, pos: w.pos, heading: w.heading, walking, placement: walking ? null : w.target });
    }
    for (const k of gone) this.walkers.delete(k);
    return { frames, gone };
  }

  isMoving(): boolean {
    for (const w of this.walkers.values()) if (w.path.length) return true;
    return false;
  }

  hasPending(): boolean {
    for (const w of this.walkers.values()) if (w.pending) return true;
    return false;
  }
}

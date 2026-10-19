// Conflict detector (spec §11): two different people editing the same file within the window
// ("Two teammates editing the same file within N s", §8). It fires once per file and pair per window.

import type { AmbEvent, ConflictEdit, ConflictInfo } from '@agent-mission-floor/protocol';
import { actorKey } from '@agent-mission-floor/world';

export const CONFLICT_WINDOW_MS = 120_000;

export class ConflictDetector {
  private last = new Map<string, ConflictEdit>();
  private fired = new Map<string, number>();
  private windowMs: number;

  constructor(windowMs = CONFLICT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /** Feed every accepted event; returns a conflict when this edit collides with someone else's. */
  check(e: AmbEvent): ConflictInfo | null {
    if (e.kind !== 'tool.post' || e.tool?.category !== 'edit') return null;
    const path = e.tool.targets[0];
    if (!path) return null;
    const cur: ConflictEdit = { actorKey: actorKey(e), ts: e.ts, added: e.tool.added ?? 0, removed: e.tool.removed ?? 0, tool: e.tool.name };
    const prev = this.last.get(path);
    this.last.set(path, cur);
    if (this.last.size > 2000) this.last.delete(this.last.keys().next().value!);
    if (!prev || prev.actorKey === cur.actorKey || cur.ts - prev.ts > this.windowMs) return null;
    const pair = [prev.actorKey, cur.actorKey].sort().join('|');
    const key = `${path}|${pair}`;
    const lastFired = this.fired.get(key);
    if (lastFired !== undefined && cur.ts - lastFired < this.windowMs) return null;
    this.fired.set(key, cur.ts);
    return { path, first: prev, second: cur, windowMs: this.windowMs };
  }
}

// Replay analysis (spec §10.4): lanes of where each person spent their time, key moments to jump
// to, and an end-of-day debrief. Pure: computed by replaying the same reducer over stored events.

import type { AmbEvent, Station } from '@agent-mission-floor/protocol';
import { DORMANT_AFTER_MS, emptyWorld, reduce, type WorldState } from './index.ts';

/** Lane colors group stations the way the timeline legend does. */
export type LaneKind = 'desk' | 'library' | 'lab' | 'door' | 'lounge' | 'other';

export function laneKind(station: Station, status: string): LaneKind {
  if (status === 'waiting' || station === 'door') return 'door';
  if (station === 'desk') return 'desk';
  if (station === 'library' || station === 'window') return 'library';
  if (station === 'lab' || station === 'server') return 'lab';
  if (station === 'lounge') return 'lounge';
  return 'other';
}

export interface LaneBlock {
  kind: LaneKind;
  start: number;
  end: number;
}

export interface Lane {
  key: string;
  name: string;
  color: number;
  tint: boolean;
  blocks: LaneBlock[];
}

export interface Moment {
  ts: number;
  actorKey: string;
  kind: 'arrived' | 'waited' | 'archived' | 'task' | 'failed' | 'conflict' | 'mission' | 'left';
  text: string;
  /** What was finished or what failed (task / failed / mission). */
  what?: string;
  /** How long they waited (waited). */
  ms?: number;
}

export interface Debrief {
  start: number;
  end: number;
  tasksDone: number;
  tasksTotal: number;
  filesTouched: number;
  workingPct: number;
  waitingMs: number;
  toolCalls: number;
  errors: number;
}

export interface ReplayIndex {
  events: AmbEvent[];
  start: number;
  end: number;
  lanes: Lane[];
  moments: Moment[];
  debrief: Debrief;
  /** World states every `CHECKPOINT` events, for fast seeking. */
  checkpoints: Array<{ i: number; ts: number; state: WorldState }>;
}

const CHECKPOINT = 200;

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function buildReplay(events: AmbEvent[]): ReplayIndex {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const start = sorted[0]?.ts ?? Date.now();
  const end = sorted[sorted.length - 1]?.ts ?? start;
  let s = emptyWorld();
  const checkpoints: ReplayIndex['checkpoints'] = [{ i: 0, ts: start, state: s }];
  const current = new Map<string, LaneBlock>();
  const lanes = new Map<string, Lane>();
  const moments: Moment[] = [];
  const waitStart = new Map<string, number>();
  const files = new Set<string>();
  let waitingMs = 0;
  const busy = new Map<string, number>();
  const present = new Map<string, number>();

  sorted.forEach((e, i) => {
    const before = s;
    s = reduce(s, e);
    if ((i + 1) % CHECKPOINT === 0) checkpoints.push({ i: i + 1, ts: e.ts, state: s });
    if (e.kind === 'tool.post' && e.tool?.category === 'edit' && e.tool.targets[0]) files.add(e.tool.targets[0]);

    for (const a of Object.values(s.actors)) {
      const prev = before.actors[a.key];
      if (!prev) moments.push({ ts: e.ts, actorKey: a.key, kind: 'arrived', text: `${a.name} arrived` });
      let lane = lanes.get(a.key);
      if (!lane) lanes.set(a.key, (lane = { key: a.key, name: a.name, color: a.color, tint: a.tint, blocks: [] }));
      lane.name = a.name;
      const kind = laneKind(a.station, a.status);
      const cur = current.get(a.key);
      if (a.status === 'gone') {
        if (cur) {
          cur.end = e.ts;
          current.delete(a.key);
          if (prev && prev.status !== 'gone') moments.push({ ts: e.ts, actorKey: a.key, kind: 'left', text: `${a.name} left` });
        }
        continue;
      }
      if (!cur || cur.kind !== kind) {
        if (cur) cur.end = e.ts;
        const block = { kind, start: e.ts, end: e.ts };
        lane.blocks.push(block);
        current.set(a.key, block);
      } else cur.end = e.ts;

      // Waiting on Deb: from the moment they reached the door until they got going again.
      if (a.status === 'waiting' && !waitStart.has(a.key)) waitStart.set(a.key, e.ts);
      if (a.status !== 'waiting' && waitStart.has(a.key)) {
        const w = e.ts - waitStart.get(a.key)!;
        waitingMs += w;
        if (w > 5000) moments.push({ ts: waitStart.get(a.key)!, actorKey: a.key, kind: 'waited', text: `${a.name} waited ${fmtDur(w)}`, ms: w });
        waitStart.delete(a.key);
      }
      if (prev && prev.station !== 'archive' && a.station === 'archive') moments.push({ ts: e.ts, actorKey: a.key, kind: 'archived', text: `${a.name} archived notes` });
      if (prev && a.errors > prev.errors) moments.push({ ts: e.ts, actorKey: a.key, kind: 'failed', text: `${a.name}: ${a.chip?.text ?? 'failed'}`, what: a.chip?.text ?? 'failed' });
    }
    // Any card pinned to Done: task-list tasks, solo requests, interns' and teammates' assignments.
    for (const c of Object.values(s.cards)) {
      if (c.status !== 'completed' || before.cards[c.key]?.status === 'completed') continue;
      const owner = c.ownerKey ? s.actors[c.ownerKey] : undefined;
      moments.push({ ts: e.ts, actorKey: owner?.key ?? c.sessionId, kind: 'task', text: `${owner?.name ?? 'Someone'} finished “${c.title}”`, what: c.title });
    }
    if (e.kind === 'conflict' && e.conflict) {
      const n = (k: string) => s.actors[k]?.name ?? 'someone';
      moments.push({ ts: e.ts, actorKey: e.conflict.second.actorKey, kind: 'conflict', text: `${n(e.conflict.first.actorKey)} and ${n(e.conflict.second.actorKey)} both edited ${e.conflict.path.split('/').pop()}` });
    }
    for (const m of Object.values(s.missions)) {
      const was = before.missions[m.sessionId];
      if (m.complete && !was?.complete) moments.push({ ts: e.ts, actorKey: m.sessionId, kind: 'mission', text: 'Mission complete', what: m.text });
    }
  });
  for (const [key, w] of waitStart) {
    waitingMs += end - w;
    void key;
  }
  // A session idle for over an hour without ending is "away" (same rule as the live office),
  // so its idle block stops there instead of stretching across the whole day.
  for (const lane of lanes.values()) for (const b of lane.blocks) if (b.kind === 'lounge') b.end = Math.min(b.end, b.start + DORMANT_AFTER_MS);
  // Time accounting from lanes: working = desk/library/lab; present = any block.
  for (const lane of lanes.values()) {
    for (const b of lane.blocks) {
      const d = Math.max(0, b.end - b.start);
      present.set(lane.key, (present.get(lane.key) ?? 0) + d);
      if (b.kind === 'desk' || b.kind === 'library' || b.kind === 'lab') busy.set(lane.key, (busy.get(lane.key) ?? 0) + d);
    }
  }
  const totalPresent = [...present.values()].reduce((a, b) => a + b, 0);
  const totalBusy = [...busy.values()].reduce((a, b) => a + b, 0);
  const cards = Object.values(s.cards);
  return {
    events: sorted,
    start,
    end,
    lanes: [...lanes.values()].filter((l) => l.blocks.length),
    moments: moments.sort((a, b) => a.ts - b.ts),
    debrief: {
      start,
      end,
      tasksDone: cards.filter((c) => c.status === 'completed').length,
      tasksTotal: cards.length,
      filesTouched: files.size,
      workingPct: totalPresent ? Math.round((totalBusy / totalPresent) * 100) : 0,
      waitingMs,
      toolCalls: s.stats.toolCalls,
      errors: s.stats.errors,
    },
    checkpoints,
  };
}

export interface AwaySummary {
  since: number;
  until: number;
  tasks: Array<{ actorKey: string; what: string }>;
  waits: Array<{ actorKey: string; ms: number }>;
  failures: Array<{ actorKey: string; what: string }>;
  missions: string[];
  toolCalls: number;
}

/**
 * What happened since Deb last looked ("while you were away"), from a replay index that starts
 * earlier (so cards and people already exist). People are referenced by key, never by the replay's
 * names: the viewer shows the live office's names.
 */
export function awaySummary(index: ReplayIndex, since: number): AwaySummary {
  const after = index.moments.filter((m) => m.ts >= since);
  return {
    since,
    until: index.end,
    tasks: after.filter((m) => m.kind === 'task').map((m) => ({ actorKey: m.actorKey, what: m.what ?? '' })),
    waits: after.filter((m) => m.kind === 'waited').map((m) => ({ actorKey: m.actorKey, ms: m.ms ?? 0 })),
    failures: after.filter((m) => m.kind === 'failed').map((m) => ({ actorKey: m.actorKey, what: m.what ?? 'failed' })),
    missions: after.filter((m) => m.kind === 'mission').map((m) => m.what ?? 'Mission complete'),
    toolCalls: index.events.filter((e) => e.ts >= since && (e.kind === 'tool.post' || e.kind === 'tool.fail')).length,
  };
}

/** World state at time `ts`: nearest checkpoint, then replay forward. */
export function stateAt(index: ReplayIndex, ts: number): WorldState {
  let cp = index.checkpoints[0]!;
  for (const c of index.checkpoints) {
    if (c.ts <= ts) cp = c;
    else break;
  }
  let s = cp.state;
  for (let i = cp.i; i < index.events.length && index.events[i]!.ts <= ts; i++) s = reduce(s, index.events[i]!);
  return s;
}

export { fmtDur };

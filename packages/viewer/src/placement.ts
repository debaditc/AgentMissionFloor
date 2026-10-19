// World state → where each person is in the office (pure and deterministic, so tests and
// replay agree). Seats follow spec §6: own desk for editing, first free spot per zone, and
// deterministic overflow when a zone is full.

import { isDormant, type Actor, type WorldState } from '@agent-mission-floor/world';
import { OFFICE, type Desk, type Facing, type OfficeLayout, type Pose, type Spot, type SpotZone } from './layout/layout.ts';

export const PERSON_SCALE = 1.35;

export type Prop = 'mug' | 'hand' | 'typing' | 'papers' | 'paddle' | 'none';

export interface Placement {
  key: string;
  x: number;
  y: number;
  face: Facing;
  pose: Pose;
  prop: Prop;
  /** Desk the person owns (lit monitor, chips anchor there). */
  deskId: string;
  scale: number;
  /** Where they are: a spot zone, or 'desk'. */
  zone: SpotZone | 'desk';
  /** Stable identity of the spot ("library:2", "desk:d3"), used to keep people in place. */
  spotId: string;
  /** Café table they're standing at (people at one table chat). */
  group?: string;
}

const STATION_ZONE: Record<string, SpotZone> = {
  board: 'board',
  library: 'library',
  archive: 'archive',
  window: 'window',
  server: 'server',
  lab: 'lab',
  whiteboard: 'whiteboard',
  lounge: 'lounge',
  door: 'door',
};

export function visibleActors(state: WorldState, now: number): Actor[] {
  return Object.values(state.actors)
    .filter((a) => a.status !== 'gone' && !isDormant(a, now))
    .sort((a, b) => a.startedTs - b.startedTs || (a.key < b.key ? -1 : 1));
}

/** Home desks: the lead gets the lead desk; everyone else (not interns) in order of arrival. */
export function assignDesks(actors: Actor[], layout: OfficeLayout = OFFICE): Map<string, Desk> {
  const homes = new Map<string, Desk>();
  let next = 0;
  for (const a of actors) {
    if (a.role === 'intern') continue;
    if (a.role === 'lead' && ![...homes.values()].includes(layout.leadDesk)) {
      homes.set(a.key, layout.leadDesk);
      continue;
    }
    const desk = layout.desks[next] ?? extraDesk(layout, next);
    homes.set(a.key, desk);
    next++;
  }
  return homes;
}

/** Beyond the drawn desks, extend the cluster in a fixed pattern (deterministic). */
function extraDesk(layout: OfficeLayout, index: number): Desk {
  const extra = index - layout.desks.length;
  const col = extra % 3;
  const row = Math.floor(extra / 3);
  const x = 6.6 + col * 2.9;
  const y = 12.2 + row * 0.1;
  return { id: `x${extra}`, x, y: Math.min(y, 12.4), w: 2.4, d: 0.7, chair: [x + 1.2, Math.min(y, 12.4) + 1.2], overflow: true };
}

function overflowSpot(base: Spot, n: number): Spot {
  // Ring around the zone's first spot: right, left, behind, in front.
  const ring: Array<[number, number]> = [
    [0.8, 0.6],
    [-0.8, 0.6],
    [0.0, 1.1],
    [1.6, 1.1],
    [-1.6, 1.1],
  ];
  const [dx, dy] = ring[n % ring.length]!;
  const k = 1 + Math.floor(n / ring.length);
  return { x: base.x + dx * k, y: base.y + dy * k, face: base.face, pose: 'stand' };
}

function propFor(a: Actor, zone: SpotZone | 'desk'): Prop {
  if (zone === 'door' && a.needs) return 'hand';
  if (zone === 'lounge') return 'mug';
  if (zone === 'pingpong') return 'paddle';
  if (zone === 'archive') return 'papers';
  if (zone === 'desk' && a.status === 'working') return 'typing';
  return 'none';
}

/**
 * Where everyone should be. `prev` makes seats sticky: someone already standing at a spot in
 * the same zone keeps it when others arrive or leave (no reshuffling).
 */
export function placeActors(state: WorldState, now: number, layout: OfficeLayout = OFFICE, prev?: Map<string, Placement>): Map<string, Placement> {
  const actors = visibleActors(state, now);
  const desks = assignDesks(actors, layout);
  const out = new Map<string, Placement>();
  const used = new Set<string>();
  const zoneFor = new Map<string, SpotZone>();
  const scaleOf = (a: Actor) => (a.role === 'intern' ? PERSON_SCALE * 0.85 : PERSON_SCALE);
  const deskOf = (a: Actor) => desks.get(a.key) ?? (a.parentKey ? desks.get(a.parentKey) : undefined) ?? layout.desks[0]!;

  // Desks first (fixed seats), then decide each standing person's zone.
  let libraryCount = 0;
  for (const a of actors) {
    const desk = deskOf(a);
    if (a.station === 'desk') {
      const sit = a.role !== 'intern';
      // Interns editing stand beside their parent's desk.
      const x = sit ? desk.chair[0] : desk.chair[0] + 0.75;
      const y = sit ? desk.chair[1] : desk.chair[1] - 0.15;
      const spotId = sit ? `desk:${desk.id}` : `desk:${desk.id}:${a.key}`;
      out.set(a.key, { key: a.key, x, y, face: 'n', pose: sit ? 'sit' : 'stand', prop: sit ? propFor(a, 'desk') : 'none', deskId: desk.id, scale: scaleOf(a), zone: 'desk', spotId });
      continue;
    }
    let zone: SpotZone = STATION_ZONE[a.station] ?? 'lounge';
    if (zone === 'library') {
      libraryCount++;
      // Long reads take the armchair once the shelves are busy (§8).
      if (libraryCount === 3) zone = 'armchair';
    }
    zoneFor.set(a.key, zone);
  }

  // Ping pong takes exactly two idle people, never one and never three (D22). Players keep
  // playing while they stay idle; the rest of the idle crowd goes for coffee.
  const idle = actors.filter((a) => zoneFor.get(a.key) === 'lounge');
  if (idle.length >= 2) {
    const playing = idle.filter((a) => prev?.get(a.key)?.zone === 'pingpong');
    const waiting = idle.filter((a) => !playing.includes(a)).sort((a, b) => a.lastTs - b.lastTs || (a.key < b.key ? -1 : 1));
    for (const a of [...playing, ...waiting].slice(0, 2)) zoneFor.set(a.key, 'pingpong');
  }

  const spotAt = (zone: SpotZone, n: number): Spot => layout.spots[zone][n] ?? overflowSpot(layout.spots[zone][0]!, n - layout.spots[zone].length);
  const assign = (a: Actor, zone: SpotZone, n: number) => {
    const s = spotAt(zone, n);
    used.add(`${zone}:${n}`);
    out.set(a.key, { key: a.key, x: s.x, y: s.y, face: s.face, pose: s.pose, prop: propFor(a, zone), deskId: deskOf(a).id, scale: scaleOf(a), zone, spotId: `${zone}:${n}`, ...(s.group ? { group: `${zone}:${s.group}` } : {}) });
  };
  // Pass 1: keep the spot they already hold.
  for (const a of actors) {
    const zone = zoneFor.get(a.key);
    const before = prev?.get(a.key);
    if (!zone || !before || before.zone !== zone) continue;
    const n = Number(before.spotId.split(':')[1]);
    if (Number.isInteger(n) && !used.has(`${zone}:${n}`)) assign(a, zone, n);
  }
  // Pass 2: everyone else takes the first free spot, in order of arrival.
  for (const a of actors) {
    const zone = zoneFor.get(a.key);
    if (!zone || out.has(a.key)) continue;
    let n = 0;
    while (used.has(`${zone}:${n}`)) n++;
    assign(a, zone, n);
  }
  return out;
}

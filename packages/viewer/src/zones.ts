// What each place in the office means. Shown when you hover the floor, and in the
// "How to read the office" card; replaces the old legend row under the scene.

import { OFFICE, type OfficeLayout, type SpotZone } from './layout/layout.ts';

export interface Place {
  id: string;
  name: string;
  meaning: string;
  /** Swatch colour in the help card (matches the floor or furniture). */
  color: string;
  amber?: boolean;
}

export const PLACES: Place[] = [
  { id: 'desk', name: 'Desks', meaning: 'editing code', color: '#dfe7ef' },
  { id: 'library', name: 'Library', meaning: 'reading and searching files', color: '#f0d9b5' },
  { id: 'lab', name: 'Test lab', meaning: 'running tests and debugging', color: '#e3ece3' },
  { id: 'server', name: 'Server room', meaning: 'running shell commands', color: '#2b2f36' },
  { id: 'window', name: 'Window', meaning: 'researching on the web', color: '#9fd3f2' },
  { id: 'whiteboard', name: 'Whiteboard', meaning: 'planning, and briefing interns', color: '#ffffff' },
  { id: 'board', name: 'Mission board', meaning: 'the tasks: to do, doing, done (press B to read it)', color: '#ffe27a' },
  { id: 'archive', name: 'Archive', meaning: 'memory full: filing notes (compaction)', color: '#8a929b' },
  { id: 'lounge', name: 'Café and ping pong', meaning: 'idle, ready for work', color: '#e6dccb' },
  { id: 'door', name: 'Your door', meaning: 'someone needs your approval or answer', color: '#ffd34d', amber: true },
];

const BY_ID = new Map(PLACES.map((p) => [p.id, p]));
const SPOT_TO_PLACE: Partial<Record<SpotZone, string>> = {
  board: 'board',
  library: 'library',
  armchair: 'library',
  archive: 'archive',
  window: 'window',
  server: 'server',
  lab: 'lab',
  whiteboard: 'whiteboard',
  lounge: 'lounge',
  pingpong: 'lounge',
  door: 'door',
};
const RUG_TO_PLACE: Record<string, string> = { dev: 'desk', library: 'library', lab: 'lab', lounge: 'lounge', boss: 'door' };

/** The place under a floor point (grid units), or null on plain floor. Spots win over rugs. */
export function placeAt(x: number, y: number, layout: OfficeLayout = OFFICE): Place | null {
  let best: { id: string; d: number } | null = null;
  for (const [zone, spots] of Object.entries(layout.spots) as Array<[SpotZone, Array<{ x: number; y: number }>]>) {
    const id = SPOT_TO_PLACE[zone];
    if (!id) continue;
    for (const s of spots) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < 1.1 && (!best || d < best.d)) best = { id, d };
    }
  }
  if (best) return BY_ID.get(best.id) ?? null;
  for (const r of layout.rugs) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.d) return BY_ID.get(RUG_TO_PLACE[r.zone] ?? '') ?? null;
  }
  for (const d of layout.desks) if (x >= d.x - 0.4 && x <= d.x + d.w + 0.4 && y >= d.y - 0.4 && y <= d.y + d.d + 0.9) return BY_ID.get('desk')!;
  return null;
}

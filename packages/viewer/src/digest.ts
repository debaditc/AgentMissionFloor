// "While you were away": when Deb comes back to the board after a while, one card says what
// finished, who waited on them, and what failed since they last looked. Names come from the live
// office (the replay that finds the moments may have named people differently).

import type { AmbEvent } from '@agent-mission-floor/protocol';
import { awaySummary, buildReplay, fmtDur, type AwaySummary } from '@agent-mission-floor/world';

export const AWAY_AFTER_MS = 15 * 60_000;
/** Events from this long before `lastSeen` are replayed too, so cards and people already exist. */
const CONTEXT_MS = 6 * 60 * 60_000;
const KEY = 'amf.lastSeen';

export function loadLastSeen(): number | null {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveLastSeen(ts: number) {
  try {
    localStorage.setItem(KEY, String(ts));
  } catch {
    /* private window: no digest next time, nothing else breaks */
  }
}

export interface DigestView {
  title: string;
  lines: string[];
  tasks: Array<{ who: string; what: string }>;
}

/** Plain sentences for the card, or null when nothing worth mentioning happened. */
export function digestView(sum: AwaySummary, nameOf: (key: string) => string, keep: (key: string) => boolean = () => true): DigestView | null {
  const tasks = sum.tasks.filter((t) => keep(t.actorKey));
  const waits = sum.waits.filter((w) => keep(w.actorKey));
  const failures = sum.failures.filter((f) => keep(f.actorKey));
  if (!tasks.length && !waits.length && !failures.length && !sum.missions.length) return null;
  const lines: string[] = [];
  for (const m of sum.missions) lines.push(`Mission complete: ${m}`);
  if (tasks.length) {
    const by = new Map<string, number>();
    for (const t of tasks) by.set(nameOf(t.actorKey), (by.get(nameOf(t.actorKey)) ?? 0) + 1);
    const who = [...by].sort((a, b) => b[1] - a[1]).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
    lines.push(`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} finished (${who.join(', ')})`);
  }
  const waited = new Map<string, number>();
  for (const w of waits) waited.set(nameOf(w.actorKey), (waited.get(nameOf(w.actorKey)) ?? 0) + w.ms);
  for (const [n, ms] of [...waited].sort((a, b) => b[1] - a[1])) lines.push(`${n} waited ${fmtDur(ms)} for you`);
  if (failures.length) {
    const byWho = new Map<string, number>();
    for (const f of failures) byWho.set(nameOf(f.actorKey), (byWho.get(nameOf(f.actorKey)) ?? 0) + 1);
    const who = [...byWho].sort((a, b) => b[1] - a[1]).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
    lines.push(`${failures.length} ${failures.length === 1 ? 'failure' : 'failures'} (${who.join(', ')})`);
  }
  return {
    title: `While you were away (${fmtDur(sum.until - sum.since)})`,
    lines,
    tasks: tasks.slice(-6).reverse().map((t) => ({ who: nameOf(t.actorKey), what: t.what })),
  };
}

/** Fetches what happened since `since` and summarises it. */
export async function fetchAway(since: number, now = Date.now()): Promise<AwaySummary | null> {
  try {
    const res = await fetch(`/v1/events?since=${Math.max(1, since - CONTEXT_MS)}&until=${now}&limit=50000`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const events = (await res.json()) as AmbEvent[];
    if (!events.length) return null;
    // "Away" runs until now, not until the last thing that happened.
    return { ...awaySummary(buildReplay(events), since), until: now };
  } catch {
    return null;
  }
}

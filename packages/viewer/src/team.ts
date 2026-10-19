// The team panel's order: what matters to Deb first (pure, so it's tested without a browser).

import { isFinished, type Actor, type Card } from '@agent-mission-floor/world';

export type TeamGroup = 'needs' | 'working' | 'done' | 'idle';

export const GROUP_TITLES: Record<TeamGroup, string> = {
  needs: 'Needs you',
  working: 'Working',
  done: 'Done',
  idle: 'Idle',
};

export function groupOf(a: Actor): TeamGroup {
  if (a.status === 'waiting') return 'needs';
  if (a.status === 'working' || a.status === 'error') return 'working';
  if (isFinished(a)) return 'done';
  return 'idle';
}

export interface Row {
  actor: Actor;
  /** Interns briefed by this person, listed under them. */
  interns: Actor[];
}

/**
 * Needs you (longest waiting first) → Working → Done (most recent first) → Idle. Interns stay
 * under whoever briefed them; an intern whose parent isn't shown is listed on their own.
 */
export function groupTeam(actors: Actor[]): Array<{ group: TeamGroup; rows: Row[] }> {
  const keys = new Set(actors.map((a) => a.key));
  // Only interns sit under whoever briefed them; teammates are people in their own right.
  const nested = (a: Actor) => a.role === 'intern' && !!a.parentKey && keys.has(a.parentKey);
  const roots = actors.filter((a) => !nested(a));
  const groups: Record<TeamGroup, Row[]> = { needs: [], working: [], done: [], idle: [] };
  for (const a of roots) groups[groupOf(a)].push({ actor: a, interns: actors.filter((c) => nested(c) && c.parentKey === a.key) });
  groups.needs.sort((x, y) => (x.actor.needs?.ts ?? 0) - (y.actor.needs?.ts ?? 0));
  groups.done.sort((x, y) => (y.actor.finished?.ts ?? 0) - (x.actor.finished?.ts ?? 0));
  for (const g of [groups.working, groups.idle]) g.sort((x, y) => x.actor.startedTs - y.actor.startedTs);
  return (['needs', 'working', 'done', 'idle'] as const).filter((g) => groups[g].length).map((group) => ({ group, rows: groups[group] }));
}

/** One plain sentence about what someone is doing. */
export function sentence(a: Actor, card?: Card): string {
  if (a.status === 'waiting') {
    if (a.needs?.type === 'approval') return `Needs your approval${a.needs.tool ? ` to run ${a.needs.tool}` : ''}`;
    if (a.needs?.type === 'mission') return 'Mission complete: waiting for you to look';
    return a.needs?.message ? `Asks: ${a.needs.message}` : 'Has a question for you';
  }
  if (isFinished(a)) return `Done: ${a.finished!.what}`;
  if (a.status === 'working' || a.status === 'error') return capital(a.activity);
  void card;
  return 'Idle, ready for work';
}

/** The task line under the sentence: what they're on (nothing for waiting or finished people). */
export function taskLine(a: Actor, card?: Card): string | undefined {
  if (a.status === 'waiting' || isFinished(a)) return undefined;
  return card?.title ?? a.assignment;
}

function capital(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** "just now", "4 min ago", "2 h ago": the same wording on the panel and the board. */
export function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** Mission progress, one segment per task, in board order (done, doing, to do). */
export function segments(cards: Card[]): Array<Card['status']> {
  const rank = { completed: 0, in_progress: 1, pending: 2 } as const;
  return cards.map((c) => c.status).sort((a, b) => rank[a] - rank[b]);
}

// Side panel (spec §10.1): the mission, then the team grouped by what matters to Deb (needs you,
// working, done, idle), then a link to the raw log. Plain DOM, text only.

import { type Actor, type WorldState } from '@agent-mission-floor/world';
import { actorColor, memColor } from './overlay.ts';
import { ago, GROUP_TITLES, groupTeam, segments, sentence, taskLine, type Row } from './team.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export interface PanelHandlers {
  onSelect: (key: string) => void;
  onOpenBoard: () => void;
}

/** The Idle group stays as Deb left it (collapsed by default) across re-renders. */
let idleOpen = false;

export function renderPanel(root: HTMLElement, state: WorldState, actors: Actor[], h: PanelHandlers, now = Date.now()) {
  // Mission: the most recent team mission, else today's solo requests.
  const missions = Object.values(state.missions).sort((a, b) => b.ts - a.ts);
  const mission = missions.find((m) => !m.complete) ?? missions[0];
  const lead = mission ? state.actors[mission.sessionId] : undefined;
  const cards = Object.values(state.cards).filter((c) => (lead?.teamName ? c.teamName === lead.teamName : !c.teamName));
  const done = cards.filter((c) => c.status === 'completed').length;

  const missionBox = el('section', 'panel-sec mission');
  missionBox.append(el('h2', 'panel-h', mission ? 'Mission' : 'Today'));
  missionBox.append(el('p', 'mission-text', mission ? mission.text : cards.length ? 'Independent requests' : 'No requests yet'));
  if (cards.length) {
    // One segment per task, coloured like the board's notes. Opens the readable board.
    const bar = el('button', 'segbar');
    bar.type = 'button';
    bar.title = 'Open the mission board (B)';
    bar.setAttribute('aria-label', `${done} of ${cards.length} tasks done. Open the mission board`);
    for (const s of segments(cards)) bar.append(el('i', s));
    bar.addEventListener('click', h.onOpenBoard);
    missionBox.append(bar);
  }
  const waiting = actors.filter((a) => a.status === 'waiting').length;
  const tokens = actors.reduce((n, a) => n + (a.memory?.used ?? 0), 0);
  const today = el('p', 'today');
  const parts = [
    cards.length ? `${done} of ${cards.length} done${mission?.complete ? ', mission complete' : ''}` : '',
    `${compact(state.stats.toolCalls)} tool calls`,
    `${compact(tokens)} tokens in context`,
  ].filter(Boolean);
  for (const p of parts) today.append(el('span', '', p));
  if (waiting) today.append(el('b', 'today-wait', `${waiting} waiting on you`));
  missionBox.append(today);

  const team = el('section', 'panel-sec team-sec');
  const groups = groupTeam(actors);
  if (!groups.length) team.append(el('p', 'empty', 'Nobody in the office yet. Start a Claude Code session with the plugin, or run npm run demo.'));
  for (const { group, rows } of groups) {
    const people = rows.reduce((n, r) => n + 1 + r.interns.length, 0);
    const list = el('div', 'team');
    for (const r of rows) appendRow(list, r, state, now, h.onSelect);
    if (group === 'idle') {
      const d = el('details', `group ${group}`);
      d.open = idleOpen;
      d.addEventListener('toggle', () => (idleOpen = d.open));
      const s = el('summary', 'group-h');
      s.append(document.createTextNode(GROUP_TITLES[group]), el('span', 'count', String(people)));
      d.append(s, list);
      team.append(d);
    } else {
      const g = el('div', `group ${group}`);
      const t = el('h3', 'group-h', GROUP_TITLES[group]);
      t.append(el('span', 'count', String(people)));
      g.append(t, list);
      team.append(g);
    }
  }

  const foot = el('footer', 'panel-foot');
  const raw = el('a', '', 'Raw event log');
  raw.href = '/raw/';
  foot.append(raw);

  root.replaceChildren(missionBox, team, foot);
}

function appendRow(list: HTMLElement, r: Row, state: WorldState, now: number, onSelect: (key: string) => void) {
  for (const a of [r.actor, ...r.interns]) {
    const card = a.cardKey ? state.cards[a.cardKey] : undefined;
    const row = el('button', `member ${a.role}${a.status === 'waiting' ? ' waiting' : ''}${a.status === 'error' ? ' error' : ''}`);
    row.type = 'button';
    row.title = `Show what ${a.name} worked on`;
    row.addEventListener('click', () => onSelect(a.key));
    const av = el('span', 'avatar', a.name[0] ?? '?');
    av.style.background = actorColor(a);
    const body = el('div', 'member-body');
    const top = el('div', 'member-top');
    top.append(el('b', '', a.name));
    const role = a.handle ? a.handle.toLowerCase() : a.role === 'solo' ? '' : a.role;
    if (role) top.append(el('span', 'role', role));
    if (a.finished && a.status !== 'working' && a.status !== 'waiting') top.append(el('span', 'when', ago(now - a.finished.ts)));
    body.append(top, el('div', 'member-say', sentence(a, card)));
    const task = taskLine(a, card);
    if (task) body.append(el('div', 'member-task', task));
    // Memory as a thin bar: how much room is left before they file notes in the Archive.
    const pct = a.memory?.pctFree;
    const mem = el('span', 'membar');
    mem.title = pct === null || pct === undefined ? 'memory: unknown' : `memory: ${pct}% free`;
    const fill = el('i', '');
    fill.style.width = `${pct ?? 0}%`;
    if (pct !== null && pct !== undefined) fill.style.background = memColor(pct);
    mem.append(fill);
    row.append(av, body, mem);
    list.append(row);
  }
}

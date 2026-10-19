// Person drill-down (an early version of spec §10.3): who they are, what model, how much they
// consumed, what they worked on, their last moves. Data from GET /v1/actor?key=… (same origin, cookie auth).

import type { Actor } from '@agent-mission-floor/world';
import { actorColor, memColor } from './overlay.ts';
import { compact } from './panel.ts';

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  models: string[];
}

export interface ActorSummary {
  key: string;
  name: string;
  role: string;
  status: string;
  sessionId: string;
  agentId?: string;
  agentType?: string;
  parent?: { key: string; name: string };
  model?: string;
  models: string[];
  assignment?: string;
  assignmentDone?: boolean;
  activity: string;
  startedTs: number;
  lastTs: number;
  context: { used: number; max: number | null; pctFree: number | null } | null;
  tokens: Totals | null;
  teamTokens?: Totals | null;
  files: Array<{ path: string; reads: number; edits: number; added: number; removed: number; lastTs: number }>;
  moves: Array<{ ts: number; tool: string; text: string; ok: boolean; error?: string }>;
  mix: Record<string, number>;
  toolCalls: number;
  errors: number;
  crew: Array<{ key: string; name: string; role: string; assignment?: string; done?: boolean }>;
  lastOutput?: { ts: number; command: string; text: string; ok: boolean };
}

const MIX: Array<[string, string, string]> = [
  ['edit', 'Editing', '#1f6feb'],
  ['read', 'Reading', '#d7a24a'],
  ['test', 'Tests', '#2e9d4f'],
  ['shell', 'Shell', '#2b2f36'],
  ['web', 'Web', '#5aa2ff'],
  ['plan', 'Planning', '#b4329f'],
  ['spawn', 'Briefing', '#b4329f'],
  ['task', 'Board', '#e07b00'],
  ['other', 'Other', '#9aa3ad'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function duration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return '< 1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function shortPath(p: string, cwd?: string): string {
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  const parts = p.split('/');
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p;
}

function section(title: string, ...children: Node[]): HTMLElement {
  const s = el('section', 'panel-sec');
  s.append(el('h2', 'panel-h', title), ...children);
  return s;
}

function memRing(ctx: ActorSummary['context']): HTMLElement {
  const box = el('div', 'mem-ring');
  // Only ever a number in the markup below.
  const pct = typeof ctx?.pctFree === 'number' && Number.isFinite(ctx.pctFree) ? Math.round(ctx.pctFree) : null;
  const r = 30;
  const c = 2 * Math.PI * r;
  const frac = pct === null || pct === undefined ? 0 : pct / 100;
  const color = pct === null || pct === undefined ? '#c9ced6' : memColor(pct);
  box.innerHTML = `<svg viewBox="0 0 76 76" role="img" aria-label="memory ${pct ?? 'unknown'}% free"><circle cx="38" cy="38" r="${r}" fill="none" stroke="#e8ebef" stroke-width="9"/><circle cx="38" cy="38" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 38 38)"/><text x="38" y="36" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="15" font-weight="600" fill="#1d2433">${pct ?? '—'}${pct === null || pct === undefined ? '' : '%'}</text><text x="38" y="50" text-anchor="middle" font-family="Rubik, sans-serif" font-size="9" fill="#5b6576">free</text></svg>`;
  const p = el('p');
  p.textContent = ctx
    ? `${ctx.used.toLocaleString()} of ${ctx.max ? ctx.max.toLocaleString() : '?'} tokens in context. When it fills, they go to the Archive to compact their notes.`
    : 'Memory unknown until their first reply is written to the transcript.';
  box.append(p);
  return box;
}

function tokenTiles(t: Totals | null | undefined): HTMLElement {
  const box = el('div', 'tokens');
  const tile = (v: number | null, label: string) => {
    const d = el('div');
    d.append(el('b', '', v === null ? '—' : compact(v)), el('span', '', label));
    return d;
  };
  box.append(
    tile(t?.output ?? null, 'output tokens'),
    tile(t ? t.input + t.cacheWrite : null, 'new input tokens'),
    tile(t?.cacheRead ?? null, 'cached input read'),
    tile(t?.messages ?? null, 'model replies'),
  );
  return box;
}

export function renderDrawer(
  root: HTMLElement,
  actor: Actor | undefined,
  s: ActorSummary | null,
  onBack: () => void,
  onSelect: (key: string) => void,
  follow: { following: boolean; onFollow: () => void } = { following: false, onFollow: () => {} },
) {
  const back = el('button', 'back', '← Back to the team');
  back.type = 'button';
  back.addEventListener('click', onBack);
  if (!actor) {
    root.replaceChildren(back, el('p', 'empty', 'This person has left the office.'));
    return;
  }

  const who = el('section', 'panel-sec');
  const head = el('div', 'who');
  const av = el('span', 'avatar', actor.name[0] ?? '?');
  av.style.background = actorColor(actor);
  const title = el('div');
  title.append(el('h2', '', actor.name), el('div', 'sub', `${actor.role}${actor.handle ? ` · ${actor.handle.toLowerCase()}` : ''}${s?.parent ? ` · reports to ${s.parent.name}` : ''}`));
  head.append(av, title);
  const chips = el('div', 'chips');
  chips.append(el('span', `state-${actor.status}`, actor.status));
  const model = s?.model ?? actor.model;
  chips.append(el('span', '', model ? `model ${model}` : 'model —'));
  chips.append(el('span', '', `on the job ${duration((s?.lastTs ?? actor.lastTs) - actor.startedTs)}`));
  chips.append(el('span', '', `session ${actor.sessionId.slice(0, 8)}`));
  // Close-up actions (§10.3): Follow keeps the camera on them; Open file jumps to the latest one.
  const actions = el('div', 'drawer-actions');
  const followBtn = el('button', `btn${follow.following ? ' on' : ''}`, follow.following ? 'Following' : 'Follow');
  followBtn.type = 'button';
  followBtn.setAttribute('aria-pressed', String(follow.following));
  followBtn.addEventListener('click', follow.onFollow);
  actions.append(followBtn);
  const latest = s?.files[0];
  if (latest) {
    const open = el('a', 'btn', 'Open file');
    open.href = `vscode://file${latest.path.startsWith('/') ? '' : '/'}${encodeURI(latest.path).replace(/[?#]/g, encodeURIComponent)}`;
    open.title = latest.path;
    actions.append(open);
  }
  who.append(head, chips, actions);

  const task = el('dl', 'kv');
  const assignment = actor.assignment ?? s?.assignment;
  task.append(el('dt', '', 'Assignment'), el('dd', '', assignment ? `${actor.assignmentDone ? '✓ ' : ''}${assignment}` : '—'));
  task.append(el('dt', '', 'Doing now'), el('dd', '', actor.status === 'waiting' ? 'Waiting on you' : actor.activity));
  task.append(el('dt', '', 'Tool calls'), el('dd', '', `${actor.toolCalls}${actor.errors ? ` (${actor.errors} failed)` : ''}`));
  if (s && s.models.length > 1) task.append(el('dt', '', 'Models used'), el('dd', '', s.models.join(', ')));

  const usage = el('div');
  usage.append(memRing(actor.memory), tokenTiles(s?.tokens));
  if (s?.teamTokens) {
    usage.append(el('h2', 'panel-h', 'Whole team (lead + crew)'));
    usage.append(tokenTiles(s.teamTokens));
  }

  const parts: HTMLElement[] = [back, who, section('Work', task), section('Consumption', usage)];

  if (s) {
    const totalMix = Object.values(s.mix).reduce((a, b) => a + b, 0);
    if (totalMix) {
      const bar = el('div', 'mix');
      const legend = el('div', 'mix-legend');
      for (const [k, label, color] of MIX) {
        const n = s.mix[k];
        if (!n) continue;
        const seg = el('i');
        seg.style.cssText = `width:${(n / totalMix) * 100}%;background:${color}`;
        bar.append(seg);
        const li = el('span');
        const sw = el('i');
        sw.style.background = color;
        li.append(sw, `${label} ${n}`);
        legend.append(li);
      }
      parts.push(section('Where the time went', bar, legend));
    }

    const files = el('ul', 'files');
    for (const f of s.files) {
      const li = el('li');
      li.title = f.path;
      const counts = el('span', 'counts');
      if (f.edits) {
        counts.append(`edited ${f.edits}× `);
        counts.append(el('span', 'add', `+${f.added}`), ' ', el('span', 'del', `−${f.removed}`));
      }
      if (f.reads) counts.append(`${f.edits ? ' · ' : ''}read ${f.reads}×`);
      li.append(el('span', '', shortPath(f.path, actor.cwd)), counts);
      files.append(li);
    }
    if (!s.files.length) files.append(el('li', 'empty', 'No files touched yet.'));
    parts.push(section(`Files on their desk (${s.files.length})`, files));

    const moves = el('ul', 'moves');
    for (const m of s.moves.slice(0, 40)) {
      const li = el('li', m.ok ? '' : 'fail');
      const time = el('time', '', new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
      li.append(time, el('span', '', m.ok ? m.text : `${m.text} → ${m.error ?? 'failed'}`));
      moves.append(li);
    }
    if (!s.moves.length) moves.append(el('li', 'empty', 'No moves yet.'));
    parts.push(section('Last moves', moves));

    if (s.crew.length) {
      const crew = el('ul', 'moves crew');
      for (const c of s.crew) {
        const li = el('li');
        li.addEventListener('click', () => onSelect(c.key));
        li.append(el('b', '', c.name), el('span', '', `${c.done ? '✓ ' : ''}${c.assignment ?? c.role}`));
        crew.append(li);
      }
      parts.push(section('Their crew', crew));
    }
  } else parts.push(el('p', 'empty', 'Loading details…'));

  const wrap = el('div', 'drawer');
  wrap.append(...parts);
  root.replaceChildren(wrap);
}

export async function fetchSummary(key: string): Promise<ActorSummary | null> {
  try {
    const res = await fetch(`/v1/actor?key=${encodeURIComponent(key)}`, { credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as ActorSummary) : null;
  } catch {
    return null;
  }
}

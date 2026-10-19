// DOM overlay (spec §1: text lives in HTML, never in the 3D scene). Every label is anchored to
// a projected scene position each frame; only `transform` changes per frame.

import { isBlocked, isFinished, isStale, TEAM_COLORS, type Actor, type Bubble, type Card, type WorldState } from '@agent-mission-floor/world';
import { OFFICE } from './layout/layout.ts';
import { planeMatrix, type ScreenPoint, type Stage } from './scene/stage.ts';
import { tintColor } from './scene/character.ts';

const SVG = 'http://www.w3.org/2000/svg';

/** Leisure icons the viewer sets on its own (they're not world state). */
const LEISURE = {
  chat: { label: 'chatting over coffee', svg: '<path d="M4 6h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="7" cy="11" r="1" fill="currentColor"/><circle cx="10" cy="11" r="1" fill="currentColor"/><circle cx="13" cy="11" r="1" fill="currentColor"/>' },
  coffee: { label: 'having a coffee', svg: '<path d="M5 9h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 10h1.5a2 2 0 0 1 0 4H16" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 4c0 1.5 1.5 1.5 1.5 3M12 4c0 1.5 1.5 1.5 1.5 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' },
  pingpong: { label: 'playing ping pong', svg: '<circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M14.2 14.2l5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="18.5" cy="6" r="1.8" fill="currentColor"/>' },
} as const;
export type Leisure = keyof typeof LEISURE;

const ICONS: Record<Exclude<Bubble, null>, { svg: string; label: string }> = {
  edit: { label: 'editing', svg: '<path d="M4 20l4-1 10-10-3-3L5 16l-1 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' },
  read: { label: 'reading', svg: '<circle cx="10" cy="10" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14.5 14.5L20 20" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' },
  shell: { label: 'shell', svg: '<path d="M4 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 18h8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' },
  test: { label: 'running tests', svg: '<path d="M4 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 18h8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' },
  bug: { label: 'failing', svg: '<ellipse cx="12" cy="13" rx="5" ry="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v12M7 10l-3-2M17 10l3-2M7 15H3M17 15h4M9 6l-1-2M15 6l1-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' },
  check: { label: 'passed', svg: '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' },
  web: { label: 'web research', svg: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16" fill="none" stroke="currentColor" stroke-width="1.6"/>' },
  plan: { label: 'planning', svg: '<rect x="6" y="5" width="12" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 4h6v3H9zM9 11h6M9 15h4" stroke="currentColor" stroke-width="1.8" fill="none"/>' },
  archive: { label: 'filing notes', svg: '<path d="M4 8h16v11H4zM3 5h18v3H3zM10 12h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' },
  idle: { label: 'idle', svg: '<text x="12" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" font-family="Rubik, sans-serif">zz</text>' },
  question: { label: 'question for you', svg: '<text x="12" y="17" text-anchor="middle" font-size="15" font-weight="800" fill="currentColor" font-family="Rubik, sans-serif">?</text>' },
  approval: { label: 'needs approval', svg: '<text x="12" y="17.5" text-anchor="middle" font-size="16" font-weight="800" fill="currentColor" font-family="Rubik, sans-serif">!</text>' },
  thinking: { label: 'thinking', svg: '<circle cx="7" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="17" cy="12" r="1.6" fill="currentColor"/>' },
  error: { label: 'error', svg: '<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>' },
};

export function actorColor(a: Actor): string {
  const base = TEAM_COLORS[a.color % TEAM_COLORS.length]!;
  return a.tint ? tintColor(base) : base;
}

export function memColor(pct: number): string {
  return pct > 50 ? '#2e9d4f' : pct >= 25 ? '#f2a900' : '#c4361b';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

interface ActorEls {
  tag: HTMLDivElement;
  name: HTMLSpanElement;
  icon: HTMLSpanElement;
  /** The card they took from the board, shown in their label while they carry it. */
  carry: HTMLSpanElement;
  activity: HTMLSpanElement;
  task: HTMLDivElement;
  memFill: HTMLElement;
  memText: HTMLSpanElement;
  chip: HTMLDivElement;
  /** Thin line from the label down to the head, so a pushed-up label still points at its person. */
  leader: HTMLDivElement;
  sig: string;
  /** Natural level of detail from their state; collisions can only shrink it. */
  base: Lod;
  prio: number;
  /** Measured label size per level of detail (re-measured only when content changes). */
  sizes: Partial<Record<Lod, { w: number; h: number }>>;
  /** Interns: whoever briefed them (dashed tether). */
  parentKey?: string;
  color: string;
}

/** dot: idle (icon only) · pill: one line · card: full details (hover / selected). */
type Lod = 'dot' | 'pill' | 'card';

function trimWords(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

export class Overlay {
  private layer: HTMLElement;
  private actors = new Map<string, ActorEls>();
  private board: HTMLDivElement;
  private cols: Record<'pending' | 'in_progress' | 'completed', HTMLDivElement>;
  private glass: HTMLDivElement;
  private tethers: SVGSVGElement;
  private lines = new Map<string, SVGLineElement>();
  private arcs = new Map<string, SVGPathElement>();
  private conflictPairs: Array<[string, string]> = [];
  private bossOutline: SVGPolygonElement;
  private terminal: HTMLDivElement;
  private terminalKey: string | null = null;
  private flashes: Array<{ key: string; el: HTMLDivElement; until: number }> = [];
  private boss: HTMLDivElement;
  private bossAct: HTMLSpanElement;
  /** Clicking Deb (the human) opens the inbox. */
  onBoss: (() => void) | null = null;
  /** Clicking the wall board opens the readable Board sheet. */
  onBoard: (() => void) | null = null;
  private boardSig = '';
  /** Called when a name tag is clicked. */
  onSelect: ((key: string) => void) | null = null;
  private selected: string | null = null;
  private hovered: string | null = null;
  private leisure = new Map<string, Leisure>();
  readonly BOARD_W = 420;
  readonly BOARD_H = 112;

  constructor(layer: HTMLElement) {
    this.layer = layer;
    this.board = el('div', 'board-plane');
    this.board.title = 'Read the mission board (B)';
    this.board.addEventListener('click', () => this.onBoard?.());
    this.board.style.width = `${this.BOARD_W}px`;
    this.board.style.height = `${this.BOARD_H}px`;
    const title = el('div', 'board-title', 'MISSION BOARD');
    const grid = el('div', 'board-cols');
    const mk = (label: string) => {
      const c = el('div', 'board-col');
      c.append(el('div', 'board-col-h', label));
      const list = el('div', 'board-list');
      c.append(list);
      grid.append(c);
      return list;
    };
    this.cols = { pending: mk('To do'), in_progress: mk('Doing'), completed: mk('Done') };
    this.board.append(title, grid);
    this.glass = el('div', 'glass-label', OFFICE.boss.label);
    this.tethers = document.createElementNS(SVG, 'svg');
    this.tethers.setAttribute('class', 'tethers');
    this.tethers.setAttribute('aria-hidden', 'true');
    this.bossOutline = document.createElementNS(SVG, 'polygon');
    this.bossOutline.setAttribute('class', 'boss-outline');
    this.tethers.append(this.bossOutline);
    // Deb: the human, the AI Orchestrator. Their own label, never part of world state.
    this.boss = el('div', 'tag boss-tag');
    this.boss.dataset.lod = 'pill';
    const brow = el('div', 'tag-row');
    const bicon = el('span', 'tag-icon b-boss');
    bicon.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 17l2-9 4 4 2-6 2 6 4-4 2 9z" fill="currentColor"/></svg>';
    this.bossAct = el('span', 'tag-act', 'AI Orchestrator');
    brow.append(bicon, el('span', 'tag-name', 'Deb'), this.bossAct);
    this.boss.append(brow);
    this.boss.title = 'Deb, the AI Orchestrator (you). Click to open your inbox.';
    this.boss.addEventListener('click', () => this.onBoss?.());
    this.terminal = el('div', 'terminal-card');
    this.terminal.hidden = true;
    this.layer.append(this.tethers, this.board, this.glass, this.terminal, this.boss);
  }

  private ensure(a: Actor): ActorEls {
    let e = this.actors.get(a.key);
    if (e) return e;
    // One label above the head: status icon, name · what they're doing, assignment, memory.
    const tag = el('div', 'tag');
    tag.addEventListener('click', () => this.onSelect?.(a.key));
    tag.addEventListener('pointerenter', () => (this.hovered = a.key));
    tag.addEventListener('pointerleave', () => {
      if (this.hovered === a.key) this.hovered = null;
    });
    const row = el('div', 'tag-row');
    const icon = el('span', 'tag-icon');
    const name = el('span', 'tag-name');
    const carry = el('span', 'tag-carry');
    carry.setAttribute('aria-label', 'carrying a card');
    const activity = el('span', 'tag-act');
    row.append(icon, name, carry, activity);
    const task = el('div', 'tag-task');
    const mem = el('div', 'tag-mem');
    const bar = el('span', 'mem-bar');
    const memFill = el('i', '');
    bar.append(memFill);
    const memText = el('span', 'mem-text');
    mem.append(bar, memText);
    tag.append(row, task, mem);
    const chip = el('div', 'chip-act');
    const leader = el('div', 'leader');
    this.layer.append(leader, tag, chip);
    e = { tag, name, icon, carry, activity, task, memFill, memText, chip, leader, sig: '', base: 'dot', prio: 0, sizes: {}, color: '#9aa3ad' };
    this.actors.set(a.key, e);
    return e;
  }

  private lastState: WorldState | null = null;

  /** Content updates (only when the actor changed). */
  sync(state: WorldState, visible: Set<string>) {
    this.lastState = state;
    for (const [key, e] of this.actors) {
      if (!visible.has(key)) {
        e.tag.remove();
        e.chip.remove();
        e.leader.remove();
        this.actors.delete(key);
      }
    }
    for (const key of visible) {
      const a = state.actors[key]!;
      const card = a.cardKey ? state.cards[a.cardKey] : undefined;
      const assignment = card?.title ?? a.assignment;
      const fun = a.status === 'idle' ? this.leisure.get(key) : undefined;
      // Finished their work and not started anything new: a green ✓ until they do.
      const done = isFinished(a);
      const sig = JSON.stringify([a.name, a.activity, a.bubble, a.status, a.memory?.pctFree, a.chip, assignment, a.assignmentDone, a.role, a.color, a.tint, this.selected === key, fun, done && a.finished]);
      const e = this.ensure(a);
      if (e.sig === sig) continue;
      e.sig = sig;
      e.sizes = {};
      const color = actorColor(a);
      e.color = color;
      e.parentKey = a.role === 'intern' ? a.parentKey : undefined;
      e.tag.style.setProperty('--ring', a.bubble === 'bug' || a.bubble === 'error' ? '#c4361b' : color);
      e.name.textContent = a.name;
      e.name.dataset.handle = a.handle ? a.handle.toLowerCase() : '';
      const leisure = fun ? LEISURE[fun].label[0]!.toUpperCase() + LEISURE[fun].label.slice(1) : undefined;
      const doing = done && a.needs?.type === 'mission' ? 'Mission complete' : done ? (leisure ? `Done, ${leisure.toLowerCase()}` : 'Done') : leisure ?? (a.status === 'waiting' ? (a.needs?.type === 'approval' ? 'Needs your approval' : a.needs?.type === 'mission' ? 'Mission complete' : 'Has a question for you') : a.activity);
      e.activity.textContent = trimWords(doing, 34);
      const shownTask = done ? a.finished!.what : assignment;
      e.task.textContent = shownTask ? `${done || a.assignmentDone ? '✓ ' : ''}${trimWords(shownTask, 40)}` : '';
      e.task.hidden = !shownTask;
      e.carry.hidden = !card || card.status !== 'in_progress';
      e.carry.title = card ? `Carrying: ${card.title}` : '';
      e.tag.classList.toggle('done', !!a.assignmentDone || done);
      e.tag.classList.toggle('finished', done);
      e.tag.classList.toggle('alert', a.status === 'waiting');
      e.base = a.status === 'waiting' || a.status === 'working' || a.status === 'error' || done ? 'pill' : 'dot';
      e.prio = a.status === 'waiting' ? 4 : a.status === 'error' ? 3 : a.status === 'working' ? 2 : done ? 1.5 : 1;
      e.tag.classList.toggle('intern', a.role === 'intern');
      e.tag.classList.toggle('selected', this.selected === key);
      e.tag.title = `${a.name} (${a.handle ? a.handle.toLowerCase() : a.role})${assignment ? `\n${assignment}` : ''}\n${doing}\nClick for details`;
      e.tag.classList.toggle('waiting', a.status === 'waiting');
      const pct = a.memory?.pctFree;
      if (pct === null || pct === undefined) {
        e.memFill.style.width = '0';
        e.memText.textContent = '— free';
      } else {
        e.memFill.style.width = `${pct}%`;
        e.memFill.style.background = memColor(pct);
        e.memText.textContent = `${pct}% free`;
      }
      const b = a.bubble ?? (a.status === 'working' ? 'thinking' : 'idle');
      const icon = done ? { label: 'done', svg: ICONS.check.svg } : fun ? LEISURE[fun] : ICONS[b];
      e.icon.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">${icon.svg}</svg>`;
      e.icon.className = `tag-icon b-${done ? 'done' : (fun ?? b)}`;
      e.icon.setAttribute('role', 'img');
      e.icon.setAttribute('aria-label', icon.label);
      // The activity text now says what they do; the chip is kept for errors only.
      if (a.chip?.tone === 'error' && a.status !== 'idle') {
        e.chip.textContent = a.chip.text;
        e.chip.className = 'chip-act error';
        e.chip.hidden = false;
      } else e.chip.hidden = true;
    }
  }

  /** Café and ping pong icons replace the idle "zz" while people are doing something fun. */
  setLeisure(key: string, what: Leisure | null) {
    const cur = this.leisure.get(key) ?? null;
    if (cur === what) return;
    if (what) this.leisure.set(key, what);
    else this.leisure.delete(key);
    const e = this.actors.get(key);
    if (!e || !this.lastState) return;
    // Repaint this label now: a calm office may not sync again for a while.
    e.sig = '';
    const s = this.lastState;
    this.sync(s, new Set([...this.actors.keys()].filter((k) => s.actors[k])));
  }

  /** Place and word Deb's label. `waiting`: who's at the door (first) and how many. */
  setBoss(head: ScreenPoint | null, waiting: { first?: string; count: number }) {
    if (!head) {
      this.boss.hidden = true;
      return;
    }
    this.boss.hidden = false;
    const text = waiting.count === 0 ? 'AI Orchestrator' : waiting.count === 1 ? `Listening to ${waiting.first ?? 'someone'}` : `${waiting.count} waiting on you`;
    if (this.bossAct.textContent !== text) this.bossAct.textContent = text;
    this.boss.classList.toggle('alert', waiting.count > 0);
    const w = this.boss.offsetWidth || 160;
    const h = this.boss.offsetHeight || 28;
    this.boss.style.transform = `translate(${Math.round(head.x - w / 2)}px, ${Math.round(head.y - h - 6)}px)`;
  }

  /** Inbox view: everyone who doesn't need you fades to grey; the AI Orchestrator's office is outlined. */
  setInboxMode(on: boolean) {
    this.layer.classList.toggle('inbox', on);
  }

  /** People who just edited the same file: warning outline on both, dashed red arc between them. */
  setConflicts(pairs: Array<[string, string]>) {
    this.conflictPairs = pairs;
    const involved = new Set(pairs.flat());
    for (const [k, e] of this.actors) e.tag.classList.toggle('conflict', involved.has(k));
  }

  /** Close-up: a dark terminal card with the person's latest output, next to them. */
  setTerminal(key: string | null, out?: { command: string; text: string; ok: boolean }) {
    this.terminalKey = key && out ? key : null;
    this.terminal.hidden = !this.terminalKey;
    if (!out || !key) return;
    const lines = out.text.split('\n').slice(-8).join('\n');
    this.terminal.replaceChildren(el('div', 'term-cmd', `$ ${out.command}`), el('pre', `term-out${out.ok ? '' : ' fail'}`, lines));
  }

  /** Replay: a short floating note above someone when a key moment happens. */
  flash(key: string, text: string, now: number) {
    const n = el('div', 'moment-flash', text);
    this.layer.append(n);
    this.flashes.push({ key, el: n, until: now + 3200 });
  }

  clearFlashes() {
    for (const f of this.flashes) f.el.remove();
    this.flashes = [];
  }

  select(key: string | null) {
    this.selected = key;
    for (const [k, e] of this.actors) {
      e.tag.classList.toggle('selected', k === key);
      e.sig = '';
      e.sizes = {};
    }
  }

  /**
   * Per-frame positions with level of detail. Labels sit just above heads and never stack:
   * when two would overlap, the less important one shrinks to its status dot. Order of
   * importance: selected/hovered, needs you, error, working, idle; nearer people first.
   */
  position(anchors: Map<string, { head: ScreenPoint; feet: ScreenPoint }>) {
    const lodOf = (key: string, e: ActorEls): Lod => (key === this.selected || key === this.hovered ? 'card' : e.base);
    const rank = (key: string, e: ActorEls) => (key === this.selected || key === this.hovered ? 9 : e.prio);
    const order = [...this.actors.keys()]
      .filter((k) => anchors.has(k))
      .sort((a, b) => {
        const ea = this.actors.get(a)!;
        const eb = this.actors.get(b)!;
        return rank(b, eb) - rank(a, ea) || anchors.get(b)!.feet.y - anchors.get(a)!.feet.y;
      });
    const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
    for (const key of order) {
      const e = this.actors.get(key)!;
      const p = anchors.get(key)!;
      let lod = lodOf(key, e);
      let { w, h } = this.size(e, lod);
      let x0 = p.head.x - w / 2;
      let y0 = p.head.y - h - 6;
      if (lod !== 'dot' && placed.some((r) => x0 < r.x1 && x0 + w > r.x0 && y0 < r.y1 && y0 + h > r.y0)) {
        lod = 'dot';
        ({ w, h } = this.size(e, lod));
        x0 = p.head.x - w / 2;
        y0 = p.head.y - h - 6;
      }
      this.setLod(e, lod);
      if (lod !== 'dot') placed.push({ x0, x1: x0 + w, y0, y1: y0 + h });
      e.tag.style.transform = `translate(${Math.round(x0)}px, ${Math.round(y0)}px)`;
      e.tag.style.zIndex = String(rank(key, e) * 10 + (lod === 'dot' ? 0 : 5));
      e.leader.style.height = '0';
      e.chip.style.transform = `translate(${Math.round(p.feet.x + 16)}px, ${Math.round(p.feet.y - 26)}px)`;
    }
    this.drawTethers(anchors);
    this.drawArcs(anchors);
    const tk = this.terminalKey ? anchors.get(this.terminalKey) : undefined;
    if (tk) this.terminal.style.transform = `translate(${Math.round(tk.feet.x + 40)}px, ${Math.round(tk.feet.y - 150)}px)`;
    const now = performance.now();
    this.flashes = this.flashes.filter((f) => {
      const a = anchors.get(f.key);
      if (now > f.until || !a) {
        f.el.remove();
        return false;
      }
      f.el.style.transform = `translate(${Math.round(a.head.x)}px, ${Math.round(a.head.y - 64)}px) translateX(-50%)`;
      return true;
    });
  }

  private drawArcs(anchors: Map<string, { head: ScreenPoint; feet: ScreenPoint }>) {
    const live = new Set<string>();
    for (const [a, b] of this.conflictPairs) {
      const pa = anchors.get(a);
      const pb = anchors.get(b);
      if (!pa || !pb) continue;
      const id = `${a}|${b}`;
      live.add(id);
      let path = this.arcs.get(id);
      if (!path) {
        path = document.createElementNS(SVG, 'path');
        path.setAttribute('class', 'conflict-arc');
        this.tethers.append(path);
        this.arcs.set(id, path);
      }
      const mx = (pa.head.x + pb.head.x) / 2;
      const my = Math.min(pa.head.y, pb.head.y) - 60;
      path.setAttribute('d', `M${pa.head.x.toFixed(1)},${pa.head.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${pb.head.x.toFixed(1)},${pb.head.y.toFixed(1)}`);
    }
    for (const [id, p] of this.arcs) {
      if (!live.has(id)) {
        p.remove();
        this.arcs.delete(id);
      }
    }
  }

  private drawTethers(anchors: Map<string, { head: ScreenPoint; feet: ScreenPoint }>) {
    const live = new Set<string>();
    for (const [key, e] of this.actors) {
      const a = anchors.get(key);
      const b = e.parentKey ? anchors.get(e.parentKey) : undefined;
      if (!a || !b) continue;
      live.add(key);
      let line = this.lines.get(key);
      if (!line) {
        line = document.createElementNS(SVG, 'line');
        this.tethers.append(line);
        this.lines.set(key, line);
      }
      line.setAttribute('x1', a.feet.x.toFixed(1));
      line.setAttribute('y1', a.feet.y.toFixed(1));
      line.setAttribute('x2', b.feet.x.toFixed(1));
      line.setAttribute('y2', b.feet.y.toFixed(1));
      line.setAttribute('stroke', e.color);
    }
    for (const [key, line] of this.lines) {
      if (!live.has(key)) {
        line.remove();
        this.lines.delete(key);
      }
    }
  }

  /** Size of a label at a level of detail; measures once, then served from cache. */
  private size(e: ActorEls, lod: Lod): { w: number; h: number } {
    const cached = e.sizes[lod];
    if (cached) return cached;
    const prev = e.tag.dataset.lod;
    e.tag.dataset.lod = lod;
    const s = { w: e.tag.offsetWidth || 24, h: e.tag.offsetHeight || 24 };
    if (prev) e.tag.dataset.lod = prev;
    e.sizes[lod] = s;
    return s;
  }

  private setLod(e: ActorEls, lod: Lod) {
    if (e.tag.dataset.lod === lod) return;
    e.tag.dataset.lod = lod;
  }

  /** Board and glass label follow the camera (affine maps onto their wall planes). */
  positionPlanes(stage: Stage) {
    if (this.layer.classList.contains('inbox')) {
      const B = OFFICE.boss;
      const pts = [
        [B.x0, B.y0],
        [B.x1, B.y0],
        [B.x1, B.y1],
        [B.x0, B.y1],
      ].map(([x, y]) => stage.project(x!, y!, 0.02));
      this.bossOutline.setAttribute('points', pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    }
    const B = OFFICE.board;
    const depth = 0.075;
    this.board.style.transform = planeMatrix(
      stage.project(B.x0, depth, B.z1),
      stage.project(B.x1, depth, B.z1),
      stage.project(B.x0, depth, B.z0),
      this.BOARD_W,
      this.BOARD_H,
    );
    const G = OFFICE.boss;
    const gx0 = G.x0 + 0.35;
    const gx1 = G.x0 + 4.2;
    this.glass.style.transform = planeMatrix(stage.project(gx0, G.y0 + 0.03, 1.5), stage.project(gx1, G.y0 + 0.03, 1.5), stage.project(gx0, G.y0 + 0.03, 1.2), 420, 32);
  }

  /** Cards are kept by key so they can animate: pop onto To do, move to Doing, pin to Done. */
  private notes = new Map<string, { el: HTMLElement; status: string; sig: string }>();

  syncBoard(state: WorldState, now: number) {
    const cards = Object.values(state.cards).sort((a, b) => a.createdTs - b.createdTs);
    const sig = JSON.stringify(cards.map((c) => [c.key, c.status, c.title, c.ownerKey, c.failed, isStale(c, state, now), isBlocked(c, state)]));
    if (sig === this.boardSig) return;
    const firstPaint = this.boardSig === '';
    this.boardSig = sig;
    const maxPer = { pending: 4, in_progress: 4, completed: 4 };
    const seen = new Set<string>();
    for (const status of ['pending', 'in_progress', 'completed'] as const) {
      const list = cards.filter((c) => c.status === status);
      // Done shows the most recent; the others the oldest first.
      const shown = status === 'completed' ? list.slice(-maxPer[status]) : list.slice(0, maxPer[status]);
      const nodes: HTMLElement[] = [];
      for (const c of shown) {
        seen.add(c.key);
        const cardSig = JSON.stringify([c.title, c.ownerKey, c.failed, isStale(c, state, now), isBlocked(c, state)]);
        let n = this.notes.get(c.key);
        const isNew = !n;
        const moved = !!n && n.status !== c.status;
        if (!n || n.sig !== cardSig || moved) {
          const fresh = this.card(c, state, now);
          n = { el: fresh, status: c.status, sig: cardSig };
          this.notes.set(c.key, n);
          // New cards pop onto To do, moved cards pop into their column, Done gets a check-mark pop.
          if (!firstPaint && (isNew || moved)) fresh.classList.add(moved && c.status === 'completed' ? 'pinned' : 'pop');
        }
        nodes.push(n.el);
      }
      const extra = list.length - shown.length;
      if (extra > 0) nodes.push(el('div', 'note more', `+${extra}`));
      this.cols[status].replaceChildren(...nodes);
    }
    for (const k of [...this.notes.keys()]) if (!seen.has(k)) this.notes.delete(k);
  }

  private card(c: Card, state: WorldState, now: number): HTMLElement {
    const n = el('div', `note ${c.status}${c.failed ? ' failed' : ''}`);
    const owner = c.ownerKey ? state.actors[c.ownerKey] : undefined;
    const title = el('span', 'note-title', c.title);
    const meta = el('span', 'note-meta');
    if (owner) {
      const d = el('i', 'note-dot');
      d.style.background = actorColor(owner);
      meta.append(d);
    }
    if (isBlocked(c, state)) meta.append(el('span', 'badge', '🔒'));
    if (isStale(c, state, now)) meta.append(el('span', 'badge stale', 'stale?'));
    // Done notes say who finished them ("✓ Ron"), so the board reads as a list of finished work.
    if (c.status === 'completed') meta.append(el('span', 'badge done', owner ? `✓ ${owner.name}` : '✓'));
    n.title = c.status === 'completed' ? `Done: ${c.title}${owner ? `, by ${owner.name}` : ''}` : `${c.title}${owner ? ` · ${owner.name}` : ''}`;
    n.append(title, meta);
    return n;
  }
}

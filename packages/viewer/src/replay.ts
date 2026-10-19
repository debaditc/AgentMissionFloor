// Replay (spec §10.4): load today's stored events, replay them through the same pure reducer the
// collector uses, and drive the office with a virtual clock. Timeline lanes, key moments, an
// end-of-day debrief, speeds, a 30 s highlight reel, and WebM export.

import { buildReplay, fmtDur, reduce, stateAt, TEAM_COLORS, type LaneKind, type Moment, type ReplayIndex, type WorldState } from '@agent-mission-floor/world';
import type { AmbEvent } from '@agent-mission-floor/protocol';
import { tintColor } from './scene/character.ts';

export const SPEEDS = [1, 4, 8, 30, 60] as const;
export const HIGHLIGHT_S = 30;

export const LANE_COLORS: Record<LaneKind, string> = {
  desk: '#8fb0de',
  library: '#d9bf94',
  lab: '#9fc39c',
  door: '#f2a900',
  lounge: '#d8cfc2',
  other: '#c9ced6',
};
const LANE_LABELS: Array<[LaneKind, string]> = [
  ['desk', 'Desk'],
  ['library', 'Library & window'],
  ['lab', 'Lab & server room'],
  ['door', 'At your door'],
  ['lounge', 'Café & ping pong'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

export class ReplayController {
  index: ReplayIndex | null = null;
  state: WorldState | null = null;
  clock = 0;
  playing = false;
  speed: number = 8;
  /** Bumped whenever the replayed state changes (the scene re-syncs). */
  version = 0;
  /** Set when time jumped (seek): the scene places people instantly and clears trails. */
  jumped = false;
  /** A highlight reel is running (for export). */
  highlight = false;
  onMoment: ((m: Moment) => void) | null = null;
  onEnd: (() => void) | null = null;
  private next = 0;
  private momentIdx = 0;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private clockEl: HTMLElement | null = null;
  private playBtn: HTMLButtonElement | null = null;

  async load(): Promise<void> {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const res = await fetch(`/v1/events?since=${since.getTime()}&until=${Date.now()}&limit=50000`, { credentials: 'same-origin' });
    const events = res.ok ? ((await res.json()) as AmbEvent[]) : [];
    this.index = buildReplay(events);
    this.seek(this.index.start);
  }

  get loaded(): boolean {
    return this.index !== null && this.index.events.length > 0;
  }

  seek(ts: number) {
    const idx = this.index;
    if (!idx) return;
    this.clock = Math.max(idx.start, Math.min(idx.end, ts));
    this.state = stateAt(idx, this.clock);
    this.next = idx.events.findIndex((e) => e.ts > this.clock);
    if (this.next < 0) this.next = idx.events.length;
    this.momentIdx = idx.moments.findIndex((m) => m.ts > this.clock);
    if (this.momentIdx < 0) this.momentIdx = idx.moments.length;
    this.version++;
    this.jumped = true;
    this.paint();
  }

  play(on = !this.playing) {
    if (on && this.index && this.clock >= this.index.end) this.seek(this.index.start);
    this.playing = on;
    if (!on) this.highlight = false;
    this.paint();
  }

  /** Whole day compressed into 30 seconds, from the start. */
  startHighlight() {
    const idx = this.index;
    if (!idx) return;
    this.seek(idx.start);
    this.speed = Math.max(1, (idx.end - idx.start) / (HIGHLIGHT_S * 1000));
    this.highlight = true;
    this.playing = true;
    this.paint();
  }

  /** Advance by real seconds; returns the virtual seconds that passed (for walking speed). */
  tick(dt: number): number {
    const idx = this.index;
    if (!idx || !this.playing || !this.state) return 0;
    const vdt = dt * this.speed;
    this.clock = Math.min(idx.end, this.clock + vdt * 1000);
    let changed = false;
    while (this.next < idx.events.length && idx.events[this.next]!.ts <= this.clock) {
      this.state = reduce(this.state, idx.events[this.next]!);
      this.next++;
      changed = true;
    }
    while (this.momentIdx < idx.moments.length && idx.moments[this.momentIdx]!.ts <= this.clock) {
      this.onMoment?.(idx.moments[this.momentIdx]!);
      this.momentIdx++;
    }
    if (changed) this.version++;
    if (this.clock >= idx.end) {
      this.playing = false;
      const wasHighlight = this.highlight;
      this.highlight = false;
      if (wasHighlight) this.onEnd?.();
      this.paint();
    }
    this.paintPlayhead();
    return vdt;
  }

  // ---------- Timeline UI (full width below the scene) ----------

  mount(root: HTMLElement, onExport: () => void) {
    this.root = root;
    root.replaceChildren();
    const bar = el('div', 'tl-bar');
    this.playBtn = el('button', 'btn tl-play', 'Play');
    this.playBtn.type = 'button';
    this.playBtn.addEventListener('click', () => this.play());
    this.clockEl = el('span', 'tl-clock', '—');
    const speeds = el('div', 'tl-speeds');
    speeds.setAttribute('role', 'radiogroup');
    speeds.setAttribute('aria-label', 'Playback speed');
    for (const s of SPEEDS) {
      const b = el('button', 'btn quiet', `${s}×`);
      b.type = 'button';
      b.dataset.speed = String(s);
      b.addEventListener('click', () => {
        this.speed = s;
        this.highlight = false;
        this.paint();
      });
      speeds.append(b);
    }
    const reel = el('button', 'btn', 'Highlight reel (30 s)');
    reel.type = 'button';
    reel.addEventListener('click', () => this.startHighlight());
    const exp = el('button', 'btn', 'Export clip');
    exp.type = 'button';
    exp.addEventListener('click', onExport);
    bar.append(this.playBtn, this.clockEl, speeds, reel, exp);

    this.canvas = el('canvas', 'tl-lanes');
    this.canvas.setAttribute('role', 'slider');
    this.canvas.setAttribute('aria-label', 'Timeline: click or drag to jump');
    const seekAt = (ev: PointerEvent) => {
      const idx = this.index;
      if (!idx || !this.canvas) return;
      const r = this.canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (ev.clientX - r.left - this.labelW()) / (r.width - this.labelW())));
      this.seek(idx.start + (idx.end - idx.start) * x);
    };
    let dragging = false;
    this.canvas.addEventListener('pointerdown', (ev) => {
      dragging = true;
      this.canvas!.setPointerCapture(ev.pointerId);
      seekAt(ev);
    });
    this.canvas.addEventListener('pointermove', (ev) => dragging && seekAt(ev));
    this.canvas.addEventListener('pointerup', () => (dragging = false));

    const legend = el('ul', 'legend tl-legend');
    for (const [k, label] of LANE_LABELS) {
      const li = el('li');
      const sw = el('i');
      sw.style.background = LANE_COLORS[k];
      li.append(sw, label);
      legend.append(li);
    }
    const scroller = el('div', 'tl-scroll');
    scroller.append(this.canvas);
    root.append(bar, scroller, legend);
    this.paint();
  }

  private labelW() {
    return 92;
  }

  /** Full repaint: buttons, lanes. */
  paint() {
    if (!this.root || !this.canvas) return;
    if (this.playBtn) this.playBtn.textContent = this.playing ? 'Pause' : 'Play';
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.tl-speeds button')) {
      const on = Number(b.dataset.speed) === this.speed && !this.highlight;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.paintPlayhead();
  }

  private paintPlayhead() {
    const idx = this.index;
    const c = this.canvas;
    if (!c || !this.clockEl) return;
    if (!idx || !idx.events.length) {
      this.clockEl.textContent = 'No events today yet';
      return;
    }
    this.clockEl.textContent = `${clock(this.clock)} / ${clock(idx.end)}`;
    const lanes = idx.lanes;
    const rowH = 16;
    const top = 14;
    const cssW = c.clientWidth || 800;
    const cssH = top + Math.max(1, lanes.length) * rowH + 6;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      c.style.height = `${cssH}px`;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    const L = this.labelW();
    const span = Math.max(1, idx.end - idx.start);
    const xOf = (ts: number) => L + ((ts - idx.start) / span) * (cssW - L - 4);
    g.font = '11px Rubik, system-ui, sans-serif';
    lanes.forEach((lane, i) => {
      const y = top + i * rowH;
      g.fillStyle = '#5b6576';
      g.fillText(lane.name.slice(0, 12), 4, y + 11);
      for (const b of lane.blocks) {
        g.fillStyle = LANE_COLORS[b.kind];
        const x0 = xOf(b.start);
        g.fillRect(x0, y + 2, Math.max(1.5, xOf(b.end) - x0), rowH - 5);
      }
    });
    // Key moments as ticks along the top.
    for (const m of idx.moments) {
      if (m.kind === 'arrived' || m.kind === 'left') continue;
      g.fillStyle = m.kind === 'waited' ? '#f2a900' : m.kind === 'failed' || m.kind === 'conflict' ? '#c4361b' : '#2e9d4f';
      g.fillRect(xOf(m.ts) - 1, 2, 2, 8);
    }
    const px = xOf(this.clock);
    g.fillStyle = '#1d2433';
    g.fillRect(px - 1, 0, 2, cssH);
  }

  // ---------- Side panel: end-of-day debrief + jump list ----------

  renderDebrief(root: HTMLElement) {
    const idx = this.index;
    const wrap = el('div', 'drawer');
    const sec = el('section', 'panel-sec');
    sec.append(el('h2', 'panel-h', 'End-of-day debrief'));
    if (!idx || !idx.events.length) {
      sec.append(el('p', 'empty', 'Nothing to replay yet today. Come back after some work has happened.'));
      root.replaceChildren(wrap);
      wrap.append(sec);
      return;
    }
    const d = idx.debrief;
    const kv = el('dl', 'kv');
    const row = (k: string, v: string) => kv.append(el('dt', '', k), el('dd', '', v));
    row('Day', `${clock(d.start)} – ${clock(d.end)} (${fmtDur(d.end - d.start)})`);
    row('Tasks done', `${d.tasksDone} of ${d.tasksTotal}`);
    row('Files touched', String(d.filesTouched));
    row('Team time working', `${d.workingPct}%`);
    row('Waiting on you', fmtDur(d.waitingMs));
    row('Tool calls', `${d.toolCalls}${d.errors ? ` (${d.errors} failed)` : ''}`);
    sec.append(kv);

    const jump = el('section', 'panel-sec');
    jump.append(el('h2', 'panel-h', 'Jump to'));
    const list = el('ul', 'moves jump');
    const shown = idx.moments.filter((m) => m.kind !== 'arrived' && m.kind !== 'left');
    for (const m of shown.slice(-60)) {
      const li = el('li', `jm-${m.kind}`);
      li.tabIndex = 0;
      li.append(el('time', '', clock(m.ts)), el('span', '', m.text));
      const go = () => this.seek(m.ts - 1500);
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      list.append(li);
    }
    if (!shown.length) list.append(el('li', 'empty', 'No notable moments yet.'));
    jump.append(list);
    wrap.append(sec, jump);
    root.replaceChildren(wrap);
  }
}

export function laneColorFor(color: number, tint: boolean): string {
  const base = TEAM_COLORS[color % TEAM_COLORS.length]!;
  return tint ? tintColor(base) : base;
}

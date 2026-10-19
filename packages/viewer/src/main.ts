// AgentMissionFloor viewer. Three views over one office scene:
// - Office floor (live): the team at work.
// - Your inbox: who needs you; the rest of the office fades back (spec §10.2).
// - Replay: today's events through the same reducer, on a virtual clock (spec §10.4).

import '@fontsource/rubik/400.css';
import '@fontsource/rubik/500.css';
import '@fontsource/rubik/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import * as THREE from 'three/webgpu';
import { emptyWorld, filterByProject, hashString, inboxItems, inConflict, isFinished, projectOf, projectsIn, TEAM_COLORS, type WorldState } from '@agent-mission-floor/world';
import { Stage } from './scene/stage.ts';
import { buildOffice, setScreen } from './scene/office.ts';
import { Character, tintColor } from './scene/character.ts';
import { Overlay } from './overlay.ts';
import { renderPanel } from './panel.ts';
import { fetchSummary, renderDrawer, type ActorSummary } from './drawer.ts';
import { PERSON_SCALE, placeActors, visibleActors, type Placement } from './placement.ts';
import { Choreographer, type Frame } from './choreo.ts';
import { Rally } from './scene/rally.ts';
import { NavGrid } from './nav.ts';
import { OFFICE } from './layout/layout.ts';
import { loadDismissed, Notifier, renderInbox, saveDismissed } from './inbox.ts';
import { ReplayController } from './replay.ts';
import { Trails } from './scene/trails.ts';
import { ClipRecorder, download, type LabelSpot } from './export.ts';
import { BoardSheet } from './boardsheet.ts';
import { AWAY_AFTER_MS, digestView, fetchAway, loadLastSeen, saveLastSeen } from './digest.ts';
import { PLACES, placeAt } from './zones.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = () => motionQuery.matches;

type Mode = 'live' | 'inbox' | 'replay';
let mode: Mode = 'live';

let liveState: WorldState = emptyWorld();
let liveVersion = 0;
let placedVersion = -1;
let placements = new Map<string, Placement>();
let lastPlaceAt = 0;

const stage = new Stage($('scene'));
const office = buildOffice();
stage.scene.add(office.root);
const overlay = new Overlay($('overlay'));
const characters = new Map<string, Character>();
const scales = new Map<string, number>();
const notifier = new Notifier();
let dismissed = loadDismissed();
const replay = new ReplayController();
const trails = new Trails();
stage.scene.add(trails.mesh);
const recorder = new ClipRecorder();

// Walking: a navigation grid (rebuilt only when overflow desks appear) and the choreographer.
let activeDesks = new Set<string>();
let choreo = new Choreographer(new NavGrid(OFFICE, activeDesks));
let firstSync = true;
const rally = new Rally();
stage.scene.add(rally.ball);

// ---------- Deb, the AI Orchestrator (the human) ----------
// Always in the glass office, working at the desk. When someone comes to the door with a
// question or an approval, Deb walks to the inside of the door to listen, then goes back to work.
const DEB = '__deb';
const deb = new Character(DEB, reducedMotion);
deb.setColor('#2f3a4f');
stage.scene.add(deb.group);
const debWalk = new Choreographer(new NavGrid(OFFICE, new Set()));
const B = OFFICE.boss;
const debSeat: Placement = { key: DEB, x: B.chair[0], y: B.chair[1], face: 'n', pose: 'sit', prop: 'typing', deskId: 'boss', scale: PERSON_SCALE, zone: 'desk', spotId: 'boss:seat' };
const debListen: Placement = { key: DEB, x: B.x0 + 0.65, y: (B.doorGap[0] + B.doorGap[1]) / 2, face: 'w', pose: 'stand', prop: 'none', deskId: 'boss', scale: PERSON_SCALE, zone: 'door', spotId: 'boss:door' };
let debPlaced = false;

/** Who's at the door for Deb right now (first in line, and how many). */
function waitingAtDoor(state: WorldState): { first?: string; count: number } {
  const waiting = Object.values(state.actors)
    .filter((a) => a.status === 'waiting' && a.needs)
    .sort((a, b) => (a.needs!.ts ?? 0) - (b.needs!.ts ?? 0));
  return { ...(waiting[0] ? { first: waiting[0].name } : {}), count: waiting.length };
}

function updateDeb(now: number, dt: number, t: number, state: WorldState) {
  const waiting = waitingAtDoor(state);
  debWalk.update(new Map([[DEB, waiting.count ? debListen : debSeat]]), now, { instant: !debPlaced || reducedMotion() });
  debPlaced = true;
  debWalk.flush(now, reducedMotion());
  const f = debWalk.step(dt, now).frames[0];
  if (f) deb.apply(f, PERSON_SCALE);
  deb.setTalking(waiting.count > 0 && !!f && !f.walking);
  deb.update(t, dt);
  return waiting;
}

/** What the scene shows: the live office, or the replayed one at the replay clock. */
function view(): { state: WorldState; now: number; version: number } {
  if (mode === 'replay' && replay.state) return { state: filterByProject(replay.state, project), now: replay.clock, version: replay.version + 1_000_000 };
  return { state: filterByProject(liveState, project), now: Date.now(), version: liveVersion };
}

// ---------- Project filter ----------
// Several repos at once: show one (the inbox badge still counts everyone, so nothing is missed).
function storedProject(): string | null {
  const q = new URLSearchParams(location.search).get('project');
  if (q) return q;
  try {
    return localStorage.getItem('amf.project');
  } catch {
    return null;
  }
}
let project: string | null = storedProject();

function setProject(next: string | null) {
  if (next === project) return;
  project = next;
  try {
    if (next) localStorage.setItem('amf.project', next);
    else localStorage.removeItem('amf.project');
  } catch {
    /* remembered for this visit only */
  }
  const url = new URL(location.href);
  if (next) url.searchParams.set('project', next);
  else url.searchParams.delete('project');
  history.replaceState(null, '', url);
  // A different office: everyone is placed afresh rather than walking out and in.
  for (const c of characters.values()) c.dispose();
  characters.clear();
  scales.clear();
  if (selected) select(null);
  resetScene();
  placedVersion = -1;
  sideSig = '';
}
$<HTMLSelectElement>('project').addEventListener('change', (e) => setProject((e.target as HTMLSelectElement).value || null));

// ---------- Toast ----------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}
notifier.onToast = toast;

// ---------- Modes ----------
function setMode(next: Mode) {
  if (next === mode) return;
  const wasReplay = mode === 'replay';
  mode = next;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button[data-mode]')) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $('timeline').hidden = mode !== 'replay';
  $('replay-badge').hidden = mode !== 'replay';
  document.querySelector('.scene-card')!.classList.toggle('inbox', mode === 'inbox');
  overlay.setInboxMode(mode === 'inbox');
  if (mode === 'replay' || wasReplay) resetScene();
  if (mode === 'replay') void enterReplay();
  else replay.play(false);
  if (selected) select(null);
  placedVersion = -1;
  sideSig = '';
}

for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button[data-mode]')) {
  b.addEventListener('click', () => setMode(b.dataset.mode as Mode));
}

/** Switching between live and replay: everyone is placed where they are, trails start fresh. */
function resetScene() {
  choreo = new Choreographer(new NavGrid(OFFICE, activeDesks));
  firstSync = true;
  placements = new Map();
  trails.clear();
  overlay.clearFlashes();
}

let replayLoading = false;
/** "Replay it" from the away card: start the replay where Deb left. */
let seekOnLoad: number | null = null;
async function enterReplay() {
  if (replayLoading) return;
  replayLoading = true;
  $('timeline').replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Loading today…' }));
  await replay.load();
  replayLoading = false;
  replay.mount($('timeline'), () => void exportClip());
  replay.onMoment = (m) => overlay.flash(m.actorKey, m.text, performance.now());
  sideSig = '';
  // Deep links: ?view=replay&at=0.4 (fraction of the day) &play=1 &speed=30
  const q = new URLSearchParams(location.search);
  const at = Number(q.get('at'));
  if (replay.index && Number.isFinite(at) && at > 0) replay.seek(replay.index.start + (replay.index.end - replay.index.start) * Math.min(1, at));
  if (replay.index && seekOnLoad) {
    replay.seek(Math.max(replay.index.start, seekOnLoad));
    seekOnLoad = null;
  }
  const speed = Number(q.get('speed'));
  if (speed > 0) replay.speed = speed;
  if (q.get('play') === '1') replay.play(true);
}

async function exportClip() {
  if (!ClipRecorder.supported()) return toast('This browser can’t record video.');
  if (!replay.loaded) return toast('Nothing to export yet today.');
  const canvas = stage.renderer.domElement;
  recorder.start(canvas.width, canvas.height);
  replay.onEnd = async () => {
    replay.onEnd = null;
    const blob = await recorder.stop();
    const day = new Date(replay.index!.start).toISOString().slice(0, 10);
    download(blob, `agent-mission-floor-${day}.webm`);
    toast('Clip saved');
  };
  replay.startHighlight();
  resetScene();
  toast('Recording the 30 s highlight reel…');
}

// ---------- Leisure (D22) ----------
/**
 * Idle time: the two ping pong players rally; at each café table one person talks while the
 * others listen, taking turns every few seconds. Labels show what fun they're having.
 */
function leisure(walked: Frame[], t: number, dt: number) {
  const players: Frame[] = [];
  const tables = new Map<string, string[]>();
  const loungers: string[] = [];
  for (const f of walked) {
    const p = f.placement;
    if (!p || f.walking) continue;
    if (p.zone === 'pingpong') players.push(f);
    else if (p.group) tables.set(p.group, [...(tables.get(p.group) ?? []), f.key]);
    else if (p.zone === 'lounge') loungers.push(f.key);
  }
  players.sort((a, b) => a.pos.x - b.pos.x);
  const both = players.length === 2;
  const poses = rally.update(dt, both ? players[0]!.pos : null, both ? players[1]!.pos : null, reducedMotion());
  const fun = new Map<string, 'pingpong' | 'chat' | 'coffee'>();
  if (both && poses) {
    characters.get(players[0]!.key)?.setPlay(poses[0]);
    characters.get(players[1]!.key)?.setPlay(poses[1]);
  }
  for (const f of players) fun.set(f.key, 'pingpong');
  const talking = new Set<string>();
  for (const [group, keys] of tables) {
    keys.sort();
    if (keys.length >= 2) {
      const speaker = keys[Math.floor(t / 3.2 + (hashString(group) % 7)) % keys.length]!;
      talking.add(speaker);
      for (const k of keys) fun.set(k, k === speaker ? 'chat' : 'coffee');
    } else for (const k of keys) fun.set(k, 'coffee');
  }
  for (const k of loungers) fun.set(k, 'coffee');
  for (const [key, c] of characters) {
    c.setTalking(talking.has(key));
    if (!both || fun.get(key) !== 'pingpong') c.setPlay(null);
    overlay.setLeisure(key, fun.get(key) ?? null);
  }
}

const raycaster = new THREE.Raycaster();

// ---------- Selection, close-up, Follow ----------
let selected: string | null = new URLSearchParams(location.search).get('select');
let summary: ActorSummary | null = null;
let summaryFor: string | null = null;
let summaryAt = 0;
let focusPending = !!selected;
let following = false;

function select(key: string | null) {
  selected = key;
  summary = null;
  summaryFor = null;
  following = false;
  overlay.select(key);
  overlay.setTerminal(null);
  for (const [k, c] of characters) c.setSelected(k === key);
  if (key) {
    const w = choreo.walkers.get(key);
    // Close-up (§10.3): zoom ~2.4× onto their station.
    if (w) stage.focusOn(w.pos.x, w.pos.y, 0.9, 2.4);
    else focusPending = true;
    if (mode !== 'replay') void refreshSummary();
  } else stage.resetView();
  sideSig = '';
  renderSide(view().now);
}

async function refreshSummary() {
  const key = selected;
  if (!key || mode === 'replay') return;
  summaryAt = Date.now();
  const s = await fetchSummary(key);
  if (selected !== key) return;
  summary = s;
  summaryFor = key;
  overlay.setTerminal(key, s?.lastOutput);
  sideSig = '';
  renderSide(view().now);
}

function toggleFollow() {
  following = !following;
  sideSig = '';
  renderSide(view().now);
}

let sideSig = '';
function renderSide(now: number) {
  const root = $('panel');
  const { state } = view();
  if (selected) {
    const a = state.actors[selected];
    const sig = JSON.stringify([mode, selected, following, summaryFor === selected ? summary : null, a?.status, a?.activity, a?.assignment, a?.assignmentDone, a?.memory, a?.toolCalls, a?.model]);
    if (sig === sideSig) return;
    sideSig = sig;
    renderDrawer(root, a, summaryFor === selected ? summary : null, () => select(null), (k) => select(k), { following, onFollow: toggleFollow });
    return;
  }
  if (mode === 'replay') {
    const sig = `replay:${replay.index?.events.length ?? -1}`;
    if (sig === sideSig) return;
    sideSig = sig;
    replay.renderDebrief(root);
    return;
  }
  if (mode === 'inbox') {
    const items = inboxItems(state, now);
    const sig = JSON.stringify(['inbox', items.map((i) => i.id), [...dismissed].length, notifier.permission, Object.values(state.actors).filter((a) => a.status === 'working').map((a) => a.activity), Math.floor(now / 30000)]);
    if (sig === sideSig) return;
    sideSig = sig;
    renderInbox(root, state, items, dismissed, now, notifier, {
      onShow: (k) => select(k),
      onDismiss: (id) => {
        dismissed.add(id);
        saveDismissed(dismissed);
        sideSig = '';
        renderSide(view().now);
      },
      onEnableNotifications: () =>
        void notifier.enable().then(() => {
          sideSig = '';
          renderSide(view().now);
        }),
    });
    return;
  }
  sideSig = '';
  renderPanel(root, state, visibleActors(state, now), { onSelect: (k) => select(k), onOpenBoard: openBoard }, now);
}

overlay.onSelect = (k) => select(k);
overlay.onBoard = () => openBoard();

// ---------- Board sheet, Focus mode, help ----------
const sheet = new BoardSheet($('sheet'));
sheet.onSelect = (k) => select(k);
function openBoard() {
  sheet.show(view().state, view().now);
}
$('board-btn').addEventListener('click', openBoard);

function toggleFocus(on = !document.body.classList.contains('focus')) {
  document.body.classList.toggle('focus', on);
  $('focus-btn').textContent = on ? 'Exit focus' : 'Focus';
}
$('focus-btn').addEventListener('click', () => toggleFocus());

const HELP_KEY = 'amf.help.seen';
function showHelp(on: boolean) {
  const help = $('help');
  help.hidden = !on;
  if (!on) {
    try {
      localStorage.setItem(HELP_KEY, '1');
    } catch {
      /* shown again next visit */
    }
    return;
  }
  const card = document.createElement('section');
  card.className = 'help-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'How to read the office');
  const h = document.createElement('h2');
  h.textContent = 'How to read the office';
  const intro = document.createElement('p');
  intro.textContent = 'Each Claude Code session is a person. Where they stand tells you what they are doing:';
  const list = document.createElement('ul');
  for (const p of PLACES) {
    const li = document.createElement('li');
    const sw = document.createElement('i');
    sw.style.background = p.color;
    if (p.amber) li.className = 'amber';
    const b = document.createElement('b');
    b.textContent = p.name;
    li.append(sw, b, document.createTextNode(` ${p.meaning}`));
    list.append(li);
  }
  const tips = document.createElement('p');
  tips.className = 'help-tips';
  tips.textContent = 'Click a person for what they worked on. A green ✓ means their work is done; amber means they need you. Keys: B board, F focus, Esc close.';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'primary';
  ok.textContent = 'Got it';
  ok.addEventListener('click', () => showHelp(false));
  card.append(h, intro, list, tips, ok);
  help.replaceChildren(card);
  ok.focus();
}
$('help-btn').addEventListener('click', () => showHelp($('help').hidden));
$('help').addEventListener('click', (e) => {
  if (e.target === $('help')) showHelp(false);
});
try {
  // Once per browser: shown on the first visit, then only from the ? button.
  if (!localStorage.getItem(HELP_KEY)) {
    localStorage.setItem(HELP_KEY, '1');
    showHelp(true);
  }
} catch {
  /* storage blocked: don't nag */
}

window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
  if (e.key === 'Escape') {
    if (!$('help').hidden) return showHelp(false);
    if (sheet.open) return sheet.close();
    if (selected || following) return select(null);
    if (document.body.classList.contains('focus')) return toggleFocus(false);
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'b' || e.key === 'B') return sheet.open ? sheet.close() : openBoard();
  if (e.key === 'f' || e.key === 'F') return toggleFocus();
  if (e.key === '?') return showHelp($('help').hidden);
  if (e.key === ' ' && mode === 'replay' && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    replay.play();
  }
});

// ---------- Hover a place: what it means (replaces the legend row) ----------
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const floorHit = new THREE.Vector3();
let tipAt = 0;
stage.renderer.domElement.addEventListener('pointermove', (e) => {
  const tip = $('zone-tip');
  if (e.buttons || performance.now() - tipAt < 60) return;
  tipAt = performance.now();
  const ndc = stage.ndc(e.clientX, e.clientY);
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), stage.camera);
  const place = raycaster.ray.intersectPlane(floorPlane, floorHit) ? placeAt(floorHit.x, floorHit.z) : null;
  if (!place) {
    tip.hidden = true;
    return;
  }
  const box = (tip.parentElement as HTMLElement).getBoundingClientRect();
  tip.textContent = '';
  const b = document.createElement('b');
  b.textContent = place.name;
  tip.append(b, document.createTextNode(` ${place.meaning}`));
  tip.classList.toggle('amber', !!place.amber);
  tip.style.transform = `translate(${Math.round(e.clientX - box.left + 14)}px, ${Math.round(e.clientY - box.top + 16)}px)`;
  tip.hidden = false;
});
stage.renderer.domElement.addEventListener('pointerleave', () => ($('zone-tip').hidden = true));
overlay.onBoss = () => setMode('inbox');
stage.renderer.domElement.addEventListener('click', (e) => {
  // A drag that pans the camera isn't a click.
  if (Math.hypot(e.clientX - stage.downAt.x, e.clientY - stage.downAt.y) > 4) return;
  const ndc = stage.ndc(e.clientX, e.clientY);
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), stage.camera);
  const hits = raycaster.intersectObjects([...characters.values()].map((c) => c.group).concat(deb.group), true);
  for (const h of hits) {
    let o: THREE.Object3D | null = h.object;
    while (o && !o.userData.actorKey) o = o.parent;
    if (o?.userData.actorKey === DEB) return setMode('inbox');
    if (o) return select(o.userData.actorKey as string);
  }
});
stage.renderer.domElement.addEventListener('pointerdown', () => {
  if (following) toggleFollow();
});

// ---------- Perf HUD (backtick) ----------
const hud = $('hud');
let hudOn = false;
window.addEventListener('keydown', (e) => {
  if (e.key === '`') {
    hudOn = !hudOn;
    hud.hidden = !hudOn;
  }
});
stage.backend.then((b) => (hud.dataset.backend = b));

function shirt(color: number, tint: boolean): string {
  const base = TEAM_COLORS[color % TEAM_COLORS.length]!;
  return tint ? tintColor(base) : base;
}

// ---------- Scene sync ----------
function syncScene() {
  const { state, now, version } = view();
  // Sticky: people keep their spot in a zone when others come and go.
  placements = placeActors(state, now, OFFICE, placements);
  const visible = new Set(placements.keys());

  // Overflow desks appear when assigned; the walking grid follows.
  const owned = new Set<string>();
  for (const p of placements.values()) owned.add(p.deskId);
  const overflow = new Set([...owned].filter((id) => OFFICE.desks.some((d) => d.id === id && d.overflow)));
  if ([...overflow].join() !== [...activeDesks].join()) {
    activeDesks = overflow;
    choreo.setGrid(new NavGrid(OFFICE, activeDesks));
  }
  for (const [id, g] of office.deskGroups) if (OFFICE.desks.some((d) => d.id === id && d.overflow)) g.visible = owned.has(id);

  for (const [key, p] of placements) {
    scales.set(key, p.scale);
    let c = characters.get(key);
    if (!c) {
      c = new Character(key, reducedMotion);
      characters.set(key, c);
      stage.scene.add(c.group);
      c.setSelected(key === selected);
    }
    const a = state.actors[key]!;
    c.setColor(shirt(a.color, a.tint));
  }
  // On first load (and after a replay seek) everyone is already at their spot; afterwards they
  // walk in from the front edge (interns appear beside whoever briefed them).
  const jumped = mode === 'replay' && replay.jumped;
  if (jumped) {
    replay.jumped = false;
    trails.clear();
  }
  choreo.update(placements, now, {
    instant: firstSync || jumped || reducedMotion(),
    spawnNear: (key) => {
      const parent = state.actors[key]?.parentKey;
      const w = parent ? choreo.walkers.get(parent) : undefined;
      return w ? { x: w.pos.x + 0.6, y: w.pos.y + 0.3 } : undefined;
    },
  });
  if (version > 0) firstSync = false;
  stage.invalidateShadows();

  overlay.sync(state, visible);
  overlay.syncBoard(state, now);
  sheet.render(state, now);
  const pairs: Array<[string, string]> = [];
  const hot = inConflict(state, now);
  for (const c of state.conflicts ?? []) if (hot.has(c.first.actorKey) && now - c.ts < 5 * 60_000) pairs.push([c.first.actorKey, c.second.actorKey]);
  overlay.setConflicts(pairs);
  const actors = visibleActors(state, now);
  if (focusPending && selected && choreo.walkers.get(selected) && !firstSync) {
    focusPending = false;
    overlay.select(selected);
    const w = choreo.walkers.get(selected)!;
    stage.focusOn(w.pos.x, w.pos.y, 0.9, 2.4);
    void refreshSummary();
  }
  // The drawer refreshes live while open (at most every 2 s).
  if (selected && mode !== 'replay' && Date.now() - summaryAt > 2000) void refreshSummary();
  renderSide(now);
  renderHeader(actors);
  if (mode !== 'replay') {
    notifier.update(inboxItems(liveState, Date.now()), liveState);
    notifier.updateFinished(liveState);
  }
}

let presenceSig = '';
let projectSig = '';
function renderHeader(actors: ReturnType<typeof visibleActors>) {
  // Presence: one dot per person, amber if they need you, a green check when their work is done.
  const sig = JSON.stringify(actors.map((a) => [a.key, a.name, a.color, a.tint, a.status, isFinished(a)]));
  if (sig !== presenceSig) {
    presenceSig = sig;
    const box = $('presence');
    const working = actors.filter((a) => a.status === 'working').length;
    const waiting = actors.filter((a) => a.status === 'waiting').length;
    const done = actors.filter((a) => isFinished(a)).length;
    box.title = `${actors.length} in the office: ${working} working, ${waiting} waiting on you, ${done} done`;
    box.replaceChildren(
      ...actors.map((a) => {
        const d = document.createElement('button');
        d.type = 'button';
        d.className = `pdot${a.status === 'waiting' ? ' waiting' : ''}${isFinished(a) ? ' done' : ''}${a.status === 'working' ? ' working' : ''}`;
        d.style.setProperty('--c', shirt(a.color, a.tint));
        const what = a.status === 'waiting' ? 'needs you' : isFinished(a) ? 'done' : a.status;
        d.title = `${a.name}: ${what}`;
        d.setAttribute('aria-label', `${a.name}, ${what}`);
        d.addEventListener('click', () => select(a.key));
        return d;
      }),
    );
  }
  // The inbox badge always reflects the live office, even while replaying.
  const live = inboxItems(liveState, Date.now()).filter((i) => !dismissed.has(i.id));
  const badge = $('inbox-badge');
  badge.textContent = String(live.length);
  badge.hidden = live.length === 0;
  // Project: a plain chip with one project, a picker with several.
  const shown = new Set(visibleActors(liveState, Date.now()).map((v) => v.key));
  const projects = projectsIn(liveState, (a) => shown.has(a.key));
  const psig = JSON.stringify([projects, project]);
  if (psig !== projectSig) {
    projectSig = psig;
    const pick = $<HTMLSelectElement>('project');
    const many = projects.length > 1 || (!!project && !projects.some((p) => p.path === project));
    pick.hidden = !many;
    $('repo-chip').hidden = many;
    if (many) {
      const total = projects.reduce((n, p) => n + p.people, 0);
      const opts = [{ value: '', label: `All projects (${total})` }, ...projects.map((p) => ({ value: p.path, label: `${p.name} (${p.people})` }))];
      if (project && !projects.some((p) => p.path === project)) opts.push({ value: project, label: `${project.split('/').pop()} (0)` });
      pick.replaceChildren(
        ...opts.map((o) => {
          const op = document.createElement('option');
          op.value = o.value;
          op.textContent = o.label;
          op.title = o.value;
          op.selected = o.value === (project ?? '');
          return op;
        }),
      );
    } else {
      const only = projects[0];
      $('repo').textContent = only ? only.name : 'no session';
      $('repo-chip').title = only ? only.path : 'Project folder';
    }
  }
}

// ---------- Frame loop ----------
const headV = new THREE.Vector3();
const anchors = new Map<string, { head: { x: number; y: number }; feet: { x: number; y: number } }>();
let last = performance.now();
let frames = 0;
let fpsAt = last;

// Balance: full frame rate only while something moves; a calm office renders at half rate.
// If frames run slow anyway, drop to the lighter quality tier (once, never back automatically).
let skip = false;
const frameTimes: number[] = [];

stage.renderer.setAnimationLoop(() => {
  const nowPerf = performance.now();
  const replaying = mode === 'replay' && replay.playing;
  const moving = stage.busy || following || replaying || recorder.recording || choreo.isMoving() || choreo.hasPending() || debWalk.isMoving() || debWalk.hasPending();
  if (!moving && !reducedMotion()) {
    skip = !skip;
    if (skip) return;
  }
  const dt = Math.min(0.1, (nowPerf - last) / 1000);
  if (moving) stage.invalidateShadows();
  frameTimes.push(nowPerf - last);
  if (frameTimes.length > 90) {
    frameTimes.shift();
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    // At half rate a healthy frame is ~33 ms; well beyond that means the GPU is struggling.
    if (stage.quality === 'high' && avg > (moving ? 26 : 45) && !recorder.recording) {
      stage.setQuality('low');
      frameTimes.length = 0;
    }
  }
  last = nowPerf;
  const t = nowPerf / 1000;

  // Replay advances its virtual clock; people walk at virtual speed so they keep up.
  const vdt = mode === 'replay' ? replay.tick(dt) : dt;
  const { version, now } = view();
  if (placedVersion !== version || Date.now() - lastPlaceAt > 1000) {
    placedVersion = version;
    lastPlaceAt = Date.now();
    syncScene();
  }
  stage.tick(dt);
  // Walk everyone; people who left are removed once they're out of the door.
  choreo.flush(now, reducedMotion());
  const { frames: walked, gone } = choreo.step(mode === 'replay' ? vdt : dt, now);
  const lit = new Set<string>();
  const { state } = view();
  for (const f of walked) {
    const c = characters.get(f.key);
    if (!c) continue;
    c.apply(f, scales.get(f.key) ?? 1);
    if (f.placement && f.placement.pose === 'sit' && f.placement.prop === 'typing') lit.add(f.placement.deskId);
    if (mode === 'replay') {
      const a = state.actors[f.key];
      if (a) trails.record(f.key, f.pos.x, f.pos.y, f.walking, shirt(a.color, a.tint));
    }
  }
  for (const key of gone) {
    characters.get(key)?.dispose();
    characters.delete(key);
    scales.delete(key);
  }
  leisure(walked, t, dt);
  // Monitors light up once their owner has sat down to work.
  for (const [id, s] of office.screens) setScreen(s, lit.has(id));
  for (const c of characters.values()) c.update(t, dt);
  const debWaiting = updateDeb(now, mode === 'replay' ? vdt : dt, t, state);
  if (following && selected) {
    const w = choreo.walkers.get(selected);
    if (w) stage.centerOn(w.pos.x, w.pos.y, 0.9);
  }

  // Server LEDs blink only while someone is running shell commands there.
  const busyServer = [...placements.values()].some((p) => state.actors[p.key]?.station === 'server' && state.actors[p.key]?.status === 'working');
  office.rackLeds.forEach((led, i) => (led.visible = !busyServer || reducedMotion() || Math.sin(t * 6 + i * 1.7) > -0.3));

  stage.render();
  anchors.clear();
  for (const [key, c] of characters) {
    if (!placements.has(key)) continue; // walking out: no label
    c.headTop(headV);
    const g = c.group.position;
    anchors.set(key, { head: stage.projectWorld(headV), feet: stage.project(g.x, g.z, 0) });
  }
  overlay.position(anchors);
  overlay.positionPlanes(stage);
  deb.headTop(headV);
  overlay.setBoss(stage.projectWorld(headV), debWaiting);

  if (recorder.recording) {
    const labels: LabelSpot[] = [];
    for (const [key, p] of anchors) {
      const a = state.actors[key];
      if (a) labels.push({ x: p.head.x, y: p.head.y, name: a.name, color: shirt(a.color, a.tint), alert: a.status === 'waiting' });
    }
    deb.headTop(headV);
    const dh = stage.projectWorld(headV);
    labels.push({ x: dh.x, y: dh.y, name: 'Deb · AI Orchestrator', color: '#1d2433', alert: debWaiting.count > 0 });
    const when = new Date(replay.clock).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    recorder.frame(stage.renderer.domElement, labels, `AgentMissionFloor · ${when}`);
  }

  frames++;
  if (hudOn && nowPerf - fpsAt > 500) {
    const fps = Math.round((frames * 1000) / (nowPerf - fpsAt));
    const info = stage.renderer.info.render as { drawCalls?: number; calls?: number };
    hud.textContent = `${fps} fps · ${info.drawCalls ?? info.calls ?? '?'} draws · ${characters.size} people · ${hud.dataset.backend ?? '…'} · ${stage.quality}`;
    frames = 0;
    fpsAt = nowPerf;
  } else if (!hudOn && nowPerf - fpsAt > 500) {
    frames = 0;
    fpsAt = nowPerf;
  }
});

// ---------- While you were away ----------
// The page remembers when Deb last looked. Coming back after 15+ minutes shows one card with
// what finished, who waited and what failed meanwhile.
let awayChecking = false;
async function checkAway() {
  if (awayChecking || document.visibilityState !== 'visible') return;
  const now = Date.now();
  const last = loadLastSeen();
  saveLastSeen(now);
  if (last === null || now - last < AWAY_AFTER_MS) return;
  awayChecking = true;
  const sum = await fetchAway(last, now);
  awayChecking = false;
  if (!sum) return;
  const nameOf = (key: string) => liveState.actors[key]?.name ?? 'Someone';
  const keep = (key: string) => {
    const a = liveState.actors[key];
    return !project || (!!a && projectOf(liveState, a) === project);
  };
  const v = digestView(sum, nameOf, keep);
  if (!v) return;
  const box = $('digest');
  const card = document.createElement('section');
  card.className = 'digest-card';
  const h = document.createElement('h2');
  h.textContent = v.title;
  const ul = document.createElement('ul');
  for (const line of v.lines) {
    const li = document.createElement('li');
    li.textContent = line;
    ul.append(li);
  }
  card.append(h, ul);
  if (v.tasks.length) {
    const done = document.createElement('ol');
    done.className = 'digest-tasks';
    for (const task of v.tasks) {
      const li = document.createElement('li');
      li.textContent = `✓ ${task.what}`;
      const who = document.createElement('span');
      who.textContent = task.who;
      li.append(who);
      done.append(li);
    }
    card.append(done);
  }
  const actions = document.createElement('div');
  actions.className = 'digest-actions';
  const btn = (label: string, cls: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', () => {
      box.hidden = true;
      fn();
    });
    actions.append(b);
  };
  btn('Show the board', 'primary', openBoard);
  btn('Replay it', '', () => {
    seekOnLoad = last;
    setMode('replay');
  });
  btn('Dismiss', 'quiet', () => {});
  card.append(actions);
  box.replaceChildren(card);
  box.hidden = false;
}
// While the board is in view, it counts as seen.
setInterval(() => {
  if (document.visibilityState === 'visible') saveLastSeen(Date.now());
}, 30_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void checkAway();
  else saveLastSeen(Date.now());
});
let awayFirst = true;

// ---------- Live data ----------
function connect() {
  const ws = new WebSocket(`ws://${location.host}/v1/stream`);
  const live = $('live');
  ws.onopen = () => {
    live.textContent = 'Live';
    live.classList.add('on');
  };
  ws.onclose = () => {
    live.textContent = 'Offline';
    live.classList.remove('on');
    setTimeout(connect, 1500);
  };
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data as string) as { type: string; state?: WorldState };
    if ((data.type === 'hello' || data.type === 'state') && data.state) {
      liveState = data.state;
      liveVersion++;
      // Names in the away card come from the live office, so check once it has arrived.
      if (awayFirst) {
        awayFirst = false;
        void checkAway();
      }
      if (boardOnLoad) {
        boardOnLoad = false;
        openBoard();
      }
    }
  };
}
connect();

// Deep links: ?view=inbox|replay, ?focus=1 (wall display), ?board=1 (the readable board)
const startQ = new URLSearchParams(location.search);
const startView = startQ.get('view');
if (startView === 'inbox' || startView === 'replay') setMode(startView);
if (startQ.get('focus') === '1') toggleFocus(true);
let boardOnLoad = startQ.get('board') === '1';

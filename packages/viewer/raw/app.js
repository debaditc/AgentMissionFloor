// Phase 0 raw page: renders world state and the event stream from the collector's WebSocket.
// Plain DOM; every string is inserted as text, never HTML.

const COLORS = ['#1f6feb', '#b4329f', '#e07b00', '#2e9d4f', '#0e8f99', '#5aa2ff'];
const STALE_AFTER_MS = 60_000;
const DORMANT_AFTER_MS = 60 * 60_000; // mirrors world isDormant()
const dormant = (a) => a.status !== 'gone' && a.status !== 'waiting' && a.status !== 'working' && Date.now() - a.lastTs > DORMANT_AFTER_MS;
const MAX_LOG = 500;

let state = null;
let events = [];
let filter = '';
let byKey = {};

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : String(c));
  return node;
}

function tint(hex) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * 0.45);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

function colorOf(actor) {
  const base = COLORS[actor.color % COLORS.length];
  return actor.tint ? tint(base) : base;
}

function memCell(actor) {
  const pct = actor.memory?.pctFree;
  if (pct === null || pct === undefined) return el('span', { class: 'mono' }, '—');
  const color = pct > 50 ? '#2e9d4f' : pct >= 25 ? '#f2a900' : '#c4361b';
  return el('span', { class: 'mem mono' }, el('span', { class: 'bar' }, el('i', { style: `width:${pct}%;background:${color}` })), `${pct}% free`);
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function renderActors() {
  const body = $('actors');
  // Hide people who left more than 10 minutes ago and dormant sessions.
  const actors = Object.values(state.actors).filter((a) => !dormant(a) && !(a.status === 'gone' && Date.now() - a.lastTs > 10 * 60_000));
  if (actors.length === 0) return;
  // Parents first, interns indented under their parent.
  const roots = actors.filter((a) => !a.parentKey || !state.actors[a.parentKey]).sort((a, b) => a.startedTs - b.startedTs);
  const rows = [];
  for (const root of roots) {
    rows.push(root);
    for (const child of actors.filter((a) => a.parentKey === root.key).sort((a, b) => a.startedTs - b.startedTs)) rows.push(child);
  }
  body.replaceChildren(
    ...rows.map((a) => {
      const card = a.cardKey ? state.cards[a.cardKey] : null;
      return el(
        'tr',
        { class: `${a.status} ${a.role}` },
        el('td', {}, el('span', { class: 'dot', style: `background:${colorOf(a)}` }), el('b', {}, a.name), ' ', el('span', { class: 'chip' }, a.role)),
        el('td', {}, a.station),
        el('td', {}, el('span', { class: `status ${a.status}` }, a.needs ? `${a.status} · ${a.needs.type}` : a.status)),
        el('td', { class: 'mono' }, a.activity, a.chip ? el('div', { style: `color:${a.chip.tone === 'error' ? '#c4361b' : '#5b6576'}` }, a.chip.text) : null),
        el('td', {}, card ? card.title : el('span', { class: 'empty' }, '—')),
        el('td', {}, memCell(a)),
        el('td', { class: 'mono' }, a.toolCalls),
        el('td', { class: 'mono' }, a.errors),
      );
    }),
  );
}

function renderBoard() {
  const missions = Object.values(state.missions).sort((a, b) => b.ts - a.ts);
  $('missions').replaceChildren(
    ...missions.slice(0, 3).map((m) => el('p', { class: 'mission' }, `“${m.text}”`, m.complete ? ' ✓ mission complete' : '')),
  );
  for (const status of ['pending', 'in_progress', 'completed']) {
    const cards = Object.values(state.cards)
      .filter((c) => c.status === status)
      .sort((a, b) => a.createdTs - b.createdTs)
      .slice(-30);
    $(`col-${status}`).replaceChildren(
      ...cards.map((c) => {
        const owner = c.ownerKey ? state.actors[c.ownerKey] : null;
        const blocked = c.status === 'pending' && c.blockedBy.some((id) => state.cards[`${c.teamName}:${id}`]?.status !== 'completed');
        const stale = c.status === 'in_progress' && owner && (owner.status === 'idle' || owner.status === 'gone') && Date.now() - owner.lastTs > STALE_AFTER_MS;
        const badges = [blocked ? '🔒 blocked' : '', stale ? 'stale?' : '', c.failed ? 'failed' : ''].filter(Boolean).join(' · ');
        return el(
          'div',
          { class: `card ${c.status}${c.failed ? ' failed' : ''}` },
          c.title,
          el('small', {}, `${owner ? owner.name : c.ownerName ?? 'unassigned'} · ${ago(c.createdTs)}${badges ? ' · ' + badges : ''}`),
        );
      }),
    );
  }
}

function renderStats() {
  const all = Object.values(state.actors).filter((a) => a.status !== 'gone');
  const actors = all.filter((a) => !dormant(a));
  const away = all.length - actors.length;
  const working = actors.filter((a) => a.status === 'working').length;
  const idle = actors.filter((a) => a.status === 'idle').length;
  const waiting = actors.filter((a) => a.status === 'waiting').length;
  $('s-tools').textContent = state.stats.toolCalls;
  $('s-errors').textContent = state.stats.errors;
  $('s-waiting').textContent = waiting;
  $('status').textContent = `${actors.length} on the team · ${working} working · ${idle} idle${waiting ? ` · ${waiting} waiting on you` : ''}${away ? ` · ${away} away` : ''}`;
}

function describe(e) {
  const t = e.tool;
  if (t) return `${t.name} ${t.detail ?? t.targets.join(' ')}${e.outcome?.error ? ' → ' + e.outcome.error : ''}`;
  if (e.task) return `#${e.task.id} ${e.task.subject ?? ''}${e.task.owner ? ' @' + e.task.owner : ''}`;
  if (e.tasks) return `${e.tasks.length} tasks (${e.teamName})`;
  if (e.members) return `${e.members.map((m) => m.name).join(', ')} (${e.teamName})`;
  if (e.context) return `${e.context.used.toLocaleString()} / ${e.context.max?.toLocaleString() ?? '?'} tokens · ${e.context.pctFree ?? '—'}% free`;
  return e.summary ?? e.outcome?.error ?? '';
}

function who(e) {
  const key = e.agentId ? `${e.sessionId}:${e.agentId}` : e.sessionId;
  return byKey[key]?.name ?? e.agentName ?? e.sessionId.slice(0, 8);
}

function renderLog() {
  const f = filter.toLowerCase();
  const rows = [];
  for (let i = events.length - 1; i >= 0 && rows.length < 300; i--) {
    const e = events[i];
    const text = describe(e);
    const name = who(e);
    if (f && !`${e.kind} ${name} ${text}`.toLowerCase().includes(f)) continue;
    rows.push(
      el(
        'div',
        { class: `k-${e.kind}${e.needsUser ? ' needs' : ''}` },
        el('span', {}, new Date(e.ts).toLocaleTimeString()),
        el('span', {}, name),
        el('span', {}, e.kind),
        el('span', {}, text),
      ),
    );
  }
  $('log').replaceChildren(...rows);
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!state) return;
    byKey = state.actors;
    renderActors();
    renderBoard();
    renderStats();
    renderLog();
  });
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/v1/stream`);
  ws.onopen = () => {
    $('conn').textContent = 'live';
    $('conn').classList.add('live');
  };
  ws.onclose = () => {
    $('conn').textContent = 'offline';
    $('conn').classList.remove('live');
    setTimeout(connect, 1500);
  };
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === 'hello') {
      state = data.state;
      events = data.events;
    } else if (data.type === 'event') {
      events.push(data.event);
      if (events.length > MAX_LOG) events.splice(0, events.length - MAX_LOG);
    } else if (data.type === 'state') {
      state = data.state;
    }
    render();
  };
}

$('filter').addEventListener('input', (e) => {
  filter = e.target.value;
  render();
});
setInterval(render, 5000); // keep ages and "stale?" fresh
connect();

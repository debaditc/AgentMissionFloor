// Your inbox (spec §10.2): everything that needs you, plus desktop notifications, an unread count
// in the tab title and a dot on the favicon, so a waiting teammate is noticed from across the room.

import { fmtDur, type Actor, type InboxItem, type WorldState } from '@agent-mission-floor/world';
import { actorColor } from './overlay.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const DISMISS_KEY = 'amb.inbox.dismissed';

/** Dismissals live in this browser only (a convenience, not shared state). */
export function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function saveDismissed(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...ids].slice(-300)));
  } catch {
    /* private mode: dismissals just don't persist */
  }
}

const TITLE = 'AgentMissionFloor';

export class Notifier {
  private seen = new Set<string>();
  private primed = false;
  private baseIcon: string;
  onToast: ((text: string) => void) | null = null;

  constructor() {
    this.baseIcon = (document.querySelector('link[rel=icon]') as HTMLLinkElement | null)?.href ?? '';
  }

  get permission(): NotificationPermission | 'unsupported' {
    return 'Notification' in window ? Notification.permission : 'unsupported';
  }

  async enable(): Promise<void> {
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  }

  /** Call with the live inbox; notifies once per new item (never for items present at load). */
  update(items: InboxItem[], state: WorldState) {
    for (const item of items) {
      if (this.seen.has(item.id)) continue;
      this.seen.add(item.id);
      if (!this.primed) continue;
      const { title, body } = describe(item, state);
      if (this.permission === 'granted') {
        try {
          const n = new Notification(title, { body, tag: item.id, silent: true });
          n.onclick = () => {
            window.focus();
            n.close();
          };
          this.onToast?.('Desktop notification sent');
        } catch {
          this.onToast?.(title);
        }
      } else this.onToast?.(title);
    }
    this.primed = true;
    const count = items.filter((i) => i.kind === 'approval' || i.kind === 'question').length;
    document.title = count ? `(${count}) ${TITLE}` : TITLE;
    this.setFavicon(count > 0);
  }

  private finished = new Set<string>();
  private finishedPrimed = false;

  /**
   * "✓ Ron finished: Fix the login bug". A toast on the board; a quiet desktop notification too
   * when the tab is in the background and notifications are on. Never for work done before load.
   */
  updateFinished(state: WorldState) {
    const fresh: Array<{ name: string; what: string }> = [];
    for (const a of Object.values(state.actors)) {
      if (!a.finished || a.needs?.type === 'mission') continue; // the mission has its own notice
      const id = `${a.key}@${a.finished.ts}`;
      if (this.finished.has(id)) continue;
      this.finished.add(id);
      if (this.finishedPrimed) fresh.push({ name: a.name, what: a.finished.what });
    }
    this.finishedPrimed = true;
    if (!fresh.length) return;
    const title = fresh.length === 1 ? `✓ ${fresh[0]!.name} finished: ${fresh[0]!.what}` : `✓ ${fresh.length} tasks finished`;
    this.onToast?.(title);
    if (this.permission === 'granted' && document.hidden) {
      try {
        new Notification(fresh.length === 1 ? `${fresh[0]!.name} finished` : `${fresh.length} tasks finished`, { body: fresh.map((f) => f.what).join('\n'), tag: 'finished', silent: true });
      } catch {
        /* notifications unavailable */
      }
    }
  }

  private setFavicon(alert: boolean) {
    const link = document.querySelector('link[rel=icon]') as HTMLLinkElement | null;
    if (!link) return;
    if (!alert) {
      if (link.href !== this.baseIcon) link.href = this.baseIcon;
      return;
    }
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M16 3 29 10.5v11L16 29 3 21.5v-11z' fill='%231f6feb'/><circle cx='25' cy='7' r='6.5' fill='%23f2a900' stroke='white' stroke-width='2'/></svg>`;
    link.href = `data:image/svg+xml,${svg.replace(/#/g, '%23')}`;
  }
}

function nameOf(state: WorldState, key: string): string {
  return state.actors[key]?.name ?? 'Someone';
}

export function describe(item: InboxItem, state: WorldState): { title: string; body: string } {
  switch (item.kind) {
    case 'approval':
      return { title: `${nameOf(state, item.actorKey)} needs your approval`, body: item.command ?? item.tool ?? 'A tool call is waiting' };
    case 'question':
      return { title: `${nameOf(state, item.actorKey)} has a question`, body: item.message ?? '' };
    case 'mission':
      return { title: 'Mission complete', body: item.summary ?? item.mission ?? '' };
    case 'conflict':
      return { title: `${nameOf(state, item.firstKey)} and ${nameOf(state, item.secondKey)} edited the same file`, body: item.path };
  }
}

function avatar(a: Actor | undefined): HTMLElement {
  const av = el('span', 'avatar', a?.name[0] ?? '?');
  if (a) av.style.background = actorColor(a);
  return av;
}

function ago(ts: number, now: number): string {
  return now - ts < 45_000 ? 'just now' : `${fmtDur(now - ts)} ago`;
}

export interface InboxHandlers {
  onShow(key: string): void;
  onDismiss(id: string): void;
  onEnableNotifications(): void;
}

export function renderInbox(root: HTMLElement, state: WorldState, items: InboxItem[], dismissed: Set<string>, now: number, notifier: Notifier, h: InboxHandlers) {
  const open = items.filter((i) => !dismissed.has(i.id));
  const wrap = el('div', 'inbox');

  const head = el('section', 'panel-sec');
  head.append(el('h2', 'panel-h', open.length ? `${open.length} waiting on you` : 'Nothing needs you right now'));
  if (notifier.permission === 'default') {
    const b = el('button', 'btn', 'Turn on desktop notifications');
    b.type = 'button';
    b.addEventListener('click', h.onEnableNotifications);
    head.append(b);
  } else if (notifier.permission === 'denied') head.append(el('p', 'hint', 'Desktop notifications are blocked for this page in your browser settings.'));
  else if (notifier.permission === 'granted') head.append(el('p', 'hint', 'Desktop notifications are on.'));
  wrap.append(head);

  for (const item of open) {
    const card = el('section', `panel-sec inbox-item k-${item.kind}`);
    const top = el('div', 'item-top');
    const time = el('span', 'item-time', ago(item.ts, now));
    if (item.kind === 'conflict') {
      const a = state.actors[item.firstKey];
      const b = state.actors[item.secondKey];
      top.append(avatar(a), avatar(b), el('b', '', `${a?.name ?? 'Someone'} and ${b?.name ?? 'someone'} edited the same file`), time);
      const file = el('div', 'item-code', item.path);
      const rows = el('div', 'diff-rows');
      for (const [who, d] of [
        [a, item.first],
        [b, item.second],
      ] as const) {
        const r = el('div', 'diff-row');
        r.append(el('span', '', who?.name ?? 'Someone'), el('span', 'add', `+${d.added}`), el('span', 'del', `−${d.removed}`));
        rows.append(r);
      }
      const actions = el('div', 'item-actions');
      const open = el('a', 'btn', 'Open in editor');
      open.href = `vscode://file${item.path.startsWith('/') ? '' : '/'}${encodeURI(item.path).replace(/[?#]/g, encodeURIComponent)}`;
      actions.append(open, dismissBtn(item.id, h));
      card.append(top, file, rows, el('p', 'hint', 'Both changes landed within two minutes. Check the file before either of them builds on it.'), actions);
    } else {
      const a = state.actors[item.actorKey];
      const name = a?.name ?? 'Someone';
      if (item.kind === 'approval') {
        top.append(avatar(a), el('b', '', `${name} needs your approval`), time);
        card.append(top);
        if (item.command) card.append(el('div', 'item-code', item.command));
        card.append(el('p', 'hint', `Claude Code paused before running ${item.tool ?? 'a tool'}. Answer in ${name}’s terminal (approving from here is opt-in, in Phase 5).`));
      } else if (item.kind === 'question') {
        top.append(avatar(a), el('b', '', `${name} has a question`), time);
        card.append(top, el('blockquote', 'item-quote', item.message ?? ''), el('p', 'hint', `Reply in ${name}’s terminal.`));
      } else {
        top.append(avatar(a), el('b', '', 'Mission complete'), time);
        card.append(top);
        if (item.mission) card.append(el('p', 'item-mission', `“${item.mission}”`));
        if (item.summary) card.append(el('blockquote', 'item-quote', item.summary));
      }
      const actions = el('div', 'item-actions');
      const show = el('button', 'btn', `Show ${name}`);
      show.type = 'button';
      show.addEventListener('click', () => h.onShow(item.actorKey));
      actions.append(show);
      if (item.kind === 'mission') actions.append(dismissBtn(item.id, h));
      card.append(actions);
    }
    wrap.append(card);
  }

  // Meanwhile: who's still working, so you know what you're not interrupting.
  const working = Object.values(state.actors).filter((a) => a.status === 'working');
  if (working.length) {
    const sec = el('section', 'panel-sec');
    sec.append(el('h2', 'panel-h', 'Meanwhile'));
    const list = el('ul', 'meanwhile');
    for (const a of working) {
      const li = el('li');
      li.append(avatar(a), el('b', '', a.name), el('span', '', a.activity));
      li.addEventListener('click', () => h.onShow(a.key));
      list.append(li);
    }
    sec.append(list);
    wrap.append(sec);
  }
  root.replaceChildren(wrap);
}

function dismissBtn(id: string, h: InboxHandlers): HTMLElement {
  const b = el('button', 'btn quiet', 'Dismiss');
  b.type = 'button';
  b.addEventListener('click', () => h.onDismiss(id));
  return b;
}

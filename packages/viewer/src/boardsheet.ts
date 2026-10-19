// The mission board, readable: every card in three columns, who owns it, and who finished what
// and when. Opens over the scene (click the wall board, the mission bar, or press B).

import { isBlocked, isStale, type Card, type WorldState } from '@agent-mission-floor/world';
import { actorColor } from './overlay.ts';
import { ago } from './team.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const COLUMNS = [
  { status: 'pending', title: 'To do' },
  { status: 'in_progress', title: 'Doing' },
  { status: 'completed', title: 'Done' },
] as const;

export class BoardSheet {
  private host: HTMLElement;
  private sig = '';
  open = false;
  onSelect: ((key: string) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    host.addEventListener('click', (e) => {
      if (e.target === host) this.close();
    });
  }

  show(state: WorldState, now: number) {
    this.open = true;
    this.host.hidden = false;
    this.sig = '';
    this.render(state, now);
    (this.host.querySelector('.sheet-close') as HTMLButtonElement | null)?.focus();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.host.hidden = true;
    this.onClose?.();
  }

  /** Re-renders while open, only when the cards or owners changed (or each minute, for "4 min ago"). */
  render(state: WorldState, now: number) {
    if (!this.open) return;
    const cards = Object.values(state.cards);
    const sig = JSON.stringify([cards.map((c) => [c.key, c.status, c.title, c.ownerKey, c.failed, c.updatedTs]), Math.floor(now / 60_000)]);
    if (sig === this.sig) return;
    this.sig = sig;

    const sheet = el('section', 'sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Mission board');
    const head = el('header', 'sheet-head');
    const done = cards.filter((c) => c.status === 'completed').length;
    head.append(el('h2', '', 'Mission board'), el('span', 'sheet-sub', cards.length ? `${done} of ${cards.length} done` : 'No tasks yet'));
    const close = el('button', 'sheet-close', 'Close');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.addEventListener('click', () => this.close());
    head.append(close);

    const cols = el('div', 'sheet-cols');
    for (const col of COLUMNS) {
      let list = cards.filter((c) => c.status === col.status);
      // Done: newest first, so "what just finished" is on top. The others: oldest first.
      list = col.status === 'completed' ? list.sort((a, b) => b.updatedTs - a.updatedTs) : list.sort((a, b) => a.createdTs - b.createdTs);
      const box = el('div', `sheet-col ${col.status}`);
      const h = el('h3', '', col.title);
      h.append(el('span', 'count', String(list.length)));
      const ul = el('ul', '');
      for (const c of list) ul.append(this.card(c, state, now));
      if (!list.length) ul.append(el('li', 'sheet-empty', col.status === 'completed' ? 'Nothing finished yet' : 'Empty'));
      box.append(h, ul);
      cols.append(box);
    }
    sheet.append(head, cols);
    this.host.replaceChildren(sheet);
  }

  private card(c: Card, state: WorldState, now: number): HTMLLIElement {
    const li = el('li', `sheet-card ${c.status}${c.failed ? ' failed' : ''}`);
    li.append(el('p', 'sheet-title', c.title));
    const meta = el('div', 'sheet-meta');
    const owner = c.ownerKey ? state.actors[c.ownerKey] : undefined;
    if (owner) {
      const who = el('button', 'sheet-owner');
      who.type = 'button';
      const dot = el('i', '');
      dot.style.background = actorColor(owner);
      who.append(dot, document.createTextNode(c.status === 'completed' ? `✓ ${owner.name}` : owner.name));
      who.title = `Show ${owner.name}`;
      who.addEventListener('click', () => {
        this.close();
        this.onSelect?.(owner.key);
      });
      meta.append(who);
    } else if (c.ownerName) meta.append(el('span', 'sheet-owner plain', c.ownerName));
    if (c.status === 'completed') meta.append(el('span', 'sheet-when', ago(Math.max(0, now - c.updatedTs))));
    if (isBlocked(c, state)) meta.append(el('span', 'sheet-flag', '🔒 waiting on another task'));
    if (isStale(c, state, now)) meta.append(el('span', 'sheet-flag', 'stale?'));
    if (c.failed) meta.append(el('span', 'sheet-flag bad', 'failed'));
    li.append(meta);
    return li;
  }
}

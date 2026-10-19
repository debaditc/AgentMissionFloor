// Events the sender couldn't deliver (collector down) land in spool/ as one file each,
// named <epoch-ms>-<pid>.json. They're ingested in order, then deleted.
// `.<epoch-ms>-<pid>.tmp` files older than ORPHAN_AGE_MS are senders that were killed mid-send
// (Claude Code kills async hooks at `-p` teardown). They're ingested too: the event id is the
// same as the live path's, so a send that did complete is deduplicated by the store.

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface SpoolEntry {
  ts: number;
  name: string;
  /** Same id the sender sent in X-AMB-Id. */
  id: string;
  raw: Record<string, unknown>;
}

export const SPOOL_MAX_FILES = 2_000; // matches the sender's cap (≈128 MB worst case)
export const ORPHAN_AGE_MS = 2_000;
/** The collector accepts at most 2 MB per hook; anything bigger on disk is dropped unread. */
export const SPOOL_MAX_BYTES = 2 * 1024 * 1024;

export async function drainSpool(dir: string, handle: (entry: SpoolEntry) => void): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  const candidates: string[] = [];
  for (const name of names) {
    if (/^\d+-\d+\.json$/.test(name)) candidates.push(name);
    else if (/^\.\d+-\d+\.tmp$/.test(name)) {
      try {
        if (now - (await stat(join(dir, name))).mtimeMs > ORPHAN_AGE_MS) candidates.push(name);
      } catch {
        /* finished meanwhile */
      }
    }
  }
  const parsed = candidates
    .map((name) => {
      const id = name.replace(/^\./, '').replace(/\.(json|tmp)$/, '');
      const [ms, pid, n] = id.split('-');
      return { name, id, ts: Number(ms), pid: Number(pid) || 0, n: Number(n) || 0 };
    })
    .filter((x) => Number.isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts || a.pid - b.pid || a.n - b.n);
  // Over the cap: the oldest are dropped (deleted unread).
  for (const f of parsed.splice(0, Math.max(0, parsed.length - SPOOL_MAX_FILES))) await rm(join(dir, f.name), { force: true });
  let count = 0;
  for (const f of parsed) {
    const path = join(dir, f.name);
    try {
      if ((await stat(path)).size > SPOOL_MAX_BYTES) throw new Error('too big');
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      handle({ ts: f.ts, name: f.name, id: f.id, raw });
      count++;
    } catch {
      /* corrupt or partial; dropped */
    }
    await rm(path, { force: true });
  }
  return count;
}

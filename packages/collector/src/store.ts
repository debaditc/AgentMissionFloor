// SQLite persistence via node:sqlite (no native module). 14-day retention (§11).

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import type { AmbEvent } from '@agent-mission-floor/protocol';

export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export class Store {
  private db: DatabaseSync;
  private insertStmt;
  private sessionStmt;

  constructor(path: string) {
    const isNew = path !== ':memory:' && !existsSync(path);
    this.db = new DatabaseSync(path);
    if (isNew) chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      CREATE INDEX IF NOT EXISTS events_session ON events (session_id, ts);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.insertStmt = this.db.prepare('INSERT OR IGNORE INTO events (id, ts, session_id, kind, source, json) VALUES (?, ?, ?, ?, ?, ?)');
    this.sessionStmt = this.db.prepare('SELECT json FROM events WHERE session_id = ? ORDER BY ts, rowid LIMIT ?');
  }

  /** Returns false when the id was already stored (duplicate delivery). */
  insert(e: AmbEvent): boolean {
    const r = this.insertStmt.run(e.id, e.ts, e.sessionId, e.kind, e.source, JSON.stringify(e));
    return Number(r.changes) > 0;
  }

  /** Events since `since` in arrival order, for rebuilding world state on start. */
  since(since: number): AmbEvent[] {
    const rows = this.db.prepare('SELECT json FROM events WHERE ts >= ? ORDER BY ts, rowid').all(since) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as AmbEvent);
  }

  /** Events in [since, until] in order, for replay. */
  range(since: number, until: number, limit = 100_000): AmbEvent[] {
    const rows = this.db.prepare('SELECT json FROM events WHERE ts >= ? AND ts <= ? ORDER BY ts, rowid LIMIT ?').all(since, until, limit) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as AmbEvent);
  }

  recent(limit: number): AmbEvent[] {
    const rows = this.db.prepare('SELECT json FROM events ORDER BY ts DESC, rowid DESC LIMIT ?').all(limit) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as AmbEvent).reverse();
  }

  session(sessionId: string, limit = 5000): AmbEvent[] {
    return (this.sessionStmt.all(sessionId, limit) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as AmbEvent);
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n);
  }

  prune(now = Date.now()): number {
    const r = this.db.prepare('DELETE FROM events WHERE ts < ?').run(now - RETENTION_MS);
    return Number(r.changes);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close() {
    this.db.close();
  }
}

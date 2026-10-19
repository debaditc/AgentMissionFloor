// ~/.agent-mission-floor/: runtime.json (port + token), sender files, single-instance lock.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setting } from '@agent-mission-floor/protocol';

export const APP_DIR_NAME = '.agent-mission-floor';

/** The folder used before the rename to AgentMissionFloor. */
export const LEGACY_DIR_NAME = '.agent-mission-board';

export function appDir(): string {
  return setting('HOME') ?? join(homedir(), APP_DIR_NAME);
}

/**
 * One-time migration after the rename: if only the old folder exists, move it (events, token,
 * last port), so the bookmarked board and its sign-in keep working. Only for the default location.
 */
export function migrateLegacyDir(dir = appDir()): boolean {
  if (setting('HOME')) return false;
  const legacy = join(homedir(), LEGACY_DIR_NAME);
  if (existsSync(dir) || !existsSync(legacy)) return false;
  renameSync(legacy, dir);
  return true;
}

export interface Runtime {
  pid: number;
  port: number;
  token: string;
  url: string;
  version: string;
  startedAt: number;
}

export function ensureAppDir(dir = appDir()): string {
  migrateLegacyDir(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, 'spool'), { recursive: true, mode: 0o700 });
  return dir;
}

function writePrivate(path: string, content: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * The token persists across restarts (and the port is reused when free) so a bookmarked
 * board URL keeps working. Opening the board then needs no Claude command, so no tokens are spent.
 */
export function loadOrCreateToken(dir: string): string {
  const path = join(dir, 'token');
  try {
    const t = readFileSync(path, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(t)) return t;
  } catch {
    /* first run */
  }
  const t = newToken();
  writePrivate(path, t + '\n');
  return t;
}

export function readLastPort(dir: string): number | undefined {
  try {
    const n = Number(readFileSync(join(dir, 'last-port'), 'utf8').trim());
    return Number.isInteger(n) && n > 1024 && n < 65536 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastPort(dir: string, port: number) {
  writePrivate(join(dir, 'last-port'), `${port}\n`);
}

/** Writes runtime.json plus the two files the sh sender reads (no JSON parsing in sh). */
export function writeRuntime(dir: string, rt: Runtime) {
  writePrivate(join(dir, 'runtime.json'), JSON.stringify(rt, null, 2) + '\n');
  writePrivate(join(dir, 'sender.url'), `${rt.url}/v1/hook\n`);
  writePrivate(join(dir, 'sender.headers'), `Authorization: Bearer ${rt.token}\n`);
}

export function readRuntime(dir = appDir()): Runtime | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')) as Runtime;
  } catch {
    return null;
  }
}

export function clearRuntime(dir: string, pid: number) {
  const rt = readRuntime(dir);
  if (rt && rt.pid !== pid) return; // someone else owns it now
  for (const f of ['runtime.json', 'sender.url', 'sender.headers']) rmSync(join(dir, f), { force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Single-instance lock. Returns a release function, or null when another live collector holds it. */
export function acquireLock(dir: string): (() => void) | null {
  const path = join(dir, 'collector.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, 'utf8').trim() === String(process.pid)) rmSync(path, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number(readFileSync(path, 'utf8').trim());
      if (Number.isFinite(holder) && holder > 0 && holder !== process.pid && pidAlive(holder)) return null;
      rmSync(path, { force: true }); // stale lock
    }
  }
  return null;
}

export function lockExists(dir: string): boolean {
  return existsSync(join(dir, 'collector.lock'));
}

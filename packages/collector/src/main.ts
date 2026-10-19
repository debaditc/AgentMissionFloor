// Collector entry: `node packages/collector/src/main.ts [--port N] [--quiet]`.

import { existsSync } from 'node:fs';
import { setting } from '@agent-mission-floor/protocol';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Collector } from './collector.ts';
import { acquireLock, appDir, clearRuntime, ensureAppDir, loadOrCreateToken, readLastPort, readRuntime, writeLastPort, writeRuntime } from './runtime.ts';
import { AmbServer } from './server.ts';
import { drainSpool } from './spool.ts';
import { Store } from './store.ts';
import { TeamWatcher } from './watcher.ts';

export const VERSION = '0.1.0';
const here = dirname(fileURLToPath(import.meta.url));

/** The built office at `/` (falls back to the raw page when not built yet) and the raw page at `/raw/`. */
function viewerDirs(): Record<string, string> {
  const raw = join(here, '../../viewer/raw');
  const dist = setting('STATIC_DIR') ?? join(here, '../../viewer/dist');
  return { '/raw/': raw, '/': existsSync(join(dist, 'index.html')) ? dist : raw };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  // Every file the collector creates (database, WAL/SHM journals, runtime files) is user-only.
  process.umask(0o077);
  const quiet = process.argv.includes('--quiet');
  const log = (...m: unknown[]) => {
    if (!quiet) console.log('[amb]', ...m);
  };
  const dir = ensureAppDir(appDir());
  const release = acquireLock(dir);
  if (!release) {
    const rt = readRuntime(dir);
    // Never print the token: `npm run open` signs a browser in with a one-time code.
    log(`already running (pid ${rt?.pid ?? '?'})${rt ? ` at ${rt.url}/ (open it with: npm run open)` : ''}`);
    return;
  }

  const store = new Store(join(dir, 'events.db'));
  const pruned = store.prune();
  let server: AmbServer | undefined;
  const collector = new Collector({ store, onEvent: (e, w) => server?.broadcast(e, w) });
  const replayed = collector.rebuild();

  const token = loadOrCreateToken(dir);
  server = new AmbServer({
    collector,
    store,
    token,
    staticDirs: viewerDirs(),
    version: VERSION,
  });
  const requested = Number(arg('--port') ?? setting('PORT') ?? readLastPort(dir) ?? 0);
  const port = await server.listen(Number.isFinite(requested) ? requested : 0);
  writeLastPort(dir, port);
  const url = `http://127.0.0.1:${port}`;
  writeRuntime(dir, { pid: process.pid, port, token, url, version: VERSION, startedAt: Date.now() });

  const drain = () =>
    drainSpool(join(dir, 'spool'), ({ raw, ts, id }) => {
      collector.ingestHook(raw, { ts, id: `s-${id}`, source: 'spool' });
    });
  const spooled = await drain();
  // Also picks up events from senders killed mid-send (see spool.ts).
  const spoolTimer = setInterval(() => void drain(), 5000);
  spoolTimer.unref();
  const watcher = new TeamWatcher({
    onTeam: (snap) => collector.ingestTeam(snap),
    onTasks: (snap) => collector.ingestTasks(snap),
    onWarning: (m) => log('warning:', m),
  });
  watcher.start();
  const usage = await collector.backfillUsage();

  log(`collector ${VERSION} on ${url} (pid ${process.pid})`);
  log(`replayed ${replayed} events, ingested ${spooled} spooled, refreshed ${usage} memory meters, pruned ${pruned}`);
  // A one-time sign-in link (2 minutes, single use), never the long-lived token.
  log(`open ${url}/login?code=${server.issueLoginCode()}  (one-time link; later: npm run open)`);

  const prune = setInterval(() => store.prune(), 60 * 60 * 1000);
  prune.unref();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // Hard deadline: the lock and runtime files must never outlive a stop request for long.
    setTimeout(() => {
      clearRuntime(dir, process.pid);
      release();
      process.exit(0);
    }, 1500).unref();
    watcher.stop();
    collector.dispose();
    clearRuntime(dir, process.pid);
    await server?.close();
    store.close();
    release();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  process.on('SIGHUP', () => void stop());
}

main().catch((err) => {
  console.error('[amb] fatal:', err);
  process.exit(1);
});

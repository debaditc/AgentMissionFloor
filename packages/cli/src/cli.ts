// `agent-mission-floor <command>`: set up, check, run and remove AgentMissionFloor.
// Commands: setup (install + doctor), install, doctor, open, status, stop, demo, uninstall [--purge].

import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setting } from '@agent-mission-floor/protocol';
import { appDir, ensureAppDir, readRuntime } from '../../collector/src/runtime.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PLUGIN_ID = 'agent-mission-floor@agent-mission-floor';
const MARKETPLACE = 'agent-mission-floor';
const COLLECTOR = join(REPO, 'packages/collector/src/main.ts');
const OPENER = join(REPO, 'packages/plugin/scripts/amb-open');
const SIM = join(REPO, 'packages/simulator/src/cli.ts');
const VIEWER = join(REPO, 'packages/viewer/dist/index.html');
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

const [cmd = 'help', ...rest] = process.argv.slice(2);
const has = (f: string) => rest.includes(f);

function run(bin: string, args: string[], opts: SpawnSyncOptions = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000, ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), missing: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' };
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health(): Promise<{ app?: string; version?: string; pid?: number } | null> {
  const rt = readRuntime();
  if (!rt || !pidAlive(rt.pid)) return null;
  try {
    const res = await fetch(`${rt.url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as { app?: string; version?: string; pid?: number }) : null;
  } catch {
    return null;
  }
}

function nodeOk(): boolean {
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 18);
}

function mode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/** Remembers where this copy lives, so an installed (cached) plugin can start the collector. */
function writeInstallPointer() {
  const dir = ensureAppDir();
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ repo: REPO, installedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
}

function ensureViewer() {
  if (existsSync(VIEWER)) return;
  console.log('Building the office…');
  run('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
}

async function doctor(): Promise<boolean> {
  const checks: Array<[boolean, string, string]> = [];
  const add = (ok: boolean, what: string, fix = '') => checks.push([ok, what, fix]);
  const dir = appDir();
  const claudeDir = setting('CLAUDE_DIR') ?? join(homedir(), '.claude');

  add(nodeOk(), `Node.js ${process.versions.node}`, 'Install Node.js 22.18 or newer from nodejs.org');
  add(!run('curl', ['--version']).missing, 'curl is available (the hooks use it)', 'Install curl');
  add(existsSync(VIEWER), 'The office is built', 'Run: npm run build');
  const claude = run('claude', ['plugin', 'list'], { timeout: 20_000 });
  add(!claude.missing, 'Claude Code is installed', 'Install Claude Code, then run: npm run setup');
  if (!claude.missing) add(claude.out.includes('agent-mission-floor'), 'The plugin is installed in Claude Code', 'Run: npm run setup');
  let readable = true;
  try {
    accessSync(claudeDir, constants.R_OK);
  } catch {
    readable = false;
  }
  add(readable, `Claude's data folder is readable (${claudeDir.replace(homedir(), '~')})`, 'Start Claude Code once so it creates it');
  const dm = mode(dir);
  add(dm === null || dm === 0o700, 'Your data folder is private to you', `Run: chmod 700 ${dir}`);
  const tm = mode(join(dir, 'token'));
  add(tm === null || tm === 0o600, 'The sign-in token is private to you', `Run: chmod 600 ${join(dir, 'token')}`);
  const h = await health();
  add(h?.app === 'agent-mission-floor', h ? `The collector is running (${readRuntime()?.url})` : 'The collector is running', 'Run: npm run open (it also starts with your next Claude Code session)');

  for (const [ok, what, fix] of checks) console.log(`${ok ? '✓' : '✗'} ${what}${ok || !fix ? '' : `\n    → ${fix}`}`);
  const bad = checks.filter(([ok]) => !ok).length;
  console.log(bad ? `\n${bad} thing${bad === 1 ? '' : 's'} to fix.` : '\nAll good.');
  return bad === 0;
}

async function install() {
  if (!nodeOk()) throw new Error('AgentMissionFloor needs Node.js 22.18 or newer.');
  ensureViewer();
  writeInstallPointer();
  const add = run('claude', ['plugin', 'marketplace', 'add', REPO]);
  if (add.missing) throw new Error('Claude Code is not installed (the `claude` command was not found).');
  // Re-running setup refreshes the cached copy of the plugin.
  if (!add.ok) run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE]);
  const inst = run('claude', ['plugin', 'install', PLUGIN_ID]);
  if (!inst.ok && !/already/i.test(inst.out)) throw new Error(`Couldn't install the plugin:\n${inst.out}`);
  console.log('✓ Plugin installed. New Claude Code sessions appear in the office.\n');
}

async function stop(): Promise<boolean> {
  const rt = readRuntime();
  if (!rt || !pidAlive(rt.pid)) return false;
  // Only signal the process that answers as our collector with that pid: after a crash the
  // operating system can hand the old pid to an unrelated program.
  const h = await health();
  if (h?.app !== 'agent-mission-floor' || h.pid !== rt.pid) return false;
  process.kill(rt.pid, 'SIGTERM');
  for (let i = 0; i < 40 && pidAlive(rt.pid); i++) await new Promise((r) => setTimeout(r, 50));
  return true;
}

/** Files the collector and sender create. Purge deletes only these, never anything else. */
const DATA_ENTRIES = ['events.db', 'events.db-wal', 'events.db-shm', 'token', 'runtime.json', 'sender.url', 'sender.headers', 'last-port', 'collector.lock', 'install.json', 'spool'];

/** Deletes our data, and the folder only if nothing else is left in it. Refuses obvious mistakes. */
function purgeData(dir: string): boolean {
  const real = resolve(dir);
  const forbidden = new Set([resolve('/'), resolve(homedir()), resolve(REPO), resolve(join(homedir(), '.claude'))]);
  if (forbidden.has(real) || !existsSync(join(real, 'token'))) return false;
  for (const name of DATA_ENTRIES) rmSync(join(real, name), { recursive: name === 'spool', force: true });
  try {
    rmdirSync(real); // only succeeds when empty
  } catch {
    /* something else lives there: leave it */
  }
  return true;
}

async function uninstall() {
  run('claude', ['plugin', 'uninstall', PLUGIN_ID]);
  run('claude', ['plugin', 'marketplace', 'remove', MARKETPLACE]);
  await stop();
  const dir = appDir();
  rmSync(join(dir, 'install.json'), { force: true });
  if (has('--purge')) {
    if (!purgeData(dir)) {
      console.log(`✓ Removed the plugin and stopped the collector. ${dir} doesn't look like an AgentMissionFloor data folder, so nothing in it was deleted.`);
      return;
    }
    console.log(`✓ Removed the plugin and deleted your local data (${dir}).`);
  } else {
    console.log(`✓ Removed the plugin and stopped the collector. Your history is kept in ${dir} (delete it with --purge).`);
  }
}

async function status() {
  const rt = readRuntime();
  const h = await health();
  if (!rt || !h) return console.log('The collector is not running. Start it with: npm run open');
  const res = await fetch(`${rt.url}/v1/state`, { headers: { authorization: `Bearer ${rt.token}` } });
  const state = (await res.json()) as { actors?: Record<string, { status?: string }> };
  const actors = Object.values(state.actors ?? {});
  const waiting = actors.filter((a) => a.status === 'waiting').length;
  console.log(`Running at ${rt.url}/ (pid ${rt.pid}, version ${h.version ?? '?'})`);
  console.log(`${actors.length} ${actors.length === 1 ? "person" : "people"} in the office${waiting ? `, ${waiting} waiting for you` : ''}.`);
}

/** A throwaway office with simulated sessions: nothing touches your real data. */
async function demo() {
  const home = mkdtempSync(join(tmpdir(), 'amf-demo-'));
  const env = { ...process.env, AMF_HOME: home, AMF_CLAUDE_DIR: join(home, 'claude'), AMB_HOME: home, AMB_CLAUDE_DIR: join(home, 'claude') };
  ensureViewer();
  const collector = spawn(process.execPath, [...NODE_FLAGS, COLLECTOR, '--quiet'], { env, stdio: 'ignore' });
  let sim: ReturnType<typeof spawn> | undefined;
  const cleanup = () => {
    // The simulator first, so it never posts to a collector that's already gone.
    sim?.removeAllListeners('exit');
    sim?.kill('SIGTERM');
    collector.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  for (let i = 0; i < 60 && !readRuntime(home); i++) await new Promise((r) => setTimeout(r, 100));
  if (!readRuntime(home)) {
    cleanup();
    throw new Error('The demo collector did not start.');
  }
  spawnSync('sh', [OPENER], { env, stdio: 'inherit' });
  console.log('Playing a demo team on a loop. Press Ctrl+C to stop (the demo data is deleted).');
  sim = spawn(process.execPath, [SIM, 'team', 'permission', 'conflict', '--loop'], { env, stdio: 'inherit' });
  sim.on('exit', () => {
    cleanup();
    process.exit(0);
  });
}

const HELP = `AgentMissionFloor

  npm run setup              install the Claude Code plugin, then check everything
  npm run doctor             check your setup, with a fix for anything wrong
  npm run open               open the office (starts the collector if needed)
  npm run status             is it running, and who's in the office
  npm run stop               stop the collector
  npm run demo               a throwaway office with simulated agents
  npm run uninstall          remove the plugin and stop the collector
  npm run uninstall -- --purge   …and delete your local history too`;

try {
  switch (cmd) {
    case 'setup':
      await install();
      process.exitCode = (await doctor()) ? 0 : 1;
      break;
    case 'install':
      await install();
      break;
    case 'doctor':
      process.exitCode = (await doctor()) ? 0 : 1;
      break;
    case 'open':
      process.exitCode = spawnSync('sh', [OPENER], { stdio: 'inherit' }).status ?? 1;
      break;
    case 'status':
      await status();
      break;
    case 'stop':
      console.log((await stop()) ? '✓ Stopped the collector.' : 'The collector was not running.');
      break;
    case 'demo':
      await demo();
      break;
    case 'uninstall':
      await uninstall();
      break;
    default:
      console.log(HELP);
  }
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exitCode = 1;
}

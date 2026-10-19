import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Collector } from '../src/collector.ts';
import { AmbServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { drainSpool } from '../src/spool.ts';
import { TeamWatcher, parseTaskFile, parseTeamConfig } from '../src/watcher.ts';
import { usageFromLines } from '../src/transcript.ts';
import { ensureAppDir, loadOrCreateToken, writeRuntime } from '../src/runtime.ts';

const here = dirname(fileURLToPath(import.meta.url));
// Transcripts in these tests live in temp folders; treat the temp root as Claude's data folder.
process.env.AMB_CLAUDE_DIR = tmpdir();
const SENDER = join(here, '../../sender/bin/amb-send');
const STATIC = join(here, '../../viewer/raw');

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(d, 0o700);
  return d;
}

async function boot(dir: string) {
  ensureAppDir(dir);
  const store = new Store(join(dir, 'events.db'));
  let server: AmbServer | undefined;
  const collector = new Collector({ store, onEvent: (e, w) => server?.broadcast(e, w), usageDebounceMs: 20 });
  collector.rebuild();
  const token = loadOrCreateToken(dir);
  server = new AmbServer({ collector, store, token, staticDirs: { '/raw/': STATIC, '/': STATIC }, version: 'test' });
  const port = await server.listen(0);
  const url = `http://127.0.0.1:${port}`;
  writeRuntime(dir, { pid: process.pid, port, token, url, version: 'test', startedAt: Date.now() });
  const close = async () => {
    collector.dispose();
    await server!.close();
    store.close();
  };
  return { store, collector, server: server!, token, url, port, close };
}

/** Polls instead of sleeping a fixed time: fast when things are quick, patient on a slow CI box. */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
}

function send(dir: string, payload: object): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('/bin/sh', [SENDER], { env: { PATH: process.env.PATH ?? '', AMB_HOME: dir, AMB_AUTOSTART: '0' } });
    p.on('close', () => resolve());
    p.stdin.end(JSON.stringify(payload));
  });
}

const hook = (session: string, hookName: string, extra: object = {}) => ({ session_id: session, cwd: '/r', hook_event_name: hookName, ...extra });

test('hook → sender → collector → WebSocket within 200 ms; auth and origin enforced', async () => {
  const dir = tmp('amb-int-');
  const app = await boot(dir);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/v1/stream`, { headers: { authorization: `Bearer ${app.token}` } });
    const hello = await new Promise<{ type: string }>((resolve, reject) => {
      ws.once('message', (m) => resolve(JSON.parse(String(m))));
      ws.once('error', reject);
    });
    assert.equal(hello.type, 'hello');

    const got = new Promise<{ ms: number; kind: string }>((resolve) => {
      const start = performance.now();
      ws.on('message', (m) => {
        const msg = JSON.parse(String(m));
        if (msg.type === 'event' && msg.event.kind === 'tool.pre') resolve({ ms: performance.now() - start, kind: msg.event.kind });
      });
    });
    await send(dir, hook('sess-a', 'PreToolUse', { tool_name: 'Read', tool_use_id: 'u1', tool_input: { file_path: '/r/a.ts' } }));
    const { ms } = await got;
    console.log(`hook → WS latency ${ms.toFixed(1)} ms`);
    assert.ok(ms < 200, `${ms} ms`);
    assert.equal(app.collector.world.actors['sess-a']?.station, 'library');
    ws.close();

    // No token → 401; wrong origin → 403; foreign host header → 403; health is open.
    assert.equal((await fetch(`${app.url}/v1/state`)).status, 401);
    assert.equal((await fetch(`${app.url}/v1/state`, { headers: { authorization: `Bearer ${app.token}`, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${app.url}/v1/hook`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${app.url}/health`)).status, 200);
    const badWs = new WebSocket(`ws://127.0.0.1:${app.port}/v1/stream`, { origin: 'https://evil.example', headers: { authorization: `Bearer ${app.token}` } });
    await new Promise<void>((resolve) => badWs.once('error', () => resolve()));
    // The token is never accepted in a URL, not even for the WebSocket (D31).
    const urlWs = new WebSocket(`ws://127.0.0.1:${app.port}/v1/stream?token=${app.token}`);
    await new Promise<void>((resolve) => urlWs.once('error', () => resolve()));

    // The old /?token= handoff is gone; the page signs in with a one-time code instead.
    assert.equal((await fetch(`${app.url}/?token=${app.token}`, { redirect: 'manual' })).status, 401);
    const { code } = (await (await fetch(`${app.url}/v1/login-code`, { method: 'POST', headers: { authorization: `Bearer ${app.token}` } })).json()) as { code: string };
    const redirect = await fetch(`${app.url}/login?code=${code}`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    const cookie = redirect.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.match(cookie, /Max-Age=31536000/, 'survives browser restarts');
    const page = await fetch(`${app.url}/`, { headers: { cookie: cookie.split(';')[0]! } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, 'never framed by another site');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await page.text(), /AgentMissionFloor/);
  } finally {
    await app.close();
  }
});

test('secrets never reach the store', async () => {
  const dir = tmp('amb-red-');
  const app = await boot(dir);
  try {
    await send(dir, hook('s', 'PostToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'u9',
      tool_input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop123456" https://api.example.com' },
      tool_response: { stdout: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    }));
    await send(dir, hook('s', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'u10', tool_input: { command: './print-config .env' }, tool_response: { stdout: 'PLAIN_VALUE=hello' } }));
    // Read-only commands (now "reading") never store output at all.
    await send(dir, hook('s', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'u11', tool_input: { command: 'cat .env' }, tool_response: { stdout: 'OTHER_VALUE=bye' } }));
    await send(dir, hook('s', 'UserPromptSubmit', { prompt: 'use key sk-ant-api03-abcdefghijklmnopqrstuv to call it' }));
    await new Promise((r) => setTimeout(r, 100));
    const dump = JSON.stringify(app.store.recent(50));
    for (const leak of ['abcdefghijklmnop123456', 'wJalrXUtnFEMI', 'PLAIN_VALUE=hello', 'OTHER_VALUE=bye', 'sk-ant-api03-abc']) assert.ok(!dump.includes(leak), leak);
    assert.ok(dump.includes('[output hidden: secret file]'));
  } finally {
    await app.close();
  }
});

test('collector down → spool; restart → replay store + drain spool, no duplicates', async () => {
  const dir = tmp('amb-restart-');
  const first = await boot(dir);
  await send(dir, hook('sess-r', 'UserPromptSubmit', { prompt: 'Build the thing' }));
  await new Promise((r) => setTimeout(r, 50));
  await first.close(); // collector "killed"

  // While down, the sender must still exit quickly and keep events.
  const start = performance.now();
  await send(dir, hook('sess-r', 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'u1', tool_input: { file_path: '/r/x.ts', old_string: '', new_string: 'a' } }));
  await send(dir, hook('sess-r', 'Stop', { last_assistant_message: 'Done.' }));
  assert.ok(performance.now() - start < 2500);
  assert.equal(readdirSync(join(dir, 'spool')).filter((f) => f.endsWith('.json')).length, 2);

  const second = await boot(dir);
  try {
    assert.equal(second.store.count(), 1, 'store replayed');
    const spoolDir = join(dir, 'spool');
    const ingest = () =>
      drainSpool(spoolDir, ({ raw, ts, id }) => second.collector.ingestHook(raw, { ts, id: `s-${id}`, source: 'spool' }));
    assert.equal(await ingest(), 2);
    assert.equal(await ingest(), 0, 'spool emptied');
    const a = second.collector.world.actors['sess-r']!;
    assert.equal(a.station, 'lounge');
    const card = Object.values(second.collector.world.cards)[0]!;
    assert.equal(card.status, 'completed');
    assert.equal(second.store.count(), 3);
  } finally {
    await second.close();
  }
});

test('orphaned .tmp from a killed sender is ingested once, and deduplicated if it was delivered', async () => {
  const dir = tmp('amb-orphan-');
  const app = await boot(dir);
  try {
    const spoolDir = join(dir, 'spool');
    const payload = JSON.stringify(hook('sess-o', 'Stop', { last_assistant_message: 'Done.' }));
    const old = Date.now() - 10_000;
    // One delivered live (same id) and orphaned; one never delivered; one still in flight.
    writeFileSync(join(spoolDir, `.${old}-111.tmp`), payload);
    app.collector.ingestHook(JSON.parse(payload), { ts: old, id: `s-${old}-111` });
    writeFileSync(join(spoolDir, `.${old}-222.tmp`), payload);
    const inFlight = `.${Date.now()}-333.tmp`;
    writeFileSync(join(spoolDir, inFlight), payload);
    const { utimesSync } = await import('node:fs');
    utimesSync(join(spoolDir, `.${old}-111.tmp`), old / 1000, old / 1000);
    utimesSync(join(spoolDir, `.${old}-222.tmp`), old / 1000, old / 1000);
    const n = await drainSpool(spoolDir, ({ raw, ts, id }) => app.collector.ingestHook(raw, { ts, id: `s-${id}`, source: 'spool' }));
    assert.equal(n, 2);
    assert.equal(app.store.count(), 2, 'the delivered one is not stored twice');
    assert.deepEqual(readdirSync(spoolDir), [inFlight], 'a send still in flight is left alone');
  } finally {
    await app.close();
  }
});

test('transcript usage → memory meter', async () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: 'claude-opus-4-6', usage: { input_tokens: 2, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 139_998, output_tokens: 0 } } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5', usage: { input_tokens: 999_999 } } }),
    '{"partial',
  ].join('\n');
  const u = usageFromLines(lines)!;
  assert.equal(u.used, 150_000);
  assert.equal(u.max, 200_000);
  assert.equal(u.pctFree, 25);

  const dir = tmp('amb-usage-');
  const app = await boot(dir);
  try {
    const transcript = join(dir, 't.jsonl');
    writeFileSync(transcript, lines + '\n');
    app.collector.ingestHook(hook('sess-u', 'SessionStart', { transcript_path: transcript, source: 'startup' }));
    await waitFor(() => app.collector.world.actors['sess-u']?.memory?.pctFree === 25);
    assert.equal(app.collector.world.actors['sess-u']?.memory?.pctFree, 25);
  } finally {
    await app.close();
  }
});

test('watcher: parses team config and task files defensively, read-only', async () => {
  const root = tmp('amb-claude-');
  mkdirSync(join(root, 'teams', 'session-abcd1234'), { recursive: true });
  mkdirSync(join(root, 'tasks', 'session-abcd1234'), { recursive: true });
  writeFileSync(
    join(root, 'teams', 'session-abcd1234', 'config.json'),
    JSON.stringify({ members: [{ name: 'team-lead', agentId: 'l', agentType: 'team-lead', sessionId: 'abcd1234-x' }, { name: 'researcher', agentId: 'r1' }, { bogus: true }] }),
  );
  writeFileSync(join(root, 'tasks', 'session-abcd1234', '1.json'), JSON.stringify({ id: '1', subject: 'Read docs', status: 'in_progress', owner: 'researcher' }));
  writeFileSync(join(root, 'tasks', 'session-abcd1234', '2.json'), JSON.stringify({ id: '2', subject: 'Write', status: 'pending', blockedBy: ['1'] }));
  writeFileSync(join(root, 'tasks', 'session-abcd1234', '3.json'), '{"mid-write');
  const teams: unknown[] = [];
  const tasks: unknown[] = [];
  const w = new TeamWatcher({ onTeam: (s) => teams.push(s), onTasks: (s) => tasks.push(s) }, root, 50);
  await w.scan();
  await w.scan(); // unchanged → no duplicate emissions
  assert.deepEqual(teams, [
    {
      teamName: 'session-abcd1234',
      leadSessionId: 'abcd1234-x',
      members: [
        { name: 'team-lead', agentId: 'l', agentType: 'team-lead', sessionId: 'abcd1234-x' },
        { name: 'researcher', agentId: 'r1' },
      ],
    },
  ]);
  assert.equal(tasks.length, 1);
  assert.deepEqual(parseTaskFile({ tasks: [{ id: 7, title: 'x', status: 'done' }] }, 'f'), [{ id: '7', subject: 'x', status: 'completed' }]);
  assert.equal(parseTeamConfig('t', { nope: 1 }), null);
});

test('teammate drill-down: meta file, own transcript, de-duplicated tokens, files and moves', async () => {
  const dir = tmp('amb-actor-');
  const app = await boot(dir);
  try {
    const S = 'dfcb0358-aaaa-4bbb-8ccc-000000000001';
    const projects = join(dir, 'projects');
    mkdirSync(join(projects, S, 'subagents'), { recursive: true });
    const main = join(projects, `${S}.jsonl`);
    writeFileSync(main, JSON.stringify({ type: 'assistant', message: { id: 'm0', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } }) + '\n');
    const agentId = 'asecurity-reviewer-fdd2';
    // One message written as two content-block lines with the same usage → counted once.
    const line = (id: string, out: number) => JSON.stringify({ type: 'assistant', isSidechain: true, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 } } });
    writeFileSync(join(projects, S, 'subagents', `agent-${agentId}.jsonl`), [line('a1', 7), line('a1', 7), line('a2', 16)].join('\n') + '\n');
    writeFileSync(
      join(projects, S, 'subagents', `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: 'security-reviewer', description: 'Security review of repo', name: 'security-reviewer', model: 'opus', taskKind: 'in_process_teammate', teamName: 'session-dfcb0358' }),
    );
    const base = { session_id: S, transcript_path: main, cwd: '/repo' };
    app.collector.ingestHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
    app.collector.ingestHook({ ...base, hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'security-reviewer' });
    const ag = { ...base, agent_id: agentId, agent_type: 'security-reviewer' };
    app.collector.ingestHook({ ...ag, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: '/repo/src/auth.ts' }, tool_response: {} });
    app.collector.ingestHook({ ...ag, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r2', tool_input: { file_path: '/repo/src/auth.ts' }, tool_response: {} });
    app.collector.ingestHook({ ...ag, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm audit' }, error: 'Exit code 1\n3 vulnerabilities' });
    await new Promise((r) => setTimeout(r, 120));

    const key = `${S}:${agentId}`;
    const a = app.collector.world.actors[key]!;
    assert.equal(a.role, 'teammate', 'meta.json taskKind makes them a teammate');
    assert.equal(a.handle, 'Security reviewer', 'the lead-given role is kept as a handle');
    assert.match(a.name, /^[A-Z][a-z]+$/, 'and they get a friendly first name');
    assert.equal(a.assignment, 'Security review of repo');
    assert.ok(a.memory, 'memory meter from their own transcript');

    const res = await fetch(`${app.url}/v1/actor?key=${encodeURIComponent(key)}`, { headers: { authorization: `Bearer ${app.token}` } });
    assert.equal(res.status, 200);
    const sum = (await res.json()) as {
      tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; messages: number; models: string[] };
      files: Array<{ path: string; reads: number }>;
      moves: Array<{ ok: boolean; error?: string; text: string }>;
      model: string;
      assignment: string;
    };
    assert.deepEqual(sum.tokens, { input: 4, output: 23, cacheRead: 1000, cacheWrite: 200, messages: 2, models: ['claude-opus-5-5'] });
    assert.equal(sum.model, 'claude-opus-5-5');
    assert.equal(sum.assignment, 'Security review of repo');
    assert.deepEqual(sum.files.map((f) => [f.path, f.reads]), [['/repo/src/auth.ts', 2]]);
    assert.equal(sum.moves[0]!.ok, false);
    assert.match(sum.moves[0]!.error!, /Exit code 1/);
    assert.equal(sum.moves[1]!.text, 'Reading auth.ts');

    const lead = await (await fetch(`${app.url}/v1/actor?key=${S}`, { headers: { authorization: `Bearer ${app.token}` } })).json() as { teamTokens: { output: number }; crew: unknown[] };
    assert.equal(lead.teamTokens.output, 28, 'lead total includes the teammate');
    assert.equal(lead.crew.length, 1);
    assert.equal((await fetch(`${app.url}/v1/actor?key=nope`, { headers: { authorization: `Bearer ${app.token}` } })).status, 404);
    assert.equal((await fetch(`${app.url}/v1/actor?key=${S}`)).status, 401);
  } finally {
    await app.close();
  }
});

test('conflict detector: two people, one file, within two minutes → one conflict event', async () => {
  const { ConflictDetector } = await import('../src/conflicts.ts');
  const d = new ConflictDetector(120_000);
  const edit = (session: string, ts: number, path = '/r/total.ts', agentId?: string) =>
    ({ id: `${session}${ts}`, ts, protocolVersion: 1, source: 'hook', sessionId: session, ...(agentId ? { agentId } : {}), cwd: '/r', kind: 'tool.post',
      tool: { name: 'Edit', category: 'edit', targets: [path], added: 3, removed: 1 } }) as never;
  assert.equal(d.check(edit('a', 0)), null);
  assert.equal(d.check(edit('a', 1000)), null, 'same person is not a conflict');
  const c = d.check(edit('b', 5000));
  assert.ok(c);
  assert.equal(c!.path, '/r/total.ts');
  assert.deepEqual([c!.first.actorKey, c!.second.actorKey], ['a', 'b']);
  assert.equal(d.check(edit('a', 9000)), null, 'fires once per pair per window');
  assert.equal(d.check(edit('c', 400_000)), null, 'outside the window');
  assert.ok(d.check(edit('s', 401_000, '/r/total.ts', 'ag1')), 'teammates in one session count as different people');

  const dir = tmp('amb-conflict-');
  const app = await boot(dir);
  try {
    const e = (s: string, id: string) => ({ session_id: s, cwd: '/shop', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: '/shop/src/total.ts', old_string: 'a', new_string: 'b\nc' }, tool_response: {} });
    app.collector.ingestHook(e('s1', 'x1'));
    app.collector.ingestHook(e('s2', 'x2'));
    const conflicts = app.store.recent(20).filter((ev) => ev.kind === 'conflict');
    assert.equal(conflicts.length, 1);
    assert.equal(app.collector.world.conflicts.length, 1);
  } finally {
    await app.close();
  }
});

test("hook input can't point the collector at arbitrary files or crash it (review M-A, L-A)", async () => {
  const { safeTranscriptPath, safeId, agentTranscriptPath } = await import('../src/transcript.ts');
  assert.equal(safeTranscriptPath('/etc/passwd'), null);
  assert.equal(safeTranscriptPath('relative/x.jsonl'), null);
  assert.equal(safeTranscriptPath(join(tmpdir(), 'a', '..', '..', 'etc', 'x.jsonl')), null);
  assert.ok(safeTranscriptPath(join(tmpdir(), 'proj', 's.jsonl')));
  assert.equal(safeId('../../x'), null);
  assert.equal(agentTranscriptPath(join(tmpdir(), 'p', 's.jsonl'), 's', '../../evil'), null);

  const dir = tmp('amb-hostile-');
  const app = await boot(dir);
  try {
    app.collector.ingestHook({ session_id: 'h1', cwd: '/', hook_event_name: 'SessionStart', transcript_path: '/dev/zero.jsonl' });
    app.collector.ingestHook({ session_id: 'h1', cwd: '/', hook_event_name: 'SubagentStart', agent_id: '../../../etc/passwd', agent_type: 'x', transcript_path: join(dir, 'nope.jsonl') });
    await new Promise((r) => setTimeout(r, 80));
    const res = await fetch(`${app.url}/v1/actor?key=${encodeURIComponent('h1:../../../etc/passwd')}`, { headers: { authorization: `Bearer ${app.token}` } });
    assert.ok(res.status === 200 || res.status === 404, `no crash (${res.status})`);
    assert.equal((await fetch(`${app.url}/health`)).status, 200, 'still serving');
  } finally {
    await app.close();
  }
});

test('one-time sign-in codes: single use, expire, never the token in a URL (review M4)', async () => {
  const dir = tmp('amb-login-');
  const app = await boot(dir);
  try {
    assert.equal((await fetch(`${app.url}/v1/login-code`, { method: 'POST' })).status, 401, 'needs the bearer token');
    const { code } = (await (await fetch(`${app.url}/v1/login-code`, { method: 'POST', headers: { authorization: `Bearer ${app.token}` } })).json()) as { code: string };
    assert.ok(code && !code.includes(app.token));
    const first = await fetch(`${app.url}/login?code=${code}`, { redirect: 'manual' });
    assert.equal(first.status, 302);
    const cookie = first.headers.get('set-cookie')!;
    assert.match(cookie, new RegExp(`^amb_token_${app.port}=`), 'cookie is scoped to this port');
    assert.equal((await fetch(`${app.url}/login?code=${code}`, { redirect: 'manual' })).status, 401, 'single use');
    assert.equal((await fetch(`${app.url}/v1/state`, { headers: { cookie: cookie.split(';')[0]! } })).status, 200);
    // The token is never accepted in a URL.
    assert.equal((await fetch(`${app.url}/v1/state?token=${app.token}`)).status, 401);
  } finally {
    await app.close();
  }
});

test('foreign Host header is rejected everywhere, including /health (DNS rebinding)', async () => {
  const dir = tmp('amb-host-');
  const app = await boot(dir);
  try {
    const { request } = await import('node:http');
    const status = (path: string) =>
      new Promise<number>((resolve) => {
        const req = request({ host: '127.0.0.1', port: app.port, path, headers: { host: `evil.example:${app.port}`, authorization: `Bearer ${app.token}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.end();
      });
    assert.equal(await status('/health'), 403);
    assert.equal(await status('/v1/state'), 403);
  } finally {
    await app.close();
  }
});

test('the pre-rename data folder moves to ~/.agent-mission-floor once, keeping the token', async () => {
  const { spawnSync } = await import('node:child_process');
  const fakeHome = tmp('amb-home-');
  mkdirSync(join(fakeHome, '.agent-mission-board'), { recursive: true });
  writeFileSync(join(fakeHome, '.agent-mission-board', 'token'), 'old-token');
  const code = `import { ensureAppDir } from ${JSON.stringify(join(here, '../src/runtime.ts'))}; console.log(ensureAppDir());`;
  const env = { PATH: process.env.PATH ?? '', HOME: fakeHome };
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), join(fakeHome, '.agent-mission-floor'), r.stderr);
  assert.equal(readFileSync(join(fakeHome, '.agent-mission-floor', 'token'), 'utf8'), 'old-token');
  assert.ok(!existsSync(join(fakeHome, '.agent-mission-board')));
});

test('spool: an oversized leftover file is dropped unread', async () => {
  const spoolDir = tmp('amb-spool-big-');
  const big = `.${Date.now() - 10_000}-777.tmp`;
  writeFileSync(join(spoolDir, big), JSON.stringify({ session_id: 's', hook_event_name: 'Stop', pad: 'x'.repeat(3 * 1024 * 1024) }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(spoolDir, big), old, old); // a sender that died mid-send a minute ago
  const seen: string[] = [];
  const n = await drainSpool(spoolDir, (e) => seen.push(e.id));
  assert.equal(n, 0);
  assert.deepEqual(readdirSync(spoolDir), []);
});

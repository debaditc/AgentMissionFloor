import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SENDER = join(here, '../bin/amb-send');
const PLUGIN_COPY = join(here, '../../plugin/scripts/amb-send');
const PAYLOAD = JSON.stringify({ session_id: 'abc', hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: '/x' });

function run(home: string, input: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; ms: number }> {
  return new Promise((resolve) => {
    const start = performance.now();
    const p = spawn('/bin/sh', [SENDER], { env: { PATH: process.env.PATH ?? '', HOME: home, AMB_HOME: home, AMB_AUTOSTART: '0', ...env } });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.on('close', (code) => resolve({ code, stdout, ms: performance.now() - start }));
    p.stdin.end(input);
  });
}

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amb-sender-'));
  chmodSync(dir, 0o700);
  return dir;
}

test('posts the payload with auth, ts and id headers; silent; exits 0; fast', async () => {
  const dir = home();
  let got: { headers: IncomingHttpHeaders; body: string } | undefined;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got = { headers: req.headers, body };
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(dir, 'sender.url'), `http://127.0.0.1:${port}/v1/hook\n`);
  writeFileSync(join(dir, 'sender.headers'), 'Authorization: Bearer t0k3n\n');
  // The sender only talks to a collector whose pid is alive (this test process stands in).
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ pid: process.pid, port }));

  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await run(dir, PAYLOAD));
  server.close();

  for (const r of runs) {
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  }
  assert.equal(got?.body, PAYLOAD);
  assert.equal(got?.headers.authorization, 'Bearer t0k3n');
  assert.match(String(got?.headers['x-amb-ts']), /^\d{13}$/);
  assert.match(String(got?.headers['x-amb-id']), /^\d{13}-\d+$/);
  const sorted = runs.map((r) => r.ms).sort((a, b) => a - b);
  const median = sorted[2]!;
  console.log(`sender latency median ${median.toFixed(1)} ms (process spawn included)`);
  assert.ok(median < 200, `median ${median} ms`);
  assert.deepEqual(readdirSync(join(dir, 'spool')), [], 'nothing spooled on success');
});

test('collector down: spools the event, exits 0, stays silent', async () => {
  const dir = home();
  writeFileSync(join(dir, 'sender.url'), 'http://127.0.0.1:9/v1/hook\n'); // nothing listens on port 9
  writeFileSync(join(dir, 'sender.headers'), 'Authorization: Bearer x\n');
  const r = await run(dir, PAYLOAD);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  const files = readdirSync(join(dir, 'spool'));
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^\d+-\d+\.json$/);
  assert.equal(readFileSync(join(dir, 'spool', files[0]!), 'utf8'), PAYLOAD);
});

test('never configured: spools and exits 0', async () => {
  const dir = home();
  mkdirSync(join(dir, 'spool'), { recursive: true });
  const r = await run(dir, PAYLOAD);
  assert.equal(r.code, 0);
  assert.equal(readdirSync(join(dir, 'spool')).length, 1);
});

test('AMB_DISABLED=1 does nothing', async () => {
  const dir = home();
  const r = await run(dir, PAYLOAD, { AMB_DISABLED: '1' });
  assert.equal(r.code, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('plugin ships an identical copy of the sender', () => {
  assert.equal(readFileSync(PLUGIN_COPY, 'utf8'), readFileSync(SENDER, 'utf8'), 'run `pnpm sync:sender`');
});

test('never sends the token to whatever answers on a remembered port after a crash (review M-B)', async () => {
  const dir = home();
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.writeHead(204).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(dir, 'sender.url'), `http://127.0.0.1:${port}/v1/hook\n`);
  writeFileSync(join(dir, 'sender.headers'), 'Authorization: Bearer t0k3n\n');
  // A stale runtime file: the collector that wrote it is gone (pid 999999 doesn't exist).
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ pid: 999999, port }));
  const r = await run(dir, PAYLOAD);
  server.close();
  assert.equal(r.code, 0);
  assert.equal(hits, 0, 'nothing was sent to the stranger');
  assert.equal(readdirSync(join(dir, 'spool')).length, 1, 'the event was spooled instead');
});

test('spool caps: oversized events are dropped, not stored (review M3)', async () => {
  const dir = home();
  mkdirSync(join(dir, 'spool'), { recursive: true });
  const big = JSON.stringify({ session_id: 's', hook_event_name: 'PostToolUse', blob: 'x'.repeat(70_000) });
  const r = await run(dir, big);
  assert.equal(r.code, 0);
  assert.deepEqual(readdirSync(join(dir, 'spool')), []);
});

test('a huge payload never lands on disk in full (2 MB cap) and the sender still exits 0', async () => {
  const dir = home();
  mkdirSync(join(dir, 'spool'), { recursive: true });
  const r = await run(dir, 'x'.repeat(3 * 1024 * 1024));
  assert.equal(r.code, 0);
  assert.deepEqual(readdirSync(join(dir, 'spool')), [], 'over the spool cap: dropped');
});

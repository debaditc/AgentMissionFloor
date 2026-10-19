import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.ts');

function uninstallPurge(home: string, env: Record<string, string>) {
  // No `claude` on PATH here: the plugin steps fail harmlessly; only the purge logic runs.
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'uninstall', '--purge'], {
    env: { PATH: '/usr/bin:/bin', HOME: home, ...env },
    encoding: 'utf8',
  });
}

test('purge never deletes a folder that is not ours (AMF_HOME pointed at home)', () => {
  const home = mkdtempSync(join(tmpdir(), 'amf-cli-home-'));
  writeFileSync(join(home, 'precious.txt'), 'keep me');
  const r = uninstallPurge(home, { AMF_HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, 'precious.txt')), 'home folder untouched');
});

test('purge deletes only our files, and keeps anything else in the folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'amf-cli-home-'));
  const data = join(home, 'amf');
  mkdirSync(join(data, 'spool'), { recursive: true });
  for (const f of ['token', 'events.db', 'runtime.json']) writeFileSync(join(data, f), 'x');
  writeFileSync(join(data, 'notes.txt'), 'not ours');
  const r = uninstallPurge(home, { AMF_HOME: data });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(data, 'token')) && !existsSync(join(data, 'events.db')) && !existsSync(join(data, 'spool')));
  assert.ok(existsSync(join(data, 'notes.txt')), 'a file we did not create is kept');
});

test('stop never signals a process that is not our collector (pid reuse after a crash)', () => {
  const home = mkdtempSync(join(tmpdir(), 'amf-cli-home-'));
  const data = join(home, 'amf');
  mkdirSync(data, { recursive: true });
  // runtime.json names a live pid (this test process) but nothing answers as the collector.
  writeFileSync(join(data, 'runtime.json'), JSON.stringify({ pid: process.pid, port: 9, token: 't', url: 'http://127.0.0.1:9' }));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'stop'], { env: { PATH: '/usr/bin:/bin', HOME: home, AMF_HOME: data }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /was not running/);
});

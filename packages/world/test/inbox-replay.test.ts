import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AmbEvent } from '@agent-mission-floor/protocol';
import { buildScenario, scenarioEvents } from '../../simulator/src/index.ts';
import { buildReplay, emptyWorld, inboxItems, inConflict, reduce, reduceAll, stateAt, stateHash } from '../src/index.ts';

const opts = { runId: 'fixture', transcriptDir: '/tmp/none' };
const events = (name: string) => scenarioEvents(buildScenario(name, opts));

test('inbox: approval while waiting, cleared once the tool runs', () => {
  const evs = events('permission');
  let s = emptyWorld();
  let seen = false;
  for (const e of evs) {
    s = reduce(s, e);
    const items = inboxItems(s, e.ts);
    if (items.some((i) => i.kind === 'approval')) {
      const a = items.find((i) => i.kind === 'approval')!;
      assert.equal(a.kind === 'approval' && a.command, 'rm -rf dist node_modules/.cache');
      assert.equal(a.kind === 'approval' && a.tool, 'Bash');
      seen = true;
    }
  }
  assert.ok(seen, 'approval appeared');
  assert.equal(inboxItems(s, s.lastTs).filter((i) => i.kind === 'approval').length, 0);
});

test('inbox: question and mission complete; stable ids', () => {
  const solo = reduceAll(events('solo'));
  const q = inboxItems(solo, solo.lastTs).find((i) => i.kind === 'question');
  assert.ok(q && q.kind === 'question' && /pull-through cache/.test(q.message ?? ''));
  assert.equal(inboxItems(solo, solo.lastTs)[0]!.id, inboxItems(solo, solo.lastTs)[0]!.id);
  const team = reduceAll(events('team'));
  const m = inboxItems(team, team.lastTs).find((i) => i.kind === 'mission');
  assert.ok(m && m.kind === 'mission' && /Mission complete/.test(m.summary ?? ''));
  assert.match((m as { mission?: string }).mission ?? '', /billing settings/);
});

test('conflicts reach the inbox and the warning outline, then age out', () => {
  const base = reduceAll(events('conflict'));
  const conflict: AmbEvent = {
    id: 'c1', ts: base.lastTs + 1, protocolVersion: 1, source: 'watcher', sessionId: 'x', cwd: '/', kind: 'conflict',
    conflict: { path: '/shop/src/checkout/total.ts', first: { actorKey: 'a', ts: 1, added: 24, removed: 3, tool: 'Edit' }, second: { actorKey: 'b', ts: 2, added: 31, removed: 5, tool: 'Edit' }, windowMs: 120000 },
  };
  const s = reduce(base, conflict);
  const items = inboxItems(s, conflict.ts).filter((i) => i.kind === 'conflict');
  assert.equal(items.length, 1);
  assert.deepEqual([...inConflict(s, conflict.ts)].sort(), ['a', 'b']);
  assert.equal(inConflict(s, conflict.ts + 10 * 60_000).size, 0);
  assert.equal(inboxItems(s, conflict.ts + 31 * 60_000).filter((i) => i.kind === 'conflict').length, 0);
});

test('replay: lanes, moments, debrief, and seeking reproduces the live state', () => {
  const evs = [...events('team'), ...events('permission').map((e) => ({ ...e, ts: e.ts + 500 }))];
  const idx = buildReplay(evs);
  assert.ok(idx.lanes.length >= 5);
  const lead = idx.lanes.find((l) => l.blocks.some((b) => b.kind === 'door'));
  assert.ok(lead, 'someone spent time at the door');
  for (const l of idx.lanes) for (const b of l.blocks) assert.ok(b.end >= b.start);
  const kinds = new Set(idx.moments.map((m) => m.kind));
  for (const k of ['arrived', 'task', 'waited', 'mission'] as const) assert.ok(kinds.has(k), `moment ${k}`);
  assert.ok(idx.moments.some((m) => /waited \d+s/.test(m.text)));
  assert.equal(idx.debrief.tasksDone, 6, '5 team tasks + the solo session request card');
  assert.ok(idx.debrief.waitingMs > 5000);
  assert.ok(idx.debrief.workingPct > 0 && idx.debrief.workingPct <= 100);
  // Seeking to any time gives exactly the state a straight replay would.
  const sorted = [...evs].sort((a, b) => a.ts - b.ts);
  for (const frac of [0.1, 0.5, 0.93]) {
    const ts = idx.start + (idx.end - idx.start) * frac;
    const direct = reduceAll(sorted.filter((e) => e.ts <= ts));
    assert.equal(stateHash(stateAt(idx, ts)), stateHash(direct));
  }
});

test('replay: an idle session that never ended stops counting after an hour', async () => {
  const { DORMANT_AFTER_MS } = await import('../src/index.ts');
  const evs = events('solo');
  const later = { ...evs[0]!, id: 'late', ts: evs[evs.length - 1]!.ts + 5 * 60 * 60_000, kind: 'cwd.changed' as const, sessionId: 'someone-else', cwd: '/x' };
  const idx = buildReplay([...evs, later]);
  for (const l of idx.lanes) for (const b of l.blocks) if (b.kind === 'lounge') assert.ok(b.end - b.start <= DORMANT_AFTER_MS);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario, scenarioEvents } from '../../simulator/src/index.ts';
import { emptyWorld, reduce, reduceAll, type WorldState } from '@agent-mission-floor/world';
import { placeActors } from '../src/placement.ts';
import { OFFICE } from '../src/layout/layout.ts';

const opts = { runId: 'fixture', transcriptDir: '/tmp/none' };
const events = (name: string) => scenarioEvents(buildScenario(name, opts));

function until(name: string, pred: (s: WorldState) => boolean): WorldState {
  let s = emptyWorld();
  for (const e of events(name)) {
    s = reduce(s, e);
    if (pred(s)) return s;
  }
  assert.fail('never');
}

test('editing → sits at own desk facing it; reading → stands at the shelves', () => {
  const s = until('solo', (w) => Object.values(w.actors).some((a) => a.station === 'desk') && Object.values(w.actors).some((a) => a.station === 'library'));
  const places = placeActors(s, s.lastTs);
  for (const a of Object.values(s.actors)) {
    const p = places.get(a.key);
    if (!p) continue;
    if (a.station === 'desk' && a.role !== 'intern') {
      assert.equal(p.pose, 'sit');
      assert.equal(p.face, 'n');
      assert.ok(OFFICE.desks.some((d) => d.chair[0] === p.x && d.chair[1] === p.y));
    }
    if (a.station === 'library') assert.equal(p.pose === 'stand' || p.x === OFFICE.armchair.x, true);
  }
});

test('no two people share a spot; placement is deterministic', () => {
  for (const name of ['team', 'solo', 'flaky', 'permission']) {
    const s = reduceAll(events(name));
    const a = placeActors(s, s.lastTs);
    const b = placeActors(s, s.lastTs);
    assert.deepEqual([...a.entries()], [...b.entries()]);
    const coords = [...a.values()].map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    assert.equal(new Set(coords).size, coords.length, `${name}: overlapping spots ${coords.join(' ')}`);
  }
});

test('lead gets the lead desk; waiting people stand at the door with a raised hand', () => {
  const s = until('permission', (w) => Object.values(w.actors).some((a) => a.status === 'waiting'));
  const p = [...placeActors(s, s.lastTs).values()][0]!;
  assert.equal(p.x, OFFICE.spots.door[0]!.x);
  assert.equal(p.prop, 'hand');
  const team = until('team', (w) => Object.values(w.actors).some((a) => a.role === 'lead'));
  const lead = Object.values(team.actors).find((a) => a.role === 'lead')!;
  assert.equal(placeActors(team, team.lastTs).get(lead.key)?.deskId, 'lead');
});

test('everyone stays inside the floor even with 14 people in one zone', () => {
  let s = emptyWorld();
  for (const e of events('solo')) s = reduce(s, e);
  const base = Object.values(s.actors)[0]!;
  const actors = { ...s.actors };
  for (let i = 0; i < 14; i++) actors[`k${i}`] = { ...base, key: `k${i}`, station: 'lab', status: 'working', startedTs: base.startedTs + i, lastTs: s.lastTs };
  const places = placeActors({ ...s, actors }, s.lastTs);
  for (const p of places.values()) {
    assert.ok(p.x > 0 && p.x < OFFICE.grid.w && p.y > 0 && p.y < OFFICE.grid.d, `${p.key} at ${p.x},${p.y}`);
  }
});

test('sticky seats: people already in a zone keep their spot when someone else leaves', () => {
  const s = reduceAll(events('solo'));
  const base = Object.values(s.actors)[0]!;
  const mk = (k: string, i: number) => ({ ...base, key: k, station: 'lab' as const, status: 'working' as const, startedTs: base.startedTs + i, lastTs: s.lastTs, parentKey: undefined });
  const three = { ...s, actors: { a: mk('a', 1), b: mk('b', 2), c: mk('c', 3) } };
  const first = placeActors(three, s.lastTs);
  const { a: _gone, ...rest } = three.actors;
  void _gone;
  const after = placeActors({ ...three, actors: rest }, s.lastTs, undefined, first);
  assert.equal(after.get('b')!.spotId, first.get('b')!.spotId, 'b did not move');
  assert.equal(after.get('c')!.spotId, first.get('c')!.spotId, 'c did not move');
});

test('ping pong: exactly two idle people play, the third gets coffee, a lone idler never plays', () => {
  const s = reduceAll(events('solo'));
  const base = Object.values(s.actors)[0]!;
  const idler = (k: string, i: number) => ({ ...base, key: k, station: 'lounge' as const, status: 'idle' as const, role: 'solo' as const, startedTs: base.startedTs + i, lastTs: s.lastTs - 1000 + i, parentKey: undefined, needs: undefined });
  const zones = (keys: string[], prev?: Map<string, ReturnType<typeof placeActors> extends Map<string, infer P> ? P : never>) => {
    const actors = Object.fromEntries(keys.map((k, i) => [k, idler(k, i)]));
    return placeActors({ ...s, actors }, s.lastTs, undefined, prev);
  };
  const one = zones(['a']);
  assert.equal(one.get('a')!.zone, 'lounge', 'one idle person never plays alone');
  const three = zones(['a', 'b', 'c']);
  const players = [...three.values()].filter((p) => p.zone === 'pingpong');
  assert.equal(players.length, 2);
  assert.ok(players.every((p) => p.prop === 'paddle'));
  assert.equal([...three.values()].filter((p) => p.zone === 'lounge').length, 1);
  // Players keep playing when a newcomer arrives; the newcomer gets coffee.
  const four = zones(['a', 'b', 'c', 'd'], three);
  for (const p of players) assert.equal(four.get(p.key)!.zone, 'pingpong');
  assert.equal(four.get('d')!.zone, 'lounge');
  // A player gets work: the other player continues with the next idle person.
  const leftover = zones(['b', 'c', 'd'], four);
  assert.equal([...leftover.values()].filter((p) => p.zone === 'pingpong').length, 2);
});

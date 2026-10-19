import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario, scenarioEvents } from '../../simulator/src/index.ts';
import { awaySummary, buildReplay, filterByProject, projectOf, projectsIn, reduceAll, type Actor } from '@agent-mission-floor/world';
import { normalizeHook } from '@agent-mission-floor/protocol';
import { groupTeam, segments, sentence } from '../src/team.ts';
import { digestView } from '../src/digest.ts';
import { placeAt } from '../src/zones.ts';
import { OFFICE } from '../src/layout/layout.ts';

const opts = { runId: 'fixture', transcriptDir: '/tmp/none' };
const events = (name: string) => scenarioEvents(buildScenario(name, opts));

test('team panel: needs you first, then working, done (newest first), idle; interns under their parent', () => {
  const base = { sessionId: 's', role: 'solo', color: 0, tint: false, station: 'desk', activity: 'editing', bubble: null, chip: null, cwd: '/r', toolCalls: 0, errors: 0, lastTs: 0, memory: null, doneTools: [], pendingTools: [] } as const;
  const mk = (key: string, extra: Partial<Actor>): Actor => ({ ...base, key, name: key, startedTs: 1, status: 'idle', ...extra }) as Actor;
  const people = [
    mk('idle1', {}),
    mk('done-old', { finished: { what: 'A', ts: 10 } }),
    mk('work', { status: 'working' }),
    mk('ask', { status: 'waiting', needs: { type: 'question', ts: 50 } }),
    mk('done-new', { finished: { what: 'B', ts: 20 } }),
    mk('intern', { status: 'working', parentKey: 'work', role: 'intern' }),
    mk('approve', { status: 'waiting', needs: { type: 'approval', ts: 40 } }),
  ];
  const groups = groupTeam(people);
  assert.deepEqual(groups.map((g) => g.group), ['needs', 'working', 'done', 'idle']);
  assert.deepEqual(groups[0]!.rows.map((r) => r.actor.key), ['approve', 'ask'], 'longest waiting first');
  assert.deepEqual(groups[1]!.rows.map((r) => [r.actor.key, r.interns.map((i) => i.key)]), [['work', ['intern']]]);
  assert.deepEqual(groups[2]!.rows.map((r) => r.actor.key), ['done-new', 'done-old']);
  assert.equal(sentence(people[1]!), 'Done: A');
  assert.equal(sentence(people[3]!), 'Has a question for you');
  assert.deepEqual(segments([{ status: 'pending' }, { status: 'completed' }, { status: 'in_progress' }] as never), ['completed', 'in_progress', 'pending']);
});

test('hovering the floor names the place: library, café, the door, plain floor', () => {
  const lib = OFFICE.spots.library[0]!;
  assert.equal(placeAt(lib.x, lib.y)?.name, 'Library');
  const cafe = OFFICE.spots.lounge[0]!;
  assert.equal(placeAt(cafe.x, cafe.y)?.id, 'lounge');
  const door = OFFICE.spots.door[0]!;
  assert.equal(placeAt(door.x, door.y)?.amber, true);
  assert.equal(placeAt(-50, -50), null);
});

test('away digest: what finished, who waited, using the live office names', () => {
  const evs = events('team');
  const idx = buildReplay(evs);
  const since = idx.start + (idx.end - idx.start) / 2;
  const sum = awaySummary(idx, since);
  assert.ok(sum.tasks.length > 0, 'tasks finished in the second half');
  const v = digestView(sum, (key) => `N-${key.slice(-4)}`)!;
  assert.match(v.title, /While you were away/);
  assert.ok(v.lines.some((l) => /tasks? finished \(N-/.test(l)), 'names come from the given lookup');
  assert.equal(v.tasks.length, Math.min(6, sum.tasks.length));
  // Nothing happened: no card.
  assert.equal(digestView(awaySummary(idx, idx.end + 1), (k) => k), null);
});

test('project filter: two repos, each sees only its people, cards and missions', () => {
  let i = 0;
  const h = (session: string, cwd: string, hook: string, extra: Record<string, unknown> = {}) =>
    normalizeHook({ session_id: session, cwd, hook_event_name: hook, ...extra }, { id: `p${++i}`, ts: 1_760_000_000_000 + i * 1000, source: 'hook' })!;
  const s = reduceAll([
    h('a1', '/code/shop', 'SessionStart'),
    h('a1', '/code/shop', 'UserPromptSubmit', { prompt: 'Fix checkout' }),
    h('b1', '/code/blog', 'SessionStart'),
    h('b1', '/code/blog', 'UserPromptSubmit', { prompt: 'Write a post' }),
    h('a1', '/code/shop', 'SubagentStart', { agent_id: 'aintern-1', agent_type: 'Explore' }),
  ]);
  const intern = Object.values(s.actors).find((a) => a.agentId)!;
  assert.equal(projectOf(s, intern), '/code/shop', 'interns belong to their parent project');
  assert.deepEqual(projectsIn(s).map((p) => [p.name, p.people]), [['shop', 2], ['blog', 1]]);
  const shop = filterByProject(s, '/code/shop');
  assert.deepEqual(Object.keys(shop.actors).sort(), ['a1', intern.key].sort());
  assert.ok(Object.values(shop.cards).every((c) => c.sessionId === 'a1'));
  assert.equal(filterByProject(s, null), s, 'no filter: the same state');
});

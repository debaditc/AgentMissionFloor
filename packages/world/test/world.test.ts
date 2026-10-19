import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHook, type AmbEvent } from '@agent-mission-floor/protocol';
import { buildScenario, scenarioEvents, SCENARIOS } from '../../simulator/src/index.ts';
import { emptyWorld, isBlocked, isDormant, DORMANT_AFTER_MS, isStale, reduce, reduceAll, stateHash, STALE_AFTER_MS, type WorldState } from '../src/index.ts';

const opts = { runId: 'fixture', transcriptDir: '/tmp/none' };
const events = (name: string) => scenarioEvents(buildScenario(name, opts));
const live = (s: WorldState) => Object.values(s.actors).filter((a) => a.status !== 'gone');

/** Replays until the predicate holds; returns that intermediate state. */
function until(evs: AmbEvent[], pred: (s: WorldState) => boolean): WorldState {
  let s = emptyWorld();
  for (const e of evs) {
    s = reduce(s, e);
    if (pred(s)) return s;
  }
  assert.fail('predicate never held');
}

test('deterministic: same stream → same state hash; different streams differ', () => {
  for (const name of Object.keys(SCENARIOS)) {
    const a = stateHash(reduceAll(events(name)));
    const b = stateHash(reduceAll(events(name)));
    assert.equal(a, b, name);
  }
  assert.notEqual(stateHash(reduceAll(events('solo'))), stateHash(reduceAll(events('flaky'))));
});

test('reduce does not mutate its input', () => {
  const evs = events('solo');
  const mid = reduceAll(evs.slice(0, 20));
  const before = JSON.stringify(mid);
  reduceAll(evs.slice(20), mid);
  assert.equal(JSON.stringify(mid), before);
});

test('team: roles, claims, carry, done, mission complete', () => {
  const evs = events('team');
  const end = reduceAll(evs);
  const actors = Object.values(end.actors);
  const lead = actors.find((a) => a.role === 'lead');
  assert.ok(lead, 'a lead');
  const teammates = actors.filter((a) => a.role === 'teammate').map((a) => a.name).sort();
  assert.deepEqual(teammates, ['Emma', 'Harry', 'James', 'Olivia']);
  assert.equal(actors.filter((a) => a.role === 'intern').length, 0);

  const cards = Object.values(end.cards);
  assert.equal(cards.length, 5, 'five team cards, the lead prompt is a mission not a card');
  assert.ok(!cards.some((c) => c.assignment), 'a team with a task list gets no extra assignment cards');
  // Everyone who finished a task is marked done with what they finished; the lead with the mission.
  for (const c of cards) assert.ok(end.actors[c.ownerKey!]!.finished, `${c.ownerName} is marked finished`);
  assert.equal(lead.finished?.what, end.missions[lead.sessionId]?.text);
  assert.ok(cards.every((c) => c.status === 'completed'));
  const owners = Object.fromEntries(cards.map((c) => [c.id, end.actors[c.ownerKey!]?.name]));
  assert.deepEqual(owners, { 1: 'Emma', 2: 'James', 3: 'Olivia', 4: 'Emma', 5: 'Harry' });

  const mission = end.missions[lead.sessionId];
  assert.ok(mission?.complete, 'mission complete');
  assert.equal(lead.needs?.type, 'mission');
  assert.equal(lead.station, 'door');

  // Mid-run: Emma carries card 1 at a desk while card 2 is padlocked behind it.
  const mid = until(evs, (s) => Object.values(s.actors).some((a) => a.name === 'Emma' && a.station === 'desk'));
  const juno = Object.values(mid.actors).find((a) => a.name === 'Emma')!;
  assert.equal(mid.cards[juno.cardKey!]?.id, '1');
  const card2 = Object.values(mid.cards).find((c) => c.id === '2')!;
  assert.ok(isBlocked(card2, mid));
  const rex = Object.values(mid.actors).find((a) => a.name === 'James')!;
  assert.equal(rex.station, 'lounge', 'nothing unblocked for Rex yet');
});

test('solo: each prompt is a self-assigned card; Stop pins it to Done; intern comes and goes', () => {
  const evs = events('solo');
  const end = reduceAll(evs);
  const cards = Object.values(end.cards);
  assert.equal(cards.length, 4, 'three requests and the intern\'s assignment');
  assert.ok(cards.every((c) => c.status === 'completed' && c.ownerKey));
  const interns = Object.values(end.actors).filter((a) => a.role === 'intern');
  assert.equal(interns.length, 1);
  // The intern pinned their assignment to Done before leaving.
  const internCard = cards.find((c) => c.assignment)!;
  assert.equal(internCard.ownerKey, interns[0]!.key);
  assert.equal(interns[0]!.finished?.what, internCard.title);
  assert.equal(interns[0]!.status, 'gone');
  assert.ok(interns[0]!.tint);
  const parent = end.actors[interns[0]!.parentKey!]!;
  assert.equal(interns[0]!.color, parent.color, 'interns share their parent color (tinted)');
  // The infra session ended on a question: it waits at the door.
  const asking = Object.values(end.actors).find((a) => a.needs?.type === 'question');
  assert.ok(asking);
  assert.equal(asking.station, 'door');
  // Mid-run: the intern stands at the library reading.
  const mid = until(evs, (s) => Object.values(s.actors).some((a) => a.role === 'intern' && a.station === 'library'));
  assert.ok(mid);
});

test('permission: walks to the door, then back to work once the tool runs', () => {
  const evs = events('permission');
  const waiting = until(evs, (s) => live(s).some((a) => a.status === 'waiting'));
  const a = live(waiting)[0]!;
  assert.equal(a.station, 'door');
  assert.equal(a.bubble, 'approval');
  assert.equal(a.needs?.type, 'approval');
  assert.match(a.needs?.message ?? '', /rm -rf dist/);
  const end = reduceAll(evs);
  const b = live(end)[0]!;
  assert.equal(b.needs, undefined);
  assert.equal(b.station, 'lounge');
});

test('compaction: walks to the archive, then back to where they were', () => {
  const evs = events('compaction');
  const mid = until(evs, (s) => live(s).some((a) => a.station === 'archive'));
  const a = live(mid)[0]!;
  assert.equal(a.bubble, 'archive');
  assert.equal(a.returnStation, 'library');
  const i = evs.findIndex((e) => e.kind === 'compact.post');
  const after = reduceAll(evs.slice(0, i + 1));
  assert.equal(live(after)[0]!.station, 'library');
});

test('flaky: failures count, bug bubble, then a check', () => {
  const evs = events('flaky');
  const failing = until(evs, (s) => live(s).some((a) => a.bubble === 'bug'));
  const a = live(failing)[0]!;
  assert.equal(a.station, 'lab');
  assert.equal(a.chip?.tone, 'error');
  const end = reduceAll(evs);
  assert.equal(end.stats.errors, 2);
  const passed = until(evs, (s) => live(s).some((x) => x.bubble === 'check'));
  assert.ok(passed);
});

test('out of order: a PreToolUse arriving after its PostToolUse is ignored', () => {
  const ts = 1_760_000_000_000;
  const mk = (hook: string, extra: Record<string, unknown>, i: number) =>
    normalizeHook({ session_id: 'sess-1', cwd: '/r', hook_event_name: hook, ...extra }, { id: `e${i}`, ts: ts + i, source: 'hook' })!;
  const read = { tool_name: 'Read', tool_use_id: 'u1', tool_input: { file_path: '/r/a.ts' } };
  const edit = { tool_name: 'Edit', tool_use_id: 'u2', tool_input: { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' } };
  const s = reduceAll([mk('PostToolUse', read, 1), mk('PreToolUse', edit, 2), mk('PreToolUse', read, 3)]);
  const a = s.actors['sess-1']!;
  assert.equal(a.station, 'desk', 'late Read pre must not pull them back to the library');
  assert.equal(a.toolCalls, 2);
  // Parallel calls: two Pres then two Posts count as two calls, not four.
  const p = reduceAll([mk('PreToolUse', read, 1), mk('PreToolUse', edit, 2), mk('PostToolUse', read, 3), mk('PostToolUse', edit, 4)]);
  assert.equal(p.actors['sess-1']!.toolCalls, 2);
});

test('stale: in-progress card whose owner went idle a minute ago', () => {
  const end = reduceAll(events('solo'));
  const ts = end.lastTs;
  // Force a card back to in_progress with an idle owner to exercise the selector.
  const card = Object.values(end.cards)[0]!;
  const owner = end.actors[card.ownerKey!]!;
  const s: WorldState = {
    ...end,
    cards: { ...end.cards, [card.key]: { ...card, status: 'in_progress' } },
    actors: { ...end.actors, [owner.key]: { ...owner, status: 'idle' } },
  };
  assert.ok(!isStale(s.cards[card.key]!, s, owner.lastTs + 1000));
  assert.ok(isStale(s.cards[card.key]!, s, owner.lastTs + STALE_AFTER_MS + 1));
  void ts;
});

test('a solo session sharing a teammate name never steals the teammate\'s events', () => {
  // Solo sessions first, so auto-names are handed out before the team exists.
  const solo = events('solo');
  const team = events('team').map((e) => ({ ...e, ts: e.ts + 100_000 }));
  const s = reduceAll([...solo, ...team]);
  for (const name of ['Emma', 'Olivia', 'Harry', 'James']) {
    const teammate = Object.values(s.actors).find((a) => a.role === 'teammate' && a.name === name)!;
    assert.equal(teammate.station, 'lounge', `${name} ends idle in the lounge`);
  }
  const lead = Object.values(s.actors).find((a) => a.role === 'lead')!;
  assert.equal(s.missions[lead.sessionId]!.text, 'Ship the billing settings page: plan, API, UI, tests and docs');
});

test('names are stable per session and unique among live actors', () => {
  const end = reduceAll(events('solo'));
  const names = live(end).map((a) => a.name);
  assert.equal(new Set(names).size, names.length);
  const again = reduceAll(events('solo'));
  assert.deepEqual(live(again).map((a) => a.name), names);
});

test('a late Stop recovered after SessionEnd closes the card but does not bring them back', () => {
  const ts = 1_760_000_000_000;
  const mk = (hook: string, extra: Record<string, unknown>, at: number, i: number) =>
    normalizeHook({ session_id: 'sess-l', cwd: '/r', hook_event_name: hook, ...extra }, { id: `l${i}`, ts: ts + at, source: 'hook' })!;
  const s = reduceAll([
    mk('UserPromptSubmit', { prompt: 'Do it' }, 0, 1),
    mk('SessionEnd', { reason: 'other' }, 3000, 2),
    mk('Stop', { last_assistant_message: 'Done.' }, 2000, 3), // arrives last, happened before the end
  ]);
  assert.equal(s.actors['sess-l']!.status, 'gone');
  assert.equal(Object.values(s.cards)[0]!.status, 'completed');
});

test('dormant: idle with no events for an hour', () => {
  const end = reduceAll(events('solo'));
  const idle = live(end).find((a) => a.status === 'idle')!;
  assert.ok(!isDormant(idle, idle.lastTs + 1000));
  assert.ok(isDormant(idle, idle.lastTs + DORMANT_AFTER_MS + 1));
  const waiting = live(end).find((a) => a.status === 'waiting')!;
  assert.ok(!isDormant(waiting, waiting.lastTs + DORMANT_AFTER_MS + 1), 'someone waiting on Deb never goes dormant');
});

test('real agent team shapes (2026-10-18 run): teammates matched by agent_type, assignments from Agent spawns', () => {
  const S = 'dfcb0358-8d01-4353-841e-afb0e22154f6';
  const team = 'session-dfcb0358';
  let i = 0;
  const ts = 1_760_000_000_000;
  const hookEv = (hook: string, extra: Record<string, unknown>) =>
    normalizeHook({ session_id: S, cwd: '/repo', hook_event_name: hook, ...extra }, { id: `r${++i}`, ts: ts + i * 1000, source: 'hook' })!;
  const snapshot = (members: Array<{ name: string; agentId: string; agentType: string }>): AmbEvent => ({
    id: `r${++i}`, ts: ts + i * 1000, protocolVersion: 1, source: 'watcher', sessionId: team, cwd: '', kind: 'team.snapshot', teamName: team, members,
  });
  const lead = { name: 'team-lead', agentId: `team-lead@${team}`, agentType: 'team-lead' };
  const roles = ['security', 'tests', 'docs'];
  const descriptions = ['Security review of repo', 'Test suite review', 'Documentation review'];
  const evs: AmbEvent[] = [
    hookEv('SessionStart', { source: 'startup' }),
    snapshot([lead]),
    hookEv('UserPromptSubmit', { prompt: 'Spawn 3 teammates to review this repo' }),
  ];
  roles.forEach((r, k) => evs.push(hookEv('PreToolUse', { tool_name: 'Agent', tool_use_id: `sp${k}`, tool_input: { subagent_type: 'general-purpose', name: `${r}-reviewer`, description: descriptions[k] } })));
  roles.forEach((r, k) => {
    evs.push(hookEv('PostToolUse', { tool_name: 'Agent', tool_use_id: `sp${k}`, tool_input: { subagent_type: 'general-purpose', name: `${r}-reviewer`, description: descriptions[k] } }));
    evs.push(hookEv('SubagentStart', { agent_id: `a${r}-reviewer-abc${k}`, agent_type: `${r}-reviewer` }));
  });
  evs.push(snapshot([lead, ...roles.map((r) => ({ name: `${r}-reviewer`, agentId: `${r}-reviewer@${team}`, agentType: 'general-purpose' }))]));
  evs.push(hookEv('PreToolUse', { agent_id: 'adocs-reviewer-abc2', agent_type: 'docs-reviewer', tool_name: 'Read', tool_use_id: 'x1', tool_input: { file_path: '/repo/README.md' } }));
  evs.push(hookEv('SubagentStop', { agent_id: 'adocs-reviewer-abc2', agent_type: 'docs-reviewer', last_assistant_message: 'Docs look fine.' }));
  evs.push(hookEv('TeammateIdle', { agent_id: 'adocs-reviewer-abc2', agent_type: 'docs-reviewer', teammate_name: 'docs-reviewer', team_name: team }));

  const s = reduceAll(evs);
  const crew = Object.values(s.actors).filter((a) => a.agentId);
  assert.equal(crew.length, 3);
  for (const a of crew) assert.equal(a.role, 'teammate', `${a.name} should be a teammate`);
  // Role-like names from the lead become handles; everyone gets a friendly first name.
  const byName = Object.fromEntries(crew.map((a) => [a.handle!, a]));
  assert.deepEqual(Object.keys(byName).sort(), ['Docs reviewer', 'Security reviewer', 'Tests reviewer']);
  for (const a of crew) assert.match(a.name, /^[A-Z][a-z]+$/, `${a.name} should be a first name`);
  assert.equal(new Set(crew.map((a) => a.name)).size, 3);
  assert.equal(byName['Security reviewer']!.assignment, 'Security review of repo');
  assert.equal(byName['Docs reviewer']!.assignment, 'Documentation review');
  assert.equal(byName['Docs reviewer']!.assignmentDone, true);
  assert.equal(byName['Docs reviewer']!.status, 'idle', 'teammates stay in the office after their turn');
  assert.equal(byName['Docs reviewer']!.station, 'lounge');
  // No task list: each teammate's assignment is a card; the docs reviewer's is pinned to Done.
  const assignmentCards = Object.values(s.cards).filter((c) => c.assignment);
  assert.equal(assignmentCards.length, 3);
  const docsCard = assignmentCards.find((c) => c.ownerKey === byName['Docs reviewer']!.key)!;
  assert.equal(docsCard.status, 'completed');
  assert.equal(docsCard.title, 'Documentation review');
  assert.equal(byName['Docs reviewer']!.finished?.what, 'Documentation review');
  assert.equal(assignmentCards.filter((c) => c.status === 'in_progress').length, 2, 'the other two are still working');
  assert.equal(byName['Security reviewer']!.finished, undefined);
  assert.equal(Object.values(s.actors).find((a) => !a.agentId)!.role, 'lead');
});

test('agent.meta enrichment marks in-process teammates even without a team file', () => {
  const ts = 1_760_000_000_000;
  const start = normalizeHook({ session_id: 's9', cwd: '/r', hook_event_name: 'SubagentStart', agent_id: 'arev-1', agent_type: 'rev' }, { id: 'm1', ts, source: 'hook' })!;
  const meta: AmbEvent = { id: 'm2', ts: ts + 1, protocolVersion: 1, source: 'transcript', sessionId: 's9', agentId: 'arev-1', cwd: '/r', kind: 'agent.meta', meta: { description: 'Review the API', name: 'reviewer', model: 'opus', taskKind: 'in_process_teammate' } };
  const s = reduceAll([start, meta]);
  const a = s.actors['s9:arev-1']!;
  assert.equal(a.role, 'teammate');
  assert.equal(a.name, 'Reviewer', 'a single-word name from the lead is kept as their name');
  assert.equal(a.assignment, 'Review the API');
});

test('names stay balanced between English and Indian as people arrive', async () => {
  const { ENGLISH_NAMES, INDIAN_NAMES } = await import('../src/index.ts');
  const ts = 1_760_000_000_000;
  let s = emptyWorld();
  for (let i = 0; i < 10; i++) {
    s = reduce(s, normalizeHook({ session_id: `bal-${i}-${'x'.repeat(i)}`, cwd: '/r', hook_event_name: 'SessionStart', source: 'startup' }, { id: `b${i}`, ts: ts + i, source: 'hook' })!);
    const names = live(s).map((a) => a.name);
    const en = names.filter((n) => (ENGLISH_NAMES as readonly string[]).includes(n)).length;
    const ind = names.filter((n) => (INDIAN_NAMES as readonly string[]).includes(n)).length;
    assert.ok(Math.abs(en - ind) <= 1, `after ${i + 1}: ${en} English vs ${ind} Indian (${names.join(', ')})`);
  }
  assert.equal(new Set(live(s).map((a) => a.name)).size, 10, 'all different');
});

test('no agent is ever called Deb: that name belongs to the human', async () => {
  const { HUMAN_NAME, NAMES } = await import('../src/index.ts');
  assert.ok(!(NAMES as readonly string[]).includes(HUMAN_NAME));
  const s = reduceAll([normalizeHook({ session_id: 't-1', cwd: '/r', hook_event_name: 'SubagentStart', agent_id: 'adeb-1', agent_type: 'deb' }, { id: 'h1', ts: 1, source: 'hook' })!]);
  assert.notEqual(s.actors['t-1:adeb-1']!.name, 'Deb', 'even when the lead names a teammate "deb"');
});

test('finished: set when a solo request is done, cleared when new work starts', () => {
  const ts = 1_760_000_000_000;
  let i = 0;
  const h = (hook: string, extra: Record<string, unknown> = {}) =>
    normalizeHook({ session_id: 'f1', cwd: '/r', hook_event_name: hook, ...extra }, { id: `f${++i}`, ts: ts + i * 1000, source: 'hook' })!;
  const done = reduceAll([h('SessionStart'), h('UserPromptSubmit', { prompt: 'Fix the login bug' }), h('Stop')]);
  const a = done.actors['f1']!;
  assert.equal(a.finished?.what, 'Fix the login bug');
  assert.equal(a.status, 'idle');
  const again = reduceAll([h('SessionStart'), h('UserPromptSubmit', { prompt: 'Fix the login bug' }), h('Stop'), h('UserPromptSubmit', { prompt: 'Now add a test' })]);
  assert.equal(again.actors['f1']!.finished, undefined, 'working again');
  const asked = reduceAll([h('SessionStart'), h('UserPromptSubmit', { prompt: 'Fix it' }), h('Stop', { last_assistant_message: 'Which file do you mean?' })]);
  assert.ok(asked.actors['f1']!.status === 'waiting' || asked.actors['f1']!.finished, 'a question is waiting, not silently done');
});

test('a teammate the lead names after someone already in the office gets their own name', () => {
  const ts = 1_760_000_000_000;
  let i = 0;
  const S = 'clash-lead';
  const team = 'session-clash';
  const h = (hook: string, extra: Record<string, unknown> = {}) =>
    normalizeHook({ session_id: S, cwd: '/r', hook_event_name: hook, ...extra }, { id: `c${++i}`, ts: ts + i * 1000, source: 'hook' })!;
  const start = reduceAll([h('SessionStart')]);
  const leadName = start.actors[S]!.name;
  const given = leadName.toLowerCase(); // the lead calls its teammate by the lead's own office name
  const snapshot: AmbEvent = {
    id: `c${++i}`, ts: ts + i * 1000, protocolVersion: 1, source: 'watcher', sessionId: team, cwd: '', kind: 'team.snapshot', teamName: team,
    members: [{ name: 'team-lead', agentId: `team-lead@${team}`, agentType: 'team-lead', sessionId: S }, { name: given, agentId: `${given}@${team}`, agentType: 'general-purpose' }],
  };
  const evs: AmbEvent[] = [
    h('SessionStart'),
    snapshot,
    h('SubagentStart', { agent_id: `a${given}-1f2e`, agent_type: given }),
    h('TaskCompleted', { agent_id: `a${given}-1f2e`, agent_type: given, teammate_name: given, team_name: team, task_id: '1', task_subject: 'Write the docs' }),
  ];
  const s = reduceAll(evs);
  const mate = Object.values(s.actors).find((a) => a.agentId)!;
  assert.equal(s.actors[S]!.name, leadName, 'the lead keeps the name everyone has already seen');
  assert.notEqual(mate.name, leadName, 'no two people share a name');
  assert.equal(mate.alias, leadName, "the lead's name for them is kept for matching");
  const card = Object.values(s.cards).find((c) => c.id === '1')!;
  assert.equal(card.ownerKey, mate.key, 'their task is still theirs, not the lead\'s');
  const names = Object.values(s.actors).filter((a) => a.status !== 'gone').map((a) => a.name);
  assert.equal(new Set(names).size, names.length);
});

test('stopped background agents leave the office (TaskStop + task-notification, no SubagentStop)', () => {
  // The real 2026-10-19 sequence: three reviewers spawned in the background, then stopped.
  const ts = 1_760_000_000_000;
  let i = 0;
  const S = 'stop-lead';
  const h = (hook: string, extra: Record<string, unknown> = {}) =>
    normalizeHook({ session_id: S, cwd: '/repo', hook_event_name: hook, ...extra }, { id: `t${++i}`, ts: ts + i * 1000, source: 'hook' })!;
  const ids = ['aad35a2d29b3c41d7', 'ab32d52ebf9cd4387', 'a3b368ef06e48a393'];
  const descs = ['Review README.md accuracy', 'Code review of repo', 'Security review of repo'];
  const evs = [h('SessionStart'), h('UserPromptSubmit', { prompt: 'Review the repo three ways' })];
  ids.forEach((id, k) => {
    evs.push(h('PreToolUse', { tool_name: 'Agent', tool_use_id: `sp${k}`, tool_input: { subagent_type: 'general-purpose', description: descs[k], run_in_background: true } }));
    evs.push(h('SubagentStart', { agent_id: id, agent_type: 'general-purpose' }));
    evs.push(h('PostToolUse', { tool_name: 'Agent', tool_use_id: `sp${k}`, tool_input: { subagent_type: 'general-purpose', description: descs[k] } }));
    evs.push(h('PreToolUse', { agent_id: id, agent_type: 'general-purpose', tool_name: 'Bash', tool_use_id: `g${k}`, tool_input: { command: 'grep -rn VERSION .' } }));
  });
  evs.push(h('Stop'), h('UserPromptSubmit', { prompt: 'can you stop the work' }));
  ids.forEach((id, k) => evs.push(h('PostToolUse', { tool_name: 'TaskStop', tool_use_id: `ks${k}`, tool_input: { task_id: id } })));
  const working = reduceAll(evs.slice(0, -3));
  assert.equal(Object.values(working.actors).filter((a) => a.agentId && a.status === 'working').length, 3, 'busy before the stop');

  const stopped = reduceAll(evs);
  for (const id of ids) {
    const a = stopped.actors[`${S}:${id}`]!;
    assert.equal(a.status, 'gone', `${a.name} left`);
    assert.equal(a.activity, 'stopped');
    assert.equal(a.finished, undefined, 'stopped is not done');
  }
  assert.ok(!Object.values(stopped.cards).some((c) => c.assignment), 'unfinished assignment cards come down');

  // The notifications Claude Code then feeds the lead are not new requests from Deb.
  const note = (id: string, status: string) =>
    h('UserPromptSubmit', { prompt: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<output-file>/tmp/x/${id}.output</output-file>\n<status>${status}</status>\n<summary>Agent stopped</summary>\n</task-notification>` });
  const after = reduceAll([...evs, ...ids.map((id) => note(id, 'killed')), h('Stop')]);
  const cardsBefore = Object.keys(stopped.cards).length;
  assert.equal(Object.keys(after.cards).length, cardsBefore, 'no cards made from notifications');
  assert.ok(!Object.values(after.missions).some((m) => m.text.includes('task-notification')));
  assert.ok(!Object.values(after.cards).some((c) => c.title.includes('task-notification')));

  // Notifications alone (no TaskStop seen) also end the agents; "completed" counts as done.
  const viaNotice = reduceAll([...evs.slice(0, -3), note(ids[0]!, 'killed'), note(ids[1]!, 'completed')]);
  assert.equal(viaNotice.actors[`${S}:${ids[0]}`]!.status, 'gone');
  assert.equal(viaNotice.actors[`${S}:${ids[1]}`]!.finished?.what, descs[1]);
  assert.equal(viaNotice.actors[`${S}:${ids[2]}`]!.status, 'working', 'the one not reported keeps working');
});

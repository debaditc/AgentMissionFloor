import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  categorizeTool,
  cardTitle,
  contextWindowFor,
  endsWithQuestion,
  isTestCommand,
  normalizeHook,
  pctFree,
  stationForCategory,
  validateEvent,
} from '../src/index.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const opts = { id: 'e1', ts: 1_760_000_000_000, source: 'hook' as const };

test('test-command detection', () => {
  for (const c of ['pnpm test', 'npm run test -- --watch=false', 'pytest -q', 'npx vitest run a.test.ts', 'go test ./...', 'cargo test', 'node --test', 'make check', 'jest src'])
    assert.ok(isTestCommand(c), c);
  for (const c of ['git status', 'ls latest/', 'echo contest', 'cat test.txt', 'pnpm build']) assert.ok(!isTestCommand(c), c);
});

test('tool → category → station (§8)', () => {
  const cases: Array<[string, Record<string, unknown> | undefined, string | null]> = [
    ['Edit', {}, 'desk'],
    ['Write', {}, 'desk'],
    ['Read', {}, 'library'],
    ['Grep', {}, 'library'],
    ['Bash', { command: 'pnpm test' }, 'lab'],
    ['Bash', { command: 'git push' }, 'server'],
    ['WebFetch', {}, 'window'],
    ['Agent', {}, 'whiteboard'],
    ['ExitPlanMode', {}, 'whiteboard'],
    ['TaskUpdate', {}, 'board'],
    ['mcp__github__create_issue', {}, null],
  ];
  for (const [name, input, station] of cases) assert.equal(stationForCategory(categorizeTool(name, input)), station, name);
});

test('context windows (D1)', () => {
  assert.equal(contextWindowFor('claude-opus-5-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-4-7'), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-4-6'), 200_000);
  assert.equal(contextWindowFor('claude-opus-4-6[1m]'), 1_000_000);
  assert.equal(contextWindowFor('claude-sonnet-4-5-20250929'), 200_000);
  assert.equal(contextWindowFor('claude-sonnet-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-haiku-4-5'), 200_000);
  assert.equal(contextWindowFor('claude-haiku-5-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-fable-5-1'), 1_000_000);
  assert.equal(contextWindowFor('claude-opus-5-5', { disable1m: true }), 200_000);
  assert.equal(contextWindowFor('gpt-x'), null);
  assert.equal(contextWindowFor(undefined), null);
  assert.equal(pctFree(50_000, 200_000), 75);
  assert.equal(pctFree(50_000, null), null);
});

test('card titles and question detection', () => {
  assert.equal(cardTitle('\n  Fix the session refresh race in the auth middleware please\nmore'), 'Fix the session refresh race in the aut…');
  assert.equal(cardTitle('short'), 'short');
  assert.ok(endsWithQuestion('Done.\n\nWant me to add a cache?'));
  assert.ok(endsWithQuestion('Should I proceed?**'));
  assert.ok(!endsWithQuestion('Is it fast? Yes. All done.'));
});

test('every fixture normalizes into a valid event', () => {
  const files = readdirSync(fixtures).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(fixtures, f), 'utf8'));
    const e = normalizeHook(raw, opts);
    assert.ok(e, `${f}: normalized to null`);
    const v = validateEvent(e);
    assert.ok(v.ok, `${f}: ${v.errors.join(', ')}`);
  }
});

test('normalize keeps shapes, never contents', () => {
  const e = normalizeHook(
    {
      session_id: 's',
      cwd: '/r',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_use_id: 't1',
      tool_input: { file_path: '/r/src/a.ts', old_string: 'a\nb', new_string: 'SECRET_BODY\nx\ny' },
      tool_response: { filePath: '/r/src/a.ts' },
    },
    opts,
  )!;
  assert.equal(e.tool?.detail, '+3 −2');
  assert.deepEqual(e.tool?.targets, ['/r/src/a.ts']);
  assert.ok(!JSON.stringify(e).includes('SECRET_BODY'));
});

test('normalize: needs-user signals', () => {
  const perm = normalizeHook({ session_id: 's', cwd: '', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }, opts)!;
  assert.equal(perm.needsUser?.type, 'approval');
  assert.equal(perm.needsUser?.message, 'rm -rf dist');
  const q = normalizeHook({ session_id: 's', cwd: '', hook_event_name: 'Stop', last_assistant_message: 'Done. Want me to deploy?' }, opts)!;
  assert.equal(q.needsUser?.type, 'question');
  const plain = normalizeHook({ session_id: 's', cwd: '', hook_event_name: 'Stop', last_assistant_message: 'Done.' }, opts)!;
  assert.equal(plain.needsUser, undefined);
  const idle = normalizeHook({ session_id: 's', cwd: '', hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' }, opts)!;
  assert.equal(idle.needsUser, undefined, 'idle_prompt means the lounge, not the door');
});

test('unknown hooks and missing session ids are dropped', () => {
  assert.equal(normalizeHook({ session_id: 's', hook_event_name: 'WorktreeCreate' }, opts), null);
  assert.equal(normalizeHook({ hook_event_name: 'Stop' }, opts), null);
});

test('read-only shell commands count as reading (library), anything that changes things stays shell', () => {
  for (const c of ['grep -rn "fetch(" packages/', 'rg TODO src | head -20', 'sed -n 10,30p a.ts', 'git log --oneline | head', 'find . -name "*.ts" | wc -l', 'cat package.json'])
    assert.equal(categorizeTool('Bash', { command: c }), 'read', c);
  for (const c of ['grep -l x | xargs rm', 'cat a > b', 'git push', 'npm install', 'sed -i s/a/b/ f', 'curl https://x'])
    assert.equal(categorizeTool('Bash', { command: c }), 'shell', c);
});

test('task notifications become notices, never stored as prompt text with paths', async () => {
  const { normalizeHook } = await import('../src/normalize.ts');
  const e = normalizeHook({ session_id: 's', cwd: '/r', hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>abc123</task-id>\n<output-file>/private/tmp/x/abc123.output</output-file>\n<status>killed</status>\n</task-notification>' }, { id: 'n1', ts: 1, source: 'hook' })!;
  assert.deepEqual(e.notice, { taskId: 'abc123', status: 'killed' });
  assert.ok(!JSON.stringify(e).includes('/private/tmp'), 'output path not kept');
  const stop = normalizeHook({ session_id: 's', cwd: '/r', hook_event_name: 'PostToolUse', tool_name: 'TaskStop', tool_input: { task_id: 'abc123' } }, { id: 'n2', ts: 2, source: 'hook' })!;
  assert.deepEqual(stop.tool?.targets, ['abc123']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hooks = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };

test('every hook is async and silent, and never one that changes Claude Code behaviour', () => {
  const events = Object.keys(hooks.hooks);
  assert.ok(events.length >= 15);
  // A WorktreeCreate hook replaces git's own behaviour; we must never register one (D1).
  for (const banned of ['WorktreeCreate', 'WorktreeRemove']) assert.ok(!events.includes(banned), banned);
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        assert.equal(h.type, 'command', event);
        assert.equal(h.async, true, `${event} must be async (Claude never waits)`);
        assert.match(String(h.command), /scripts\/amb-send"?$/, `${event} runs the silent sender`);
      }
    }
  }
});

test('the open command is never offered to the model and never prints the token', () => {
  const open = readFileSync(join(root, 'commands/open.md'), 'utf8');
  assert.match(open, /disable-model-invocation: true/);
  assert.doesNotMatch(open, /\?token=|sender\.headers|runtime\.json/, 'no token links or token files in the prompt');
  const opener = readFileSync(join(root, 'scripts/amb-open'), 'utf8');
  assert.doesNotMatch(opener, /\?token=/, 'opener uses one-time codes, not the token');
});

test('the repo is a marketplace whose entry is this plugin', () => {
  const market = JSON.parse(readFileSync(join(root, '../../.claude-plugin/marketplace.json'), 'utf8')) as { name: string; plugins: Array<{ name: string; source: string }> };
  const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')) as { name: string };
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0]!.name, plugin.name);
  assert.equal(market.plugins[0]!.source, './packages/plugin');
  // The CLI installs `<plugin>@<marketplace>`.
  assert.match(readFileSync(join(root, '../cli/src/cli.ts'), 'utf8'), new RegExp(`'${plugin.name}@${market.name}'`));
});

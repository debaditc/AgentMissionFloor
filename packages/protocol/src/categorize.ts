import type { Station, ToolCategory } from './index.ts';

const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const WEB = new Set(['WebSearch', 'WebFetch']);
const PLAN = new Set(['EnterPlanMode', 'ExitPlanMode', 'TodoWrite']);
const SPAWN = new Set(['Task', 'Agent']);
const TASK = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const SHELL = new Set(['Bash', 'BashOutput', 'KillShell', 'PowerShell']);

// Word-bounded so "contest" or "latest" don't count as tests.
const TEST_RE =
  /(?:^|[\s;&|(/])(?:test|tests|jest|vitest|pytest|mocha|ava|tap|phpunit|rspec|playwright|cypress|karma)(?:$|[\s;&|):])|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:go|cargo|deno|dotnet|mix|swift)\s+test\b|node\s+--test\b|\bunittest\b|\bctest\b|make\s+(?:test|check)\b|gradlew?\s+test\b|mvn\s+test\b/;

export function isTestCommand(command: string): boolean {
  return TEST_RE.test(command);
}

// Read-only inspection through the shell: these are reading/searching, not "running" anything.
// Every segment of a pipeline must be read-only (so `grep x | xargs rm` stays a shell command).
const READ_CMD = /^(?:grep|rg|ag|ack|cat|bat|head|tail|less|wc|ls|tree|find|fd|file|stat|du|jq|awk|sort|uniq|cut|tr|diff|sed\s+-n|git\s+(?:log|show|diff|status|blame|grep|ls-files))\b/;

export function isReadCommand(command: string): boolean {
  const segments = command
    .split(/\|\||&&|;|\|/)
    .map((s) => s.trim().replace(/^(?:cd\s+\S+\s*)$/, ''))
    .filter(Boolean);
  if (segments.length === 0 || /[>]|\b(?:rm|mv|cp|tee|xargs|chmod|npm|pnpm|yarn|curl|wget)\b/.test(command)) return false;
  return segments.every((s) => READ_CMD.test(s));
}

export function categorizeTool(name: string, input: Record<string, unknown> | undefined): ToolCategory {
  if (EDIT.has(name)) return 'edit';
  if (READ.has(name)) return 'read';
  if (WEB.has(name)) return 'web';
  if (PLAN.has(name)) return 'plan';
  if (SPAWN.has(name)) return 'spawn';
  if (TASK.has(name)) return 'task';
  if (SHELL.has(name)) {
    const cmd = typeof input?.command === 'string' ? input.command : '';
    if (isTestCommand(cmd)) return 'test';
    return isReadCommand(cmd) ? 'read' : 'shell';
  }
  return 'other';
}

/** §8: tool category → station. `other` keeps the actor where they are. */
export function stationForCategory(category: ToolCategory): Station | null {
  switch (category) {
    case 'edit':
      return 'desk';
    case 'read':
      return 'library';
    case 'test':
      return 'lab';
    case 'shell':
      return 'server';
    case 'web':
      return 'window';
    case 'plan':
    case 'spawn':
      return 'whiteboard';
    case 'task':
      return 'board';
    case 'other':
      return null;
  }
}

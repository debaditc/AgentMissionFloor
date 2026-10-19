// Scripted scenarios (§11 simulator). Each produces raw Claude Code hook payloads (the same
// shapes the real hooks send) plus transcript usage lines, so the whole pipeline is exercised.

import { normalizeHook, PROTOCOL_VERSION, type AmbEvent, type TaskInfo, type TeamMember } from '@agent-mission-floor/protocol';

export type Raw = Record<string, unknown>;

export interface Step {
  /** Milliseconds from scenario start. */
  at: number;
  payload?: Raw;
  /** Append an assistant usage record to this session's transcript before posting. */
  usage?: { session: string; used: number; model: string };
}

export interface Scenario {
  name: string;
  description: string;
  steps: Step[];
}

export interface BuildOptions {
  /** Prefix that keeps session ids unique per run. */
  runId: string;
  transcriptDir: string;
}

class Script {
  steps: Step[] = [];
  t = 0;
  opts: BuildOptions;
  constructor(opts: BuildOptions) {
    this.opts = opts;
  }
  wait(ms: number) {
    this.t += ms;
    return this;
  }
  push(payload: Raw) {
    this.steps.push({ at: this.t, payload });
  }
  session(label: string, opts: { cwd?: string; model?: string } = {}) {
    // Real session ids are UUIDs; the first 8 chars name a lead's team, so they must be unique per session.
    const unique = hashHex(`${this.opts.runId}/${label}`);
    return new Sim(this, `${unique}-${this.opts.runId}-${label}`, opts.cwd ?? `/work/${label}`, opts.model ?? 'claude-sonnet-5-5');
  }
}

let toolSeq = 0;

function hashHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

class Sim {
  used = 18_000;
  script: Script;
  sessionId: string;
  cwd: string;
  model: string;
  agent: { id: string; type: string } | undefined;
  constructor(script: Script, sessionId: string, cwd: string, model: string, agent?: { id: string; type: string }) {
    this.script = script;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.model = model;
    this.agent = agent;
  }

  private base(hook: string, extra: Raw = {}): Raw {
    const p: Raw = {
      session_id: this.sessionId,
      transcript_path: `${this.script.opts.transcriptDir}/${this.sessionId}.jsonl`,
      cwd: this.cwd,
      hook_event_name: hook,
      ...extra,
    };
    if (this.agent) {
      p.agent_id = this.agent.id;
      p.agent_type = this.agent.type;
    }
    return p;
  }

  private emit(hook: string, extra: Raw = {}) {
    this.script.push(this.base(hook, extra));
  }

  private grow(tokens: number) {
    if (this.agent) return;
    this.used += tokens;
    this.script.steps.push({ at: this.script.t, usage: { session: this.sessionId, used: this.used, model: this.model } });
  }

  start() {
    this.emit('SessionStart', { source: 'startup', model: this.model });
    this.grow(0);
    return this;
  }

  prompt(text: string) {
    this.emit('UserPromptSubmit', { prompt: text });
    this.script.wait(900);
    return this;
  }

  tool(name: string, input: Raw, opts: { ms?: number; error?: string; response?: Raw; permissionWait?: number; tokens?: number } = {}) {
    const id = `toolu_sim_${++toolSeq}`;
    this.emit('PreToolUse', { tool_name: name, tool_input: input, tool_use_id: id });
    if (opts.permissionWait) {
      this.script.wait(150);
      this.emit('PermissionRequest', { tool_name: name, tool_input: input });
      this.script.wait(150);
      this.emit('Notification', { message: `Claude needs your permission to use ${name}`, notification_type: 'permission_prompt' });
      this.script.wait(opts.permissionWait);
    }
    this.script.wait(opts.ms ?? 1200);
    if (opts.error) {
      this.emit('PostToolUseFailure', { tool_name: name, tool_input: input, tool_use_id: id, error: opts.error, duration_ms: opts.ms ?? 1200 });
    } else {
      this.emit('PostToolUse', { tool_name: name, tool_input: input, tool_use_id: id, tool_response: opts.response ?? {}, duration_ms: opts.ms ?? 1200 });
    }
    this.grow(opts.tokens ?? 2_500);
    this.script.wait(400);
    return this;
  }

  read(file: string) {
    return this.tool('Read', { file_path: `${this.cwd}/${file}` }, { ms: 700 });
  }
  grep(pattern: string) {
    return this.tool('Grep', { pattern, path: this.cwd }, { ms: 600 });
  }
  edit(file: string, add: number, remove: number) {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
    return this.tool('Edit', { file_path: `${this.cwd}/${file}`, old_string: lines(remove), new_string: lines(add) }, { ms: 1500, tokens: 4_000 });
  }
  bash(command: string, opts: { ms?: number; error?: string; stdout?: string; permissionWait?: number } = {}) {
    const toolOpts: Parameters<Sim['tool']>[2] = { ms: opts.ms ?? 1800, response: { stdout: opts.stdout ?? '', stderr: '', interrupted: false } };
    if (opts.error) toolOpts.error = opts.error;
    if (opts.permissionWait) toolOpts.permissionWait = opts.permissionWait;
    return this.tool('Bash', { command, description: command }, toolOpts);
  }
  web(url: string) {
    return this.tool('WebFetch', { url, prompt: 'summarize' }, { ms: 2200 });
  }

  stop(message: string) {
    this.emit('Stop', { stop_hook_active: false, last_assistant_message: message, background_tasks: [], session_crons: [] });
    return this;
  }

  compact() {
    this.emit('PreCompact', { trigger: 'auto', custom_instructions: null });
    this.script.wait(2500);
    this.emit('PostCompact', { trigger: 'auto', compact_summary: 'Summary of the compacted conversation.' });
    this.used = 30_000;
    this.grow(0);
    this.script.wait(500);
    return this;
  }

  end(reason = 'prompt_input_exit') {
    this.emit('SessionEnd', { reason });
    return this;
  }

  /** A subagent (intern) run in this session's context. */
  intern(agentId: string, type: string, work: (s: Sim) => void, finalMessage = 'Done.') {
    const spawnId = `toolu_sim_${++toolSeq}`;
    this.emit('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: type, description: `${type} research`, prompt: '…' }, tool_use_id: spawnId });
    this.script.wait(200);
    this.emit('SubagentStart', { agent_id: agentId, agent_type: type });
    const sub = new Sim(this.script, this.sessionId, this.cwd, this.model, { id: agentId, type });
    this.script.wait(300);
    work(sub);
    this.emit('SubagentStop', {
      stop_hook_active: false,
      agent_id: agentId,
      agent_type: type,
      agent_transcript_path: `${this.script.opts.transcriptDir}/${this.sessionId}/subagents/agent-${agentId}.jsonl`,
      last_assistant_message: finalMessage,
    });
    this.script.wait(200);
    this.emit('PostToolUse', { tool_name: 'Agent', tool_input: { subagent_type: type }, tool_use_id: spawnId, tool_response: {}, duration_ms: 3000 });
    this.grow(6_000);
    return this;
  }

  /** Same session, acting as a named teammate (agent_id). */
  as(agentId: string, type = 'general-purpose') {
    return new Sim(this.script, this.sessionId, this.cwd, this.model, { id: agentId, type });
  }

  taskEvent(hook: 'TaskCreated' | 'TaskCompleted', id: string, subject: string, teammate?: string) {
    const extra: Raw = { task_id: id, task_subject: subject };
    if (teammate) extra.teammate_name = teammate;
    this.emit(hook, extra);
    return this;
  }

  idle(teammate: string, team: string) {
    this.emit('TeammateIdle', { teammate_name: teammate, team_name: team });
    return this;
  }
}

/** Simulator-only payload: stands in for the team config file the watcher would read. */
function teamSnapshot(script: Script, team: string, members: Array<{ name: string; agentId: string; agentType?: string; sessionId?: string }>) {
  script.push({ amb_simulator: 'team', team_name: team, members });
}

function taskSnapshot(script: Script, team: string, tasks: Array<{ id: string; subject: string; status: string; owner?: string; blockedBy?: string[] }>) {
  script.push({ amb_simulator: 'tasks', team_name: team, tasks });
}

function teamScenario(opts: BuildOptions): Scenario {
  const s = new Script(opts);
  const lead = s.session('lead', { cwd: '/work/billing', model: 'claude-opus-5-5' }).start();
  const team = `session-${lead.sessionId.slice(0, 8)}`;
  s.wait(800);
  lead.prompt('Ship the billing settings page: plan, API, UI, tests and docs');
  lead.read('docs/billing.md').grep('BillingSettings');

  const tasks = [
    { id: '1', subject: 'Design billing settings API schema' },
    { id: '2', subject: 'Implement settings endpoint', blockedBy: ['1'] },
    { id: '3', subject: 'Build settings form UI' },
    { id: '4', subject: 'Write endpoint tests', blockedBy: ['2'] },
    { id: '5', subject: 'Update billing docs' },
  ];
  const members = [
    { name: 'emma', agentId: `a-emma-${opts.runId}` },
    { name: 'james', agentId: `a-james-${opts.runId}` },
    { name: 'olivia', agentId: `a-olivia-${opts.runId}` },
    { name: 'harry', agentId: `a-harry-${opts.runId}` },
  ];
  teamSnapshot(s, team, [{ name: 'team-lead', agentId: 'lead', agentType: 'team-lead', sessionId: lead.sessionId }, ...members.map((m) => ({ ...m, agentType: 'general-purpose' }))]);
  for (const t of tasks) {
    lead.tool('TaskCreate', { subject: t.subject }, { ms: 300, tokens: 600 });
    lead.taskEvent('TaskCreated', t.id, t.subject);
    s.wait(300);
  }
  const snapshot = (status: Record<string, [string, string?]>) =>
    taskSnapshot(
      s,
      team,
      tasks.map((t) => ({ ...t, status: status[t.id]?.[0] ?? 'pending', ...(status[t.id]?.[1] ? { owner: status[t.id]![1] } : {}) })),
    );
  snapshot({});
  lead.stop('Team is on it. I split the work into 5 tasks.');

  const juno = lead.as(`a-emma-${opts.runId}`);
  const rex = lead.as(`a-james-${opts.runId}`);
  const mira = lead.as(`a-olivia-${opts.runId}`);
  const kit = lead.as(`a-harry-${opts.runId}`);
  const claim = (who: Sim, name: string, id: string) => who.tool('TaskUpdate', { taskId: id, status: 'in_progress', owner: name }, { ms: 250, tokens: 300 });
  const done = (who: Sim, name: string, id: string) => {
    who.tool('TaskUpdate', { taskId: id, status: 'completed' }, { ms: 250, tokens: 300 });
    who.taskEvent('TaskCompleted', id, tasks.find((t) => t.id === id)!.subject, name);
  };

  claim(juno, 'emma', '1');
  claim(mira, 'olivia', '3');
  claim(kit, 'harry', '5');
  snapshot({ 1: ['in_progress', 'emma'], 3: ['in_progress', 'olivia'], 5: ['in_progress', 'harry'] });
  rex.idle('james', team); // everything else is blocked
  juno.read('src/billing/types.ts').web('https://docs.stripe.com/api/customers').edit('src/billing/schema.ts', 48, 6);
  mira.read('src/ui/Settings.tsx').edit('src/ui/BillingForm.tsx', 120, 0);
  kit.read('docs/billing.md').edit('docs/billing.md', 34, 12);
  done(juno, 'emma', '1');
  claim(rex, 'james', '2');
  snapshot({ 1: ['completed', 'emma'], 2: ['in_progress', 'james'], 3: ['in_progress', 'olivia'], 5: ['in_progress', 'harry'] });
  juno.idle('emma', team);
  rex.read('src/billing/schema.ts').edit('src/api/settings.ts', 86, 14).bash('pnpm tsc --noEmit', { stdout: 'ok' });
  done(kit, 'harry', '5');
  kit.idle('harry', team);
  mira.bash('pnpm build', { stdout: 'built in 4.2s' });
  done(mira, 'olivia', '3');
  mira.idle('olivia', team);
  done(rex, 'james', '2');
  claim(juno, 'emma', '4');
  rex.idle('james', team);
  juno.edit('test/settings.test.ts', 64, 0).bash('pnpm vitest run test/settings.test.ts', { error: 'Exit code 1\n1 failing: rejects negative limits' });
  juno.edit('src/api/settings.ts', 3, 1).bash('pnpm vitest run test/settings.test.ts', { stdout: '12 passed' });
  done(juno, 'emma', '4');
  snapshot({ 1: ['completed', 'emma'], 2: ['completed', 'james'], 3: ['completed', 'olivia'], 4: ['completed', 'emma'], 5: ['completed', 'harry'] });
  juno.idle('emma', team);
  s.wait(600);
  lead.prompt('Wrap up and summarize');
  lead.stop('Mission complete: billing settings page shipped with API, UI, 12 passing tests and updated docs.');
  return { name: 'team', description: 'Team of 5 with dependencies', steps: s.steps };
}

function soloScenario(opts: BuildOptions): Scenario {
  const s = new Script(opts);
  const a = s.session('web-app').start();
  const b = s.session('cli-tool', { model: 'claude-haiku-5-5' }).start();
  const c = s.session('infra', { model: 'claude-opus-4-6' }).start();
  s.wait(500);
  a.prompt('Fix the session refresh race in auth middleware');
  b.prompt('Add a --json flag to the export command');
  a.grep('refreshSession').read('src/auth/session.ts');
  c.prompt('Why is the staging deploy slow?');
  b.read('src/commands/export.ts').edit('src/commands/export.ts', 22, 4);
  c.bash('kubectl get pods -n staging', { stdout: '12 pods' }).web('https://kubernetes.io/docs/concepts/workloads/');
  a.intern('ag-1', 'Explore', (sub) => sub.grep('tokenExpiry').read('src/auth/token.ts'), 'Found the race in token.ts:88');
  a.edit('src/auth/session.ts', 42, 9).bash('pnpm test auth', { stdout: '31 passed' });
  b.bash('node --test test/export.test.ts', { stdout: 'pass 6' });
  b.stop('Added --json. Tests pass.');
  a.stop('Fixed the refresh race; 31 tests pass.');
  c.read('deploy/staging.yaml');
  c.stop('The image pull is uncached. Want me to add a pull-through cache to the staging cluster?');
  return { name: 'solo', description: 'Three independent sessions, one with an intern', steps: s.steps };
}

function permissionScenario(opts: BuildOptions): Scenario {
  const s = new Script(opts);
  const a = s.session('cleanup').start();
  s.wait(400);
  a.prompt('Clean the build output and rebuild');
  a.read('package.json');
  a.bash('rm -rf dist node_modules/.cache', { permissionWait: 8000, ms: 800 });
  a.bash('pnpm build', { stdout: 'built' });
  a.stop('Cleaned and rebuilt.');
  return { name: 'permission', description: 'A session waits at your door for approval', steps: s.steps };
}

function compactionScenario(opts: BuildOptions): Scenario {
  const s = new Script(opts);
  const a = s.session('big-refactor', { model: 'claude-opus-4-6' }).start();
  s.wait(400);
  a.prompt('Refactor the event pipeline to use streams');
  for (let i = 0; i < 6; i++) a.read(`src/pipeline/stage${i}.ts`).edit(`src/pipeline/stage${i}.ts`, 30, 20);
  a.used = 168_000;
  a.tool('Read', { file_path: `${a.cwd}/src/pipeline/index.ts` }, { tokens: 4_000 });
  a.compact();
  a.edit('src/pipeline/index.ts', 18, 40).stop('Pipeline now streams end to end.');
  return { name: 'compaction', description: 'Memory fills up; a trip to the Archive', steps: s.steps };
}

function conflictScenario(opts: BuildOptions): Scenario {
  const s = new Script(opts);
  const a = s.session('feature-a', { cwd: '/work/shop' }).start();
  const b = s.session('feature-b', { cwd: '/work/shop' }).start();
  s.wait(300);
  a.prompt('Add coupon support to checkout');
  b.prompt('Add gift cards to checkout');
  a.read('src/checkout/total.ts');
  b.read('src/checkout/total.ts');
  a.edit('src/checkout/total.ts', 24, 3);
  b.edit('src/checkout/total.ts', 31, 5);
  a.stop('Coupons added.');
  b.stop('Gift cards added.');
  return { name: 'conflict', description: 'Two sessions edit the same file within seconds', steps: s.steps };
}

function flakyScenario(opts: BuildOptions): Scenario {
  const s = new Script(opts);
  const a = s.session('payments').start();
  s.wait(400);
  a.prompt('Make the webhook retry test stable');
  a.bash('pnpm vitest run webhook', { error: 'Exit code 1\n2 failing · run 1 of 3' });
  a.read('test/webhook.test.ts');
  a.bash('pnpm vitest run webhook', { error: 'Exit code 1\n2 failing · run 2 of 3' });
  a.edit('test/webhook.test.ts', 6, 2);
  a.bash('pnpm vitest run webhook', { stdout: '14 passed · run 3 of 3' });
  a.stop('Fixed the timer leak; the test is stable over 3 runs.');
  return { name: 'flaky', description: 'A flaky test fails twice, then passes', steps: s.steps };
}

export const SCENARIOS: Record<string, (opts: BuildOptions) => Scenario> = {
  team: teamScenario,
  solo: soloScenario,
  permission: permissionScenario,
  compaction: compactionScenario,
  conflict: conflictScenario,
  flaky: flakyScenario,
};

export function buildScenario(name: string, opts: BuildOptions): Scenario {
  const make = SCENARIOS[name];
  if (!make) throw new Error(`unknown scenario "${name}" (have: ${Object.keys(SCENARIOS).join(', ')})`);
  toolSeq = 0;
  const sc = make(opts);
  sc.steps.sort((x, y) => x.at - y.at);
  return sc;
}

/** One assistant transcript line with the given context usage (same shape Claude Code writes). */
export function usageLine(used: number, model: string, ts: number): string {
  const cacheRead = Math.floor(used * 0.8);
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(ts).toISOString(),
    message: { model, role: 'assistant', usage: { input_tokens: 2, cache_creation_input_tokens: used - cacheRead - 2 - 200, cache_read_input_tokens: cacheRead, output_tokens: 200 } },
  });
}

/**
 * Converts a scenario into normalized events without a collector (for reducer tests and
 * offline replay). Timestamps are scenario offsets from `startTs`.
 */
export function scenarioEvents(sc: Scenario, startTs = 1_760_000_000_000): AmbEvent[] {
  const out: AmbEvent[] = [];
  let n = 0;
  for (const step of sc.steps) {
    const p = step.payload;
    if (!p) continue;
    const ts = startTs + step.at;
    const id = `${sc.name}-${++n}`;
    if (typeof p.amb_simulator === 'string') {
      const base = { id, ts, protocolVersion: PROTOCOL_VERSION, source: 'simulator' as const, sessionId: String(p.team_name), cwd: '', teamName: String(p.team_name) };
      if (p.amb_simulator === 'team') out.push({ ...base, kind: 'team.snapshot', members: p.members as TeamMember[] });
      else out.push({ ...base, kind: 'task.snapshot', tasks: (p.tasks as TaskInfo[]).map((t) => ({ ...t })) });
      continue;
    }
    const e = normalizeHook(p, { id, ts, source: 'simulator' });
    if (e) out.push(e);
  }
  return out;
}

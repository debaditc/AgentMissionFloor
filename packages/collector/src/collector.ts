// Ingest pipeline: raw hook payload → normalize → redact → persist → world → broadcast.

import { randomUUID } from 'node:crypto';
import { normalizeHook, PROTOCOL_VERSION, validateEvent, type AmbEvent, type EventSource } from '@agent-mission-floor/protocol';
import { actorKey, describeTool, emptyWorld, reduce, type WorldState } from '@agent-mission-floor/world';
import { isSecretPath, redactString, redactValue } from './redact.ts';
import { RETENTION_MS, type Store } from './store.ts';
import { ConflictDetector } from './conflicts.ts';
import { readFile } from 'node:fs/promises';
import { agentMetaPath, agentTranscriptPath, readUsage, safeTranscriptPath, UsageLedger, type UsageReading, type UsageTotals } from './transcript.ts';
import type { TaskSnapshot, TeamSnapshot } from './watcher.ts';

export interface CollectorOptions {
  store: Store;
  now?: () => number;
  /** Called for every accepted event, after the world has been updated. */
  onEvent?: (e: AmbEvent, world: WorldState) => void;
  /** Delay before re-reading a transcript after activity (coalesces bursts). */
  usageDebounceMs?: number;
  readUsage?: (path: string, includeSidechain?: boolean) => Promise<UsageReading | null>;
}

export interface ActorSummary {
  key: string;
  name: string;
  role: string;
  status: string;
  sessionId: string;
  agentId?: string;
  agentType?: string;
  parent?: { key: string; name: string };
  model?: string;
  models: string[];
  assignment?: string;
  assignmentDone?: boolean;
  activity: string;
  startedTs: number;
  lastTs: number;
  context: { used: number; max: number | null; pctFree: number | null } | null;
  tokens: UsageTotals | null;
  /** Lead only: everyone in the session (lead + teammates + interns). */
  teamTokens?: UsageTotals | null;
  files: Array<{ path: string; reads: number; edits: number; added: number; removed: number; lastTs: number }>;
  moves: Array<{ ts: number; tool: string; text: string; ok: boolean; error?: string }>;
  mix: Record<string, number>;
  toolCalls: number;
  errors: number;
  crew: Array<{ key: string; name: string; role: string; assignment?: string; done?: boolean }>;
  /** Latest shell output (redacted, ≤ 600 chars) for the close-up terminal card. */
  lastOutput?: { ts: number; command: string; text: string; ok: boolean };
}

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    messages: a.messages + b.messages,
    models: [...new Set([...a.models, ...b.models])],
  };
}

const SECRET_PATH_IN_TEXT = /(?:^|[\s'"=/])\.env(?:\.[A-Za-z0-9_-]+)?(?:$|[\s'"])|id_(?:rsa|ed25519|ecdsa)|\.pem\b|\.ssh\//;

/** Redacts every free-text field. Drops command output that may have read a secret file. */
export function redactEvent(e: AmbEvent): AmbEvent {
  const out: AmbEvent = { ...e };
  if (out.summary) out.summary = redactString(out.summary);
  if (out.tool) {
    out.tool = { ...out.tool, targets: out.tool.targets.map((t) => redactString(t)) };
    if (out.tool.detail) out.tool.detail = redactString(out.tool.detail);
    if (out.tool.taskPatch) out.tool.taskPatch = redactValue(out.tool.taskPatch);
  }
  if (out.outcome) {
    out.outcome = { ...out.outcome };
    const touchesSecret =
      (out.tool?.targets.some(isSecretPath) ?? false) || (out.tool?.detail ? SECRET_PATH_IN_TEXT.test(out.tool.detail) : false);
    if (out.outcome.output) out.outcome.output = touchesSecret ? '[output hidden: secret file]' : redactString(out.outcome.output);
    if (out.outcome.error) out.outcome.error = touchesSecret ? '[error hidden: secret file]' : redactString(out.outcome.error);
  }
  if (out.needsUser?.message) out.needsUser = { ...out.needsUser, message: redactString(out.needsUser.message) };
  if (out.task) out.task = redactValue(out.task);
  if (out.tasks) out.tasks = redactValue(out.tasks);
  if (out.meta) out.meta = redactValue(out.meta);
  return out;
}

export class Collector {
  world: WorldState = emptyWorld();
  private store: Store;
  private now: () => number;
  private onEvent: CollectorOptions['onEvent'];
  private usageDebounceMs: number;
  private readUsageFn: (path: string, includeSidechain?: boolean) => Promise<UsageReading | null>;
  private ledger = new UsageLedger();
  private metaSeen = new Map<string, string>();
  private conflicts = new ConflictDetector();
  private usageTimers = new Map<string, NodeJS.Timeout>();
  private lastUsage = new Map<string, number>();
  /** Last emitted event ts; keeps the stream monotonic when clocks disagree by a few ms. */
  private lastTs = 0;

  constructor(opts: CollectorOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
    this.usageDebounceMs = opts.usageDebounceMs ?? 400;
    this.readUsageFn = opts.readUsage ?? readUsage;
  }

  /** Rebuilds world state from the store (restart / replay). */
  rebuild(): number {
    const events = this.store.since(this.now() - RETENTION_MS);
    let w = emptyWorld();
    for (const e of events) w = reduce(w, e);
    this.world = w;
    this.lastTs = w.lastTs;
    for (const a of Object.values(w.actors)) if (a.memory) this.lastUsage.set(a.key, a.memory.used);
    return events.length;
  }

  ingestHook(raw: Record<string, unknown>, opts: { ts?: number; id?: string; source?: EventSource } = {}): AmbEvent | null {
    const ts = opts.ts && Number.isFinite(opts.ts) ? opts.ts : this.now();
    const e = normalizeHook(raw, { id: opts.id ?? randomUUID(), ts, source: opts.source ?? 'hook' });
    if (!e) return null;
    return this.accept(e);
  }

  ingestTeam(snap: TeamSnapshot): AmbEvent | null {
    return this.accept({
      ...this.base('team.snapshot', snap.leadSessionId ?? snap.teamName),
      teamName: snap.teamName,
      members: snap.members,
    });
  }

  ingestTasks(snap: TaskSnapshot): AmbEvent | null {
    return this.accept({ ...this.base('task.snapshot', snap.teamName), teamName: snap.teamName, tasks: snap.tasks });
  }

  private base(kind: AmbEvent['kind'], sessionId: string): AmbEvent {
    return { id: randomUUID(), ts: this.now(), protocolVersion: PROTOCOL_VERSION, source: 'watcher', sessionId, cwd: '', kind };
  }

  /** Validates, redacts, stores, reduces and emits. Returns null for invalid or duplicate events. */
  accept(input: AmbEvent): AmbEvent | null {
    const e = redactEvent(input);
    if (!validateEvent(e).ok) return null;
    if (!this.store.insert(e)) return null;
    this.world = reduce(this.world, e);
    this.lastTs = Math.max(this.lastTs, e.ts);
    this.onEvent?.(e, this.world);
    const clash = e.source === 'spool' || e.source === 'hook' || e.source === 'simulator' ? this.conflicts.check(e) : null;
    if (clash) {
      this.accept({
        id: randomUUID(),
        ts: e.ts,
        protocolVersion: PROTOCOL_VERSION,
        source: 'watcher',
        sessionId: e.sessionId,
        ...(e.agentId ? { agentId: e.agentId } : {}),
        cwd: e.cwd,
        kind: 'conflict',
        conflict: clash,
      });
    }
    if (e.source !== 'transcript' && e.transcriptPath) this.scheduleUsage(actorKey(e), e);
    if (e.agentId && e.transcriptPath && (e.kind === 'subagent.start' || e.kind === 'subagent.stop' || e.kind === 'teammate.idle')) {
      void this.readAgentMeta(e.sessionId, e.agentId, e.transcriptPath, e.cwd);
    }
    return e;
  }

  /** The transcript holding this actor's own messages (teammates and interns have their own file). */
  private transcriptFor(e: Pick<AmbEvent, 'sessionId' | 'agentId' | 'transcriptPath' | 'agentTranscriptPath'>): string | undefined {
    if (!e.transcriptPath) return undefined;
    if (!e.agentId) return safeTranscriptPath(e.transcriptPath) ?? undefined;
    return safeTranscriptPath(e.agentTranscriptPath) ?? agentTranscriptPath(e.transcriptPath, e.sessionId, e.agentId) ?? undefined;
  }

  private scheduleUsage(key: string, e: AmbEvent) {
    const path = this.transcriptFor(e);
    if (!path) return;
    clearTimeout(this.usageTimers.get(key));
    const t = setTimeout(() => {
      this.usageTimers.delete(key);
      void this.refreshUsage(key, e.sessionId, path, e.cwd, e.agentId);
    }, this.usageDebounceMs);
    t.unref();
    this.usageTimers.set(key, t);
  }

  /**
   * Claude Code's per-agent metadata (`subagents/agent-<id>.meta.json`): assignment, name, model,
   * and whether it's an agent-team teammate. Read-only, every field optional (DECISIONS D16).
   */
  async readAgentMeta(sessionId: string, agentId: string, transcriptPath: string, cwd: string): Promise<AmbEvent | null> {
    const path = agentMetaPath(transcriptPath, sessionId, agentId);
    if (!path) return null;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v.slice(0, 200) : undefined);
    const meta: NonNullable<AmbEvent['meta']> = {};
    const fields: Array<[keyof typeof meta, unknown]> = [
      ['description', raw.description],
      ['name', raw.name],
      ['model', raw.model],
      ['taskKind', raw.taskKind],
      ['teamName', raw.teamName],
    ];
    for (const [k, v] of fields) {
      const s = str(v);
      if (s) meta[k] = s;
    }
    if (Object.keys(meta).length === 0) return null;
    const key = `${sessionId}:${agentId}`;
    const sig = JSON.stringify(meta);
    if (this.metaSeen.get(key) === sig) return null;
    this.metaSeen.set(key, sig);
    return this.accept({ id: randomUUID(), ts: Math.max(this.now(), this.lastTs), protocolVersion: PROTOCOL_VERSION, source: 'transcript', sessionId, agentId, cwd, kind: 'agent.meta', meta });
  }

  async refreshUsage(key: string, sessionId: string, path: string, cwd: string, agentId?: string): Promise<AmbEvent | null> {
    const usage = await this.readUsageFn(path, !!agentId);
    if (!usage || this.lastUsage.get(key) === usage.used) return null;
    this.lastUsage.set(key, usage.used);
    const context: NonNullable<AmbEvent['context']> = { used: usage.used, max: usage.max, pctFree: usage.pctFree };
    if (usage.model) context.model = usage.model;
    return this.accept({
      id: randomUUID(),
      ts: Math.max(this.now(), this.lastTs),
      protocolVersion: PROTOCOL_VERSION,
      source: 'transcript',
      sessionId,
      ...(agentId ? { agentId } : {}),
      cwd,
      kind: 'context',
      context,
    });
  }

  /** On restart, re-read every live session's transcript so memory meters are current. */
  async backfillUsage(): Promise<number> {
    let n = 0;
    for (const a of Object.values(this.world.actors)) {
      if (a.status === 'gone') continue;
      const path = this.actorTranscript(a.key);
      if (path && (await this.refreshUsage(a.key, a.sessionId, path, a.cwd, a.agentId))) n++;
      const main = this.world.actors[a.sessionId]?.transcriptPath;
      if (a.agentId && main) await this.readAgentMeta(a.sessionId, a.agentId, main, a.cwd);
    }
    return n;
  }

  private actorTranscript(key: string): string | undefined {
    const a = this.world.actors[key];
    if (!a) return undefined;
    const main = a.agentId ? this.world.actors[a.sessionId]?.transcriptPath : a.transcriptPath;
    return main ? this.transcriptFor({ sessionId: a.sessionId, agentId: a.agentId, transcriptPath: main }) : undefined;
  }

  /** Drill-down for one person: identity, consumption, files touched, last moves (spec §10.3). */
  async actorSummary(key: string): Promise<ActorSummary | null> {
    const a = this.world.actors[key];
    if (!a) return null;
    const own = this.store.session(a.sessionId, 20000).filter((e) => actorKey(e) === key);
    const files = new Map<string, ActorSummary['files'][number]>();
    const mix: Record<string, number> = {};
    const moves: ActorSummary['moves'] = [];
    let lastOutput: ActorSummary['lastOutput'];
    for (const e of own) {
      if ((e.kind === 'tool.post' || e.kind === 'tool.fail') && e.tool && (e.outcome?.output || e.outcome?.error) && (e.tool.category === 'test' || e.tool.category === 'shell')) {
        lastOutput = { ts: e.ts, command: e.tool.detail ?? e.tool.name, text: (e.outcome.output ?? e.outcome.error)!, ok: e.kind === 'tool.post' };
      }
      if ((e.kind !== 'tool.post' && e.kind !== 'tool.fail') || !e.tool) continue;
      const t = e.tool;
      mix[t.category] = (mix[t.category] ?? 0) + 1;
      moves.push({ ts: e.ts, tool: t.name, text: describeTool(t), ok: e.kind === 'tool.post', ...(e.outcome?.error ? { error: e.outcome.error.split('\n')[0]!.slice(0, 120) } : {}) });
      const path = t.targets[0];
      if (path && (t.category === 'edit' || t.category === 'read') && (path.startsWith('/') || path.includes('.'))) {
        const f = files.get(path) ?? { path, reads: 0, edits: 0, added: 0, removed: 0, lastTs: 0 };
        if (t.category === 'edit') {
          f.edits++;
          f.added += t.added ?? 0;
          f.removed += t.removed ?? 0;
        } else f.reads++;
        f.lastTs = e.ts;
        files.set(path, f);
      }
    }
    const path = this.actorTranscript(key);
    const tokens = path ? await this.ledger.totals(path, !!a.agentId) : null;
    let teamTokens: UsageTotals | null | undefined;
    const crew = Object.values(this.world.actors).filter((x) => x.parentKey === key);
    if (!a.agentId && crew.length) {
      teamTokens = tokens;
      for (const c of crew) {
        const p = this.actorTranscript(c.key);
        const t = p ? await this.ledger.totals(p, true) : null;
        if (t) teamTokens = teamTokens ? addTotals(teamTokens, t) : t;
      }
    }
    const parent = a.parentKey ? this.world.actors[a.parentKey] : undefined;
    return {
      key,
      name: a.name,
      role: a.role,
      status: a.status,
      sessionId: a.sessionId,
      ...(a.agentId ? { agentId: a.agentId } : {}),
      ...(a.agentType ? { agentType: a.agentType } : {}),
      ...(parent ? { parent: { key: parent.key, name: parent.name } } : {}),
      ...(a.model ?? tokens?.models.at(-1) ? { model: a.model ?? tokens?.models.at(-1) } : {}),
      models: tokens?.models ?? (a.model ? [a.model] : []),
      ...(a.assignment ? { assignment: a.assignment } : {}),
      ...(a.assignmentDone !== undefined ? { assignmentDone: a.assignmentDone } : {}),
      activity: a.activity,
      startedTs: a.startedTs,
      lastTs: a.lastTs,
      context: a.memory,
      tokens,
      ...(teamTokens !== undefined ? { teamTokens } : {}),
      files: [...files.values()].sort((x, y) => y.lastTs - x.lastTs).slice(0, 40),
      moves: moves.slice(-60).reverse(),
      mix,
      toolCalls: a.toolCalls,
      errors: a.errors,
      ...(lastOutput ? { lastOutput } : {}),
      crew: crew.map((c) => ({ key: c.key, name: c.name, role: c.role, ...(c.assignment ? { assignment: c.assignment } : {}), ...(c.assignmentDone !== undefined ? { done: c.assignmentDone } : {}) })),
    };
  }

  dispose() {
    for (const t of this.usageTimers.values()) clearTimeout(t);
    this.usageTimers.clear();
  }
}

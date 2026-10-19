// Read-only team/task watcher (§4.2). The on-disk format is internal to Claude Code, so
// every field is optional, unknown shapes are skipped, and nothing here ever writes.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setting, type TaskInfo, type TaskStatus, type TeamMember } from '@agent-mission-floor/protocol';

type Raw = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

export interface TeamSnapshot {
  teamName: string;
  members: TeamMember[];
  leadSessionId?: string;
}

export interface TaskSnapshot {
  teamName: string;
  tasks: TaskInfo[];
}

export function claudeDir(): string {
  return setting('CLAUDE_DIR') ?? join(homedir(), '.claude');
}

export function parseTeamConfig(teamName: string, json: unknown): TeamSnapshot | null {
  if (typeof json !== 'object' || json === null) return null;
  const raw = json as Raw;
  const list = Array.isArray(raw.members) ? raw.members : null;
  if (!list) return null;
  const members: TeamMember[] = [];
  for (const m of list) {
    if (typeof m !== 'object' || m === null) continue;
    const r = m as Raw;
    const name = s(r.name);
    if (!name) continue;
    const member: TeamMember = { name };
    const agentId = s(r.agentId) ?? s(r.agent_id) ?? s(r.id);
    const agentType = s(r.agentType) ?? s(r.agent_type) ?? s(r.type);
    const sessionId = s(r.sessionId) ?? s(r.session_id);
    if (agentId) member.agentId = agentId;
    if (agentType) member.agentType = agentType;
    if (sessionId) member.sessionId = sessionId;
    members.push(member);
  }
  const snap: TeamSnapshot = { teamName, members };
  const lead = members.find((m) => m.agentType === 'team-lead');
  const leadSessionId = lead?.sessionId ?? s(raw.leadSessionId) ?? s(raw.lead_session_id);
  if (leadSessionId) snap.leadSessionId = leadSessionId;
  return snap;
}

function normStatus(v: unknown): TaskStatus | undefined {
  const t = s(v)?.toLowerCase().replace(/[\s-]/g, '_');
  if (t === 'pending' || t === 'todo' || t === 'open') return 'pending';
  if (t === 'in_progress' || t === 'doing' || t === 'active') return 'in_progress';
  if (t === 'completed' || t === 'done' || t === 'complete') return 'completed';
  return undefined;
}

export function parseTask(json: unknown, fallbackId?: string): TaskInfo | null {
  if (typeof json !== 'object' || json === null) return null;
  const r = json as Raw;
  const id = s(r.id) ?? (typeof r.id === 'number' ? String(r.id) : undefined) ?? s(r.taskId) ?? fallbackId;
  if (!id) return null;
  const task: TaskInfo = { id };
  const subject = s(r.subject) ?? s(r.title) ?? s(r.content);
  if (subject) task.subject = subject.slice(0, 200);
  const status = normStatus(r.status);
  if (status) task.status = status;
  const owner = s(r.owner) ?? s(r.assignee) ?? s(r.claimedBy);
  if (owner) task.owner = owner;
  const blocked = Array.isArray(r.blockedBy) ? r.blockedBy : Array.isArray(r.blocked_by) ? r.blocked_by : null;
  if (blocked) task.blockedBy = blocked.map((b) => String(b));
  return task;
}

/** Accepts one-task-per-file, an array file, or `{ tasks: [...] }`. */
export function parseTaskFile(json: unknown, fileId: string): TaskInfo[] {
  if (Array.isArray(json)) return json.map((t) => parseTask(t)).filter((t): t is TaskInfo => t !== null);
  if (json && typeof json === 'object' && Array.isArray((json as Raw).tasks)) return parseTaskFile((json as Raw).tasks, fileId);
  const one = parseTask(json, fileId);
  return one ? [one] : [];
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

export interface WatcherCallbacks {
  onTeam(snap: TeamSnapshot): void;
  onTasks(snap: TaskSnapshot): void;
  onWarning?(message: string): void;
}

/**
 * Polls ~/.claude/teams and ~/.claude/tasks. Polling (not fs.watch) because the dirs come and
 * go with sessions and fs.watch semantics differ between macOS and Linux. Emits only on change.
 */
export class TeamWatcher {
  private timer: NodeJS.Timeout | undefined;
  private lastTeam = new Map<string, string>();
  private lastTasks = new Map<string, string>();
  private warned = new Set<string>();
  private running = false;
  private cb: WatcherCallbacks;
  private root: string;
  private intervalMs: number;

  constructor(cb: WatcherCallbacks, root = claudeDir(), intervalMs = 1000) {
    this.cb = cb;
    this.root = root;
    this.intervalMs = intervalMs;
  }

  start() {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private warn(key: string, message: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.cb.onWarning?.(message);
  }

  async scan() {
    if (this.running) return;
    this.running = true;
    try {
      await this.scanTeams();
      await this.scanTasks();
    } finally {
      this.running = false;
    }
  }

  private async list(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }

  private async scanTeams() {
    const teamsDir = join(this.root, 'teams');
    for (const team of await this.list(teamsDir)) {
      const path = join(teamsDir, team, 'config.json');
      let json: unknown;
      try {
        json = await readJson(path);
      } catch {
        continue; // missing or mid-write
      }
      const snap = parseTeamConfig(team, json);
      if (!snap) {
        this.warn(`team:${team}`, `team config ${path} has an unrecognized shape; skipped`);
        continue;
      }
      const sig = JSON.stringify(snap);
      if (this.lastTeam.get(team) === sig) continue;
      this.lastTeam.set(team, sig);
      this.cb.onTeam(snap);
    }
  }

  private async scanTasks() {
    const tasksDir = join(this.root, 'tasks');
    for (const team of await this.list(tasksDir)) {
      const dir = join(tasksDir, team);
      try {
        if (!(await stat(dir)).isDirectory()) continue;
      } catch {
        continue;
      }
      const tasks: TaskInfo[] = [];
      for (const file of (await this.list(dir)).filter((f) => f.endsWith('.json')).sort()) {
        try {
          tasks.push(...parseTaskFile(await readJson(join(dir, file)), file.replace(/\.json$/, '')));
        } catch {
          /* mid-write; next poll */
        }
      }
      if (tasks.length === 0) continue;
      const sig = JSON.stringify(tasks);
      if (this.lastTasks.get(team) === sig) continue;
      this.lastTasks.set(team, sig);
      this.cb.onTasks({ teamName: team, tasks });
    }
  }
}

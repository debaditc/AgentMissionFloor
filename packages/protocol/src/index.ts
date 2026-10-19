// Versioned event schema shared by collector, world, viewer and simulator.

export const PROTOCOL_VERSION = 1;

export type EventSource = 'hook' | 'spool' | 'watcher' | 'transcript' | 'simulator';

export const EVENT_KINDS = [
  'session.start',
  'session.end',
  'prompt',
  'tool.pre',
  'tool.post',
  'tool.fail',
  'permission',
  'notification',
  'turn.stop',
  'turn.fail',
  'subagent.start',
  'subagent.stop',
  'task.created',
  'task.completed',
  'task.snapshot',
  'team.snapshot',
  'teammate.idle',
  'compact.pre',
  'compact.post',
  'cwd.changed',
  'context',
  'agent.meta',
  'conflict',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type ToolCategory = 'edit' | 'read' | 'test' | 'shell' | 'web' | 'plan' | 'spawn' | 'task' | 'other';

export type Station =
  | 'desk'
  | 'library'
  | 'lab'
  | 'server'
  | 'window'
  | 'whiteboard'
  | 'board'
  | 'archive'
  | 'lounge'
  | 'door';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface ToolInfo {
  name: string;
  category: ToolCategory;
  /** Files, hosts or patterns the tool touches (redacted, short). */
  targets: string[];
  useId?: string;
  /** Short human detail, e.g. a redacted command or "+42 −9". */
  detail?: string;
  added?: number;
  removed?: number;
  /** Agent spawns: the teammate/intern name. SendMessage: the recipient. */
  agentName?: string;
  /** Task tool input (TaskUpdate / TaskCreate), used for claims. */
  taskPatch?: { id?: string; status?: string; owner?: string; subject?: string };
}

export interface TaskInfo {
  id: string;
  subject?: string;
  status?: TaskStatus;
  owner?: string;
  blockedBy?: string[];
}

export interface TeamMember {
  name: string;
  agentId?: string;
  agentType?: string;
  sessionId?: string;
}

export interface AmbEvent {
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  protocolVersion: number;
  source: EventSource;
  sessionId: string;
  parentSessionId?: string;
  teamName?: string;
  agentName?: string;
  agentId?: string;
  agentType?: string;
  cwd: string;
  kind: EventKind;
  hook?: string;
  tool?: ToolInfo;
  task?: TaskInfo;
  /** task.snapshot: full task list of a team. */
  tasks?: TaskInfo[];
  /** team.snapshot: members of a team. */
  members?: TeamMember[];
  outcome?: { ok: boolean; error?: string; durationMs?: number; output?: string };
  context?: { used: number; max: number | null; pctFree: number | null; model?: string };
  needsUser?: { type: 'approval' | 'question'; message?: string };
  /**
   * prompt: not a request from Deb but Claude Code reporting a background task back to the lead
   * (`<task-notification>`): which agent, and whether it completed or was stopped.
   */
  notice?: { taskId: string; status: string };
  summary?: string;
  transcriptPath?: string;
  /** SubagentStop: the agent's own transcript. */
  agentTranscriptPath?: string;
  model?: string;
  /** agent.meta: Claude Code's per-agent metadata file (read-only enrichment). */
  meta?: AgentMeta;
  /** conflict: two people edited the same file within the conflict window. */
  conflict?: ConflictInfo;
}

export interface ConflictEdit {
  /** Actor key: session id, or session:agent for teammates and interns. */
  actorKey: string;
  ts: number;
  added: number;
  removed: number;
  tool: string;
}

export interface ConflictInfo {
  path: string;
  /** The earlier edit and the one that collided with it. */
  first: ConflictEdit;
  second: ConflictEdit;
  windowMs: number;
}

export interface AgentMeta {
  description?: string;
  name?: string;
  model?: string;
  /** e.g. "in_process_teammate" for agent-team teammates. */
  taskKind?: string;
  teamName?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const kindSet = new Set<string>(EVENT_KINDS);

/** Structural check for events crossing a process boundary. */
export function validateEvent(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) return { ok: false, errors: ['not an object'] };
  const e = value as Record<string, unknown>;
  const str = (k: string, required = true) => {
    if (e[k] === undefined && !required) return;
    if (typeof e[k] !== 'string' || (required && (e[k] as string).length === 0)) errors.push(`${k}: expected string`);
  };
  str('id');
  str('sessionId');
  if (typeof e.cwd !== 'string') errors.push('cwd: expected string');
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) errors.push('ts: expected number');
  if (e.protocolVersion !== PROTOCOL_VERSION) errors.push(`protocolVersion: expected ${PROTOCOL_VERSION}`);
  if (typeof e.kind !== 'string' || !kindSet.has(e.kind)) errors.push(`kind: unknown ${String(e.kind)}`);
  for (const k of ['parentSessionId', 'teamName', 'agentName', 'agentId', 'summary']) str(k, false);
  if (e.tool !== undefined) {
    const t = e.tool as Record<string, unknown>;
    if (typeof t?.name !== 'string') errors.push('tool.name: expected string');
    if (!Array.isArray(t?.targets)) errors.push('tool.targets: expected array');
  }
  if (e.task !== undefined && typeof (e.task as Record<string, unknown>)?.id !== 'string') errors.push('task.id: expected string');
  return { ok: errors.length === 0, errors };
}

export * from './categorize.ts';
export * from './normalize.ts';
export * from './models.ts';
export * from './redact.ts';
export * from './settings.ts';

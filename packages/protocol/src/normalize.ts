// Raw Claude Code hook payload → AmbEvent. This keeps only shapes (paths, counts, short
// details), never file contents. Redaction of the remaining strings happens in the collector.

import { PROTOCOL_VERSION, type AmbEvent, type EventKind, type EventSource, type TaskInfo, type ToolInfo } from './index.ts';
import { categorizeTool } from './categorize.ts';
import { redactString } from './redact.ts';

type Raw = Record<string, unknown>;

const HOOK_KIND: Record<string, EventKind> = {
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool.pre',
  PostToolUse: 'tool.post',
  PostToolUseFailure: 'tool.fail',
  PermissionRequest: 'permission',
  Notification: 'notification',
  Stop: 'turn.stop',
  StopFailure: 'turn.fail',
  SubagentStart: 'subagent.start',
  SubagentStop: 'subagent.stop',
  TaskCreated: 'task.created',
  TaskCompleted: 'task.completed',
  TeammateIdle: 'teammate.idle',
  PreCompact: 'compact.pre',
  PostCompact: 'compact.post',
  CwdChanged: 'cwd.changed',
};

/** Notification types that mean "someone needs Deb". */
const NEEDS_USER_NOTIFICATIONS: Record<string, 'approval' | 'question'> = {
  permission_prompt: 'approval',
  // idle_prompt is deliberately absent: "waiting for input" after a finished turn means
  // the Lounge, not the door. A real question is caught from the Stop message instead.
  elicitation_dialog: 'question',
  elicitation_url_dialog: 'question',
  agent_needs_input: 'question',
};

export const LIMITS = { command: 400, summary: 200, title: 40, output: 600, error: 300, target: 160, name: 128, path: 1024 } as const;

const s = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const obj = (v: unknown): Raw | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : undefined);

/** Redact, then keep the first `max` characters (never clip first: that could split a secret). */
export function clip(text: string, max: number): string {
  const r = redactString(text);
  return r.length <= max ? r : r.slice(0, max - 1) + '…';
}

/** Redact, then keep the last `max` characters (for command output and errors). */
export function tail(text: string, max: number): string {
  const r = redactString(text, { keep: 'end' });
  return r.length <= max ? r : '…' + r.slice(r.length - max + 1);
}

/** Short identifiers (names, ids, enum-ish values): bounded, never free text. */
function ident(v: unknown, max: number = LIMITS.name): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

function lineCount(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return text.split('\n').length;
}

/** First non-empty line, trimmed to the card-title limit (§5.3: ≤ 40 chars). */
export function cardTitle(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return clip(line, LIMITS.title);
}

/** Heuristic for "Stop with a question in the last message" (§8). */
export function endsWithQuestion(message: string): boolean {
  const lines = message.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return /\?["')*_\s]*$/.test(last);
}

function urlTarget(raw: string): string {
  try {
    const u = new URL(raw);
    return clip(u.host + u.pathname, LIMITS.target);
  } catch {
    return clip(raw.split('?')[0] ?? raw, LIMITS.target);
  }
}

export function toolInfo(name: string, input: Raw | undefined, useId: string | undefined): ToolInfo {
  const category = categorizeTool(name, input);
  const info: ToolInfo = { name, category, targets: [] };
  if (useId) info.useId = useId;
  const push = (t: unknown) => {
    const v = s(t);
    if (v) info.targets.push(clip(v, LIMITS.target));
  };
  if (!input) return info;

  switch (name) {
    case 'Edit': {
      push(input.file_path);
      info.added = lineCount(input.new_string);
      info.removed = lineCount(input.old_string);
      break;
    }
    case 'MultiEdit': {
      push(input.file_path);
      const edits = Array.isArray(input.edits) ? input.edits : [];
      info.added = edits.reduce((n: number, e) => n + lineCount(obj(e)?.new_string), 0);
      info.removed = edits.reduce((n: number, e) => n + lineCount(obj(e)?.old_string), 0);
      break;
    }
    case 'Write':
      push(input.file_path);
      info.added = lineCount(input.content);
      info.removed = 0;
      break;
    case 'NotebookEdit':
      push(input.notebook_path);
      break;
    case 'Read':
    case 'NotebookRead':
      push(input.file_path ?? input.notebook_path);
      break;
    case 'Grep':
      push(input.pattern);
      push(input.path);
      break;
    case 'Glob':
      push(input.pattern);
      break;
    case 'LS':
      push(input.path);
      break;
    case 'WebFetch':
      if (s(input.url)) info.targets.push(urlTarget(input.url as string));
      break;
    case 'WebSearch':
      push(input.query);
      break;
    case 'Task':
    case 'Agent':
      push(input.subagent_type);
      if (s(input.description)) info.detail = clip(input.description as string, LIMITS.summary);
      if (s(input.name)) info.agentName = clip(input.name as string, 60);
      break;
    case 'SendMessage': {
      const to = s(input.to) ?? s(input.recipient) ?? s(input.name);
      if (to) info.agentName = clip(to, 60);
      break;
    }
    case 'TaskStop':
    case 'KillShell': {
      // Which background agent (or shell) the lead stopped.
      const id = s(input.task_id) ?? s(input.taskId) ?? s(input.shell_id) ?? s(input.id);
      if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id)) info.targets.push(id);
      break;
    }
    case 'TaskCreate':
    case 'TaskUpdate': {
      const patch: NonNullable<ToolInfo['taskPatch']> = {};
      const id = s(input.taskId) ?? s(input.task_id) ?? s(input.id);
      if (id) patch.id = id;
      if (s(input.status)) patch.status = input.status as string;
      if (s(input.owner)) patch.owner = input.owner as string;
      if (s(input.subject)) patch.subject = clip(input.subject as string, LIMITS.summary);
      info.taskPatch = patch;
      break;
    }
    default:
      push(input.file_path ?? input.path);
  }
  if (category === 'shell' || category === 'test' || name === 'Bash') {
    if (s(input.command)) info.detail = clip(input.command as string, LIMITS.command);
  } else if (info.added !== undefined) {
    info.detail = `+${info.added} −${info.removed ?? 0}`;
  }
  return info;
}

/**
 * Claude Code reports a finished or stopped background task to the lead as a prompt starting
 * with `<task-notification>`. Only the task id and status are kept (never the output path).
 */
export function taskNotice(text: string): { taskId: string; status: string } | null {
  if (!text.startsWith('<task-notification>')) return null;
  const head = text.slice(0, 4096);
  const id = /<task-id>([A-Za-z0-9_-]{1,128})<\/task-id>/.exec(head)?.[1];
  if (!id) return null;
  const status = /<status>([a-z_]{1,20})<\/status>/i.exec(head)?.[1]?.toLowerCase() ?? 'unknown';
  return { taskId: id, status };
}

function bashOutput(response: unknown): string | undefined {
  const r = obj(response);
  if (!r) return typeof response === 'string' ? tail(response, LIMITS.output) : undefined;
  const out = [s(r.stdout), s(r.stderr)].filter(Boolean).join('\n');
  return out ? tail(out, LIMITS.output) : undefined;
}

export interface NormalizeOptions {
  id: string;
  ts: number;
  source: EventSource;
}

/** Returns null for hook events we don't model. */
export function normalizeHook(raw: Raw, opts: NormalizeOptions): AmbEvent | null {
  const hook = s(raw.hook_event_name);
  if (!hook) return null;
  const kind = HOOK_KIND[hook];
  if (!kind) return null;
  const sessionId = ident(raw.session_id);
  if (!sessionId) return null;

  const e: AmbEvent = {
    id: opts.id,
    ts: opts.ts,
    protocolVersion: PROTOCOL_VERSION,
    source: opts.source,
    sessionId,
    cwd: ident(raw.cwd, LIMITS.path) ?? '',
    kind,
    hook,
  };
  // Every field is bounded: a hostile or huge payload can't bloat the store or stall the collector.
  const transcript = ident(raw.transcript_path, LIMITS.path);
  if (transcript) e.transcriptPath = transcript;
  const agentId = ident(raw.agent_id);
  if (agentId) e.agentId = agentId;
  const agentType = ident(raw.agent_type);
  if (agentType) e.agentType = agentType;
  const teammate = ident(raw.teammate_name);
  if (teammate) e.agentName = teammate;
  const team = ident(raw.team_name);
  if (team) e.teamName = team;

  const input = obj(raw.tool_input);
  const toolName = ident(raw.tool_name);

  switch (kind) {
    case 'session.start':
      if (s(raw.source)) e.summary = ident(raw.source);
      if (s(raw.model)) e.model = ident(raw.model);
      break;
    case 'session.end':
      if (s(raw.reason)) e.summary = ident(raw.reason);
      break;
    case 'prompt': {
      const text = s(raw.prompt) ? (raw.prompt as string).trim() : '';
      const notice = taskNotice(text);
      if (notice) {
        e.notice = notice;
        e.summary = `Background task ${notice.status}`;
      } else if (text) e.summary = clip(text, LIMITS.summary);
      break;
    }
    case 'tool.pre':
    case 'tool.post':
    case 'tool.fail':
    case 'permission': {
      if (!toolName) return null;
      e.tool = toolInfo(toolName, input, s(raw.tool_use_id));
      const durationMs = typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined;
      if (kind === 'tool.post') {
        e.outcome = { ok: true };
        if (durationMs !== undefined) e.outcome.durationMs = durationMs;
        if (e.tool.category === 'shell' || e.tool.category === 'test') {
          const out = bashOutput(raw.tool_response);
          if (out) e.outcome.output = out;
        }
      } else if (kind === 'tool.fail') {
        e.outcome = { ok: false, error: tail(s(raw.error) ?? 'failed', LIMITS.error) };
        if (durationMs !== undefined) e.outcome.durationMs = durationMs;
        if (raw.is_interrupt === true) e.summary = 'interrupted';
      } else if (kind === 'permission') {
        e.needsUser = { type: 'approval', message: e.tool.detail ?? e.tool.targets[0] ?? toolName };
      }
      break;
    }
    case 'notification': {
      const type = s(raw.notification_type);
      if (s(raw.message)) e.summary = clip(raw.message as string, LIMITS.summary);
      const need = type ? NEEDS_USER_NOTIFICATIONS[type] : undefined;
      if (need) e.needsUser = { type: need, ...(e.summary ? { message: e.summary } : {}) };
      break;
    }
    case 'turn.stop':
    case 'subagent.stop': {
      if (kind === 'subagent.stop' && s(raw.agent_transcript_path)) e.agentTranscriptPath = raw.agent_transcript_path as string;
      const msg = s(raw.last_assistant_message);
      if (msg) {
        e.summary = tail(msg.trim(), LIMITS.summary);
        if (kind === 'turn.stop' && endsWithQuestion(msg)) e.needsUser = { type: 'question', message: e.summary };
      }
      break;
    }
    case 'turn.fail':
      e.outcome = { ok: false, error: clip([s(raw.error), s(raw.error_details)].filter(Boolean).join(': ') || 'error', LIMITS.error) };
      break;
    case 'task.created':
    case 'task.completed': {
      const id = s(raw.task_id);
      if (!id) return null;
      const task: TaskInfo = { id, status: kind === 'task.created' ? 'pending' : 'completed' };
      if (s(raw.task_subject)) task.subject = clip(raw.task_subject as string, LIMITS.summary);
      if (e.agentName) task.owner = e.agentName;
      e.task = task;
      break;
    }
    case 'compact.pre':
    case 'compact.post':
      if (s(raw.trigger)) e.summary = ident(raw.trigger);
      break;
    case 'cwd.changed':
      if (s(raw.new_cwd)) e.cwd = ident(raw.new_cwd, LIMITS.path)!;
      if (s(raw.old_cwd)) e.summary = clip(raw.old_cwd as string, LIMITS.path);
      break;
    default:
      break;
  }
  return e;
}

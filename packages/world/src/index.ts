// Pure, deterministic reducer: AmbEvent stream → office state (§11 world).
// Every input it reads comes from the event, so replay reproduces the same state.

import { cardTitle, stationForCategory, type AmbEvent, type ConflictInfo, type Station, type TaskStatus, type TeamMember, type ToolInfo } from '@agent-mission-floor/protocol';

export type Role = 'solo' | 'lead' | 'teammate' | 'intern';
export type ActorStatus = 'working' | 'idle' | 'waiting' | 'error' | 'gone';
export type Bubble =
  | 'edit'
  | 'read'
  | 'shell'
  | 'test'
  | 'bug'
  | 'check'
  | 'web'
  | 'plan'
  | 'archive'
  | 'idle'
  | 'question'
  | 'approval'
  | 'thinking'
  | 'error'
  | null;

export interface Chip {
  text: string;
  tone: 'code' | 'error';
}

export interface Actor {
  key: string;
  sessionId: string;
  agentId?: string;
  /** Hook agent_type. For agent-team teammates this is their member name. */
  agentType?: string;
  /** The name the lead gave them when it's a role ("Security reviewer"); shown beside their first name. */
  handle?: string;
  /**
   * The first name the lead gave them when someone in the office already had it. Never shown (names
   * stay unique); used to match task owners and messages addressed to that name.
   */
  alias?: string;
  role: Role;
  name: string;
  /** Index into TEAM_COLORS. Interns use a lighter tint of their parent's color. */
  color: number;
  tint: boolean;
  parentKey?: string;
  teamName?: string;
  station: Station;
  activity: string;
  bubble: Bubble;
  chip: Chip | null;
  status: ActorStatus;
  cardKey?: string;
  /** What they were asked to do: spawn description, claimed card, or the solo prompt. */
  assignment?: string;
  /** Station to walk back to after a trip to the Archive. */
  returnStation?: Station;
  /** Their assignment is finished (teammate went idle / intern left). */
  assignmentDone?: boolean;
  /** The last piece of work they finished, until they start something new ("✓ Done" in the UI). */
  finished?: { what: string; ts: number };
  memory: { used: number; max: number | null; pctFree: number | null } | null;
  model?: string;
  cwd: string;
  transcriptPath?: string;
  toolCalls: number;
  errors: number;
  startedTs: number;
  lastTs: number;
  needs?: { type: 'approval' | 'question' | 'mission'; message?: string; ts: number; tool?: string };
  /** tool_use_ids whose PreToolUse was applied but whose Post hasn't arrived (parallel calls). */
  pendingTools: string[];
  /** Recently finished tool_use_ids, so a late PreToolUse after its PostToolUse is ignored. */
  doneTools: string[];
}

export interface Card {
  key: string;
  id: string;
  teamName?: string;
  sessionId: string;
  title: string;
  /** Full request (≤ 200 chars) for prompt cards; becomes the mission text if a team forms. */
  text?: string;
  status: TaskStatus;
  ownerKey?: string;
  ownerName?: string;
  blockedBy: string[];
  failed: boolean;
  /** Made for an intern's or teammate's assignment (no task list): they pin it to Done when finished. */
  assignment?: boolean;
  createdTs: number;
  updatedTs: number;
}

export interface Mission {
  sessionId: string;
  text: string;
  ts: number;
  complete: boolean;
}

export interface WorldState {
  actors: Record<string, Actor>;
  cards: Record<string, Card>;
  missions: Record<string, Mission>;
  teams: Record<string, { members: TeamMember[]; leadSessionId?: string }>;
  stats: { toolCalls: number; errors: number; events: number };
  promptSeq: Record<string, number>;
  /** Agent spawns seen in a session, waiting for their SubagentStart (gives the assignment). */
  spawns: Record<string, Array<{ description: string; type?: string; name?: string }>>;
  /** Recent same-file collisions between two people (newest last, capped). */
  conflicts: Array<ConflictInfo & { id: string; ts: number }>;
  lastTs: number;
}

export const TEAM_COLORS = ['#1f6feb', '#b4329f', '#e07b00', '#2e9d4f', '#0e8f99', '#5aa2ff'] as const;
/**
 * Familiar first names, half English and half Indian (Deb's picks), kept in balance on the board:
 * each newcomer is named from whichever group has fewer people in the office right now (D23).
 * Stable per session (spec §2); a first name the lead gave a teammate is kept.
 */
// "Deb" is reserved: it's the human, drawn as the AI Orchestrator in the glass office (D26).
export const ENGLISH_NAMES = ['Harry', 'Ron', 'Hermione', 'David', 'Sophie'] as const;
export const INDIAN_NAMES = ['Bini', 'Moon', 'Rinchi', 'Rajan', 'Raj'] as const;
export const NAMES = [...ENGLISH_NAMES, ...INDIAN_NAMES] as const;
/** The human (spec: "Deb is the boss"). No agent is ever given this name. */
export const HUMAN_NAME = 'Deb';

const DONE_TOOLS_MAX = 32;
export const STALE_AFTER_MS = 60_000;

export function emptyWorld(): WorldState {
  return { actors: {}, cards: {}, missions: {}, teams: {}, stats: { toolCalls: 0, errors: 0, events: 0 }, promptSeq: {}, spawns: {}, conflicts: [], lastTs: 0 };
}

export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function actorKey(e: Pick<AmbEvent, 'sessionId' | 'agentId'>): string {
  return e.agentId ? `${e.sessionId}:${e.agentId}` : e.sessionId;
}

/** Agent teams name the team after the lead: `session-` + first 8 chars of its session id. */
export function teamNameForSession(sessionId: string): string {
  return `session-${sessionId.slice(0, 8)}`;
}

/** "security-reviewer" → "Security reviewer"; "emma" → "Emma". */
/** A lead-given name that reads like a first name ("emma") is kept; a role ("security-reviewer") isn't. */
export function isPersonName(name: string): boolean {
  return /^[A-Za-z][a-z]{1,14}$/.test(name);
}

function capitalize(name: string): string {
  const spaced = name.replace(/[-_]+/g, ' ').trim();
  return spaced.length ? spaced[0]!.toUpperCase() + spaced.slice(1) : spaced;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function pickName(state: WorldState, key: string): string {
  const taken = new Set(Object.values(state.actors).filter((a) => a.status !== 'gone').map((a) => a.name));
  for (const team of Object.values(state.teams)) for (const m of team.members) if (isPersonName(m.name)) taken.add(capitalize(m.name));
  const h = hashString(key);
  // Balance: draw from the group with fewer people in the office (ties: by hash, so it's stable).
  const count = (list: readonly string[]) => list.filter((n) => taken.has(n)).length;
  const english = count(ENGLISH_NAMES);
  const indian = count(INDIAN_NAMES);
  const first = english < indian ? ENGLISH_NAMES : indian < english ? INDIAN_NAMES : h % 2 ? INDIAN_NAMES : ENGLISH_NAMES;
  const second = first === ENGLISH_NAMES ? INDIAN_NAMES : ENGLISH_NAMES;
  for (const list of [first, second]) {
    const start = h % list.length;
    for (let i = 0; i < list.length; i++) {
      const n = list[(start + i) % list.length]!;
      if (!taken.has(n)) return n;
    }
  }
  // More than twelve people at once: reuse a name with a short suffix.
  return `${first[h % first.length]} ${String.fromCharCode(65 + (h % 26))}.`;
}

function bubbleFor(tool: ToolInfo): Bubble {
  switch (tool.category) {
    case 'edit':
      return 'edit';
    case 'read':
      return 'read';
    case 'test':
      return 'test';
    case 'shell':
      return 'shell';
    case 'web':
      return 'web';
    case 'plan':
    case 'spawn':
    case 'task':
      return 'plan';
    default:
      return 'thinking';
  }
}

/** Plain-language activity for name tags and the panel ("Reading session.ts", "Running tests"). */
export function describeTool(tool: ToolInfo): string {
  const target = tool.targets[0];
  const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
  switch (tool.name) {
    case 'Read':
    case 'NotebookRead':
      return target ? `Reading ${basename(target)}` : 'Reading';
    case 'Grep':
      return target ? `Searching '${clip(target, 28)}'` : 'Searching';
    case 'Glob':
    case 'LS':
      return target ? `Looking for ${clip(basename(target), 28)}` : 'Browsing files';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return target ? `Editing ${basename(target)}${tool.detail ? ` ${tool.detail}` : ''}` : 'Editing';
    case 'Write':
      return target ? `Writing ${basename(target)}${tool.detail ? ` ${tool.detail}` : ''}` : 'Writing';
    case 'WebFetch':
      return target ? `Reading ${target.split('/')[0]}` : 'Reading the web';
    case 'WebSearch':
      return target ? `Web search: ${clip(target, 28)}` : 'Searching the web';
    case 'Agent':
    case 'Task':
      return `Briefing ${tool.agentName ?? target ?? 'an intern'}`;
    case 'SendMessage':
      return tool.agentName ? `Messaging ${tool.agentName}` : 'Messaging the team';
    case 'TaskCreate':
      return 'Adding a task';
    case 'TaskUpdate':
      return tool.taskPatch?.status === 'completed' ? 'Finishing a task' : tool.taskPatch?.status === 'in_progress' ? 'Taking a task' : 'Updating a task';
    case 'TaskList':
    case 'TaskGet':
      return 'Checking the board';
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return 'Planning';
    case 'TodoWrite':
      return 'Updating the checklist';
  }
  if (tool.category === 'test') return `Running tests${tool.detail ? `: ${clip(tool.detail, 32)}` : ''}`;
  if (tool.category === 'read' && tool.detail) return `Searching code: ${clip(tool.detail, 36)}`;
  if (tool.category === 'shell') return tool.detail ? `$ ${clip(tool.detail, 40)}` : 'Running a command';
  if (tool.name.startsWith('mcp__')) return `Using ${tool.name.split('__')[1] ?? 'a tool'}`;
  return tool.name;
}

const activityFor = describeTool;

function chipFor(tool: ToolInfo): Chip | null {
  const target = tool.targets[0];
  if (tool.category === 'edit' && target) return { text: `${basename(target)} ${tool.detail ?? ''}`.trim(), tone: 'code' };
  if (tool.category === 'read' && target) return { text: basename(target), tone: 'code' };
  if (tool.category === 'web' && target) return { text: target.split('/')[0] ?? target, tone: 'code' };
  if ((tool.category === 'shell' || tool.category === 'test') && tool.detail) return { text: tool.detail.slice(0, 48), tone: 'code' };
  return null;
}

/** Mutable working copy for one reduce step; untouched actors/cards keep identity. */
class Draft {
  state: WorldState;
  constructor(prev: WorldState) {
    this.state = {
      ...prev,
      actors: { ...prev.actors },
      cards: { ...prev.cards },
      missions: { ...prev.missions },
      teams: { ...prev.teams },
      stats: { ...prev.stats },
      promptSeq: { ...prev.promptSeq },
      spawns: { ...(prev.spawns ?? {}) },
      conflicts: prev.conflicts ?? [],
    };
  }
  private touchedActors = new Set<string>();
  private touchedCards = new Set<string>();

  actor(key: string): Actor | undefined {
    const a = this.state.actors[key];
    if (!a) return undefined;
    if (!this.touchedActors.has(key)) {
      this.state.actors[key] = { ...a, doneTools: [...a.doneTools], pendingTools: [...a.pendingTools] };
      this.touchedActors.add(key);
    }
    return this.state.actors[key];
  }
  setActor(a: Actor) {
    this.state.actors[a.key] = a;
    this.touchedActors.add(a.key);
  }
  card(key: string): Card | undefined {
    const c = this.state.cards[key];
    if (!c) return undefined;
    if (!this.touchedCards.has(key)) {
      this.state.cards[key] = { ...c, blockedBy: [...c.blockedBy] };
      this.touchedCards.add(key);
    }
    return this.state.cards[key];
  }
  setCard(c: Card) {
    this.state.cards[c.key] = c;
    this.touchedCards.add(c.key);
  }
  deleteCard(key: string) {
    delete this.state.cards[key];
    this.touchedCards.delete(key);
  }
}

/**
 * Does a team member entry describe this actor? Verified against a real team (DECISIONS D16):
 * the config says `{name: "security-reviewer", agentId: "security-reviewer@session-…"}`, while
 * hooks say `agent_id: "asecurity-reviewer-<hex>"`, `agent_type: "security-reviewer"`.
 */
export function isMember(m: TeamMember, who: { agentId?: string; agentType?: string; agentName?: string; sessionId: string }): boolean {
  if (m.agentType === 'team-lead' && !who.agentId) return false;
  if (who.agentId) {
    if (m.agentId === who.agentId) return true;
    if (who.agentId.startsWith(`a${m.name}-`)) return true;
    if (m.agentId && m.agentId.split('@')[0] === who.agentId) return true;
  }
  if (who.agentType && who.agentType === m.name) return true;
  if (who.agentName && who.agentName === m.name) return true;
  return !who.agentId && !!m.sessionId && m.sessionId === who.sessionId && m.agentType !== 'team-lead';
}

function teamOfActor(state: WorldState, e: AmbEvent): string | undefined {
  if (e.teamName) return e.teamName;
  // In-process teammates fire hooks with the lead's session id, so the session's own team wins.
  const ownTeam = teamNameForSession(e.sessionId);
  if (state.teams[ownTeam]) return ownTeam;
  for (const [name, team] of Object.entries(state.teams)) {
    if (team.members.some((m) => isMember(m, e))) return name;
  }
  return undefined;
}

function memberFor(state: WorldState, teamName: string | undefined, e: AmbEvent): TeamMember | undefined {
  const team = teamName ? state.teams[teamName] : undefined;
  if (!team) return undefined;
  return team.members.find((m) => isMember(m, e));
}

function ensureActor(d: Draft, e: AmbEvent): Actor {
  const key = actorKey(e);
  const existing = d.actor(key);
  if (existing) {
    // Only a genuinely newer event (e.g. a resumed session) brings someone back; a late,
    // recovered event from before they left must not.
    if (existing.status === 'gone' && e.ts > existing.lastTs && e.kind !== 'session.end' && e.kind !== 'subagent.stop') existing.status = 'idle';
    return existing;
  }
  let parentKey: string | undefined;
  if (e.agentId) {
    parentKey = e.sessionId;
    if (!d.state.actors[parentKey]) ensureActor(d, { ...e, agentId: undefined, agentName: undefined, kind: 'session.start' });
  }
  const teamName = teamOfActor(d.state, e);
  const member = memberFor(d.state, teamName, e);
  const parent = parentKey ? d.state.actors[parentKey] : undefined;
  let role: Role = e.agentId ? 'intern' : 'solo';
  if (member) role = 'teammate';
  else if (!e.agentId && d.state.teams[teamNameForSession(e.sessionId)]) role = 'lead';
  const given = member?.name ?? e.agentName;
  const leadName = given && isPersonName(given) && capitalize(given) !== HUMAN_NAME ? capitalize(given) : undefined;
  // A name the lead chose is kept unless someone in the office already has it.
  const clash = !!leadName && nameTaken(d.state, leadName, key);
  const name = leadName && !clash ? leadName : pickName(d.state, key);
  const actor: Actor = {
    key,
    sessionId: e.sessionId,
    role,
    name,
    color: role === 'intern' && parent ? parent.color : hashString(key) % TEAM_COLORS.length,
    tint: role === 'intern',
    station: role === 'lead' ? 'board' : 'desk',
    activity: 'arrived',
    bubble: null,
    chip: null,
    status: 'idle',
    memory: null,
    cwd: e.cwd,
    toolCalls: 0,
    errors: 0,
    startedTs: e.ts,
    lastTs: e.ts,
    doneTools: [],
    pendingTools: [],
  };
  if (e.agentId) actor.agentId = e.agentId;
  if (e.agentType) actor.agentType = e.agentType;
  if (given && !isPersonName(given)) actor.handle = capitalize(given);
  if (clash) actor.alias = leadName;
  if (parentKey) actor.parentKey = parentKey;
  if (teamName) actor.teamName = teamName;
  d.setActor(actor);
  return actor;
}

/** A first name from the lead replaces the auto name; a role becomes their handle instead. */
/** Someone else in the office already goes by this name. */
function nameTaken(state: WorldState, name: string, exceptKey: string): boolean {
  return Object.values(state.actors).some((o) => o.key !== exceptKey && o.status !== 'gone' && o.name === name);
}

/** Keep the lead's first name for a teammate unless someone else already has it (names stay unique). */
function nameFromLead(state: WorldState, a: Actor, given: string) {
  if (!isPersonName(given) || capitalize(given) === HUMAN_NAME) {
    a.handle = capitalize(given);
    return;
  }
  const name = capitalize(given);
  if (a.name === name) return;
  if (nameTaken(state, name, a.key)) a.alias = name;
  else {
    a.name = name;
    a.alias = undefined;
  }
}

/**
 * Task owners and TeammateIdle use the lead-given name ("security-reviewer" or "emma"), so match
 * either the display name or the handle. Team members first: a solo session can share a name.
 */
function findActorByName(state: WorldState, name: string, teamName?: string): Actor | undefined {
  const lower = capitalize(name).toLowerCase();
  const matches = Object.values(state.actors).filter((a) => (a.name.toLowerCase() === lower || a.handle?.toLowerCase() === lower || a.alias?.toLowerCase() === lower) && a.status !== 'gone');
  // The lead's name for someone (their alias) beats a different person who happens to share it.
  const aliased = matches.find((a) => a.alias?.toLowerCase() === lower && (!teamName || a.teamName === teamName));
  if (aliased) return aliased;
  if (teamName) {
    const inTeam = matches.find((a) => a.teamName === teamName);
    if (inTeam) return inTeam;
  }
  return matches.find((a) => a.role === 'teammate') ?? matches.find((a) => !teamName || !a.teamName);
}

function setOwner(d: Draft, card: Card, ownerName: string | undefined) {
  if (!ownerName) return;
  card.ownerName = ownerName;
  const owner = findActorByName(d.state, ownerName, card.teamName);
  if (owner) {
    card.ownerKey = owner.key;
    const a = d.actor(owner.key)!;
    if (card.status === 'in_progress') {
      a.cardKey = card.key;
      a.assignment = card.title;
      a.assignmentDone = false;
    }
    else if (a.cardKey === card.key && card.status === 'completed') a.cardKey = undefined;
  }
}

function upsertTeamCard(
  d: Draft,
  teamName: string,
  sessionId: string,
  task: { id: string; subject?: string; status?: TaskStatus; owner?: string; blockedBy?: string[] },
  ts: number,
): Card {
  const key = `${teamName}:${task.id}`;
  let card = d.card(key);
  if (!card) {
    // The team has a real task list now: people work from those cards instead.
    for (const c of Object.values(d.state.cards)) {
      if (!c.assignment || c.teamName !== teamName) continue;
      if (c.ownerKey && d.state.actors[c.ownerKey]?.cardKey === c.key) d.actor(c.ownerKey)!.cardKey = undefined;
      d.deleteCard(c.key);
    }
    card = {
      key,
      id: task.id,
      teamName,
      sessionId,
      title: cardTitle(task.subject ?? `Task ${task.id}`),
      status: task.status ?? 'pending',
      blockedBy: task.blockedBy ?? [],
      failed: false,
      createdTs: ts,
      updatedTs: ts,
    };
    d.setCard(card);
  }
  if (task.subject) card.title = cardTitle(task.subject);
  if (task.status) card.status = task.status;
  if (task.blockedBy) card.blockedBy = task.blockedBy;
  card.updatedTs = ts;
  setOwner(d, card, task.owner);
  return card;
}

/** A solo prompt turned out to be a team mission: the lead's card becomes the mission text. */
function promoteToLead(d: Draft, a: Actor, teamName: string, ts: number) {
  if (a.role === 'lead' || a.agentId) return;
  a.role = 'lead';
  a.teamName = teamName;
  if (a.cardKey) {
    const card = d.state.cards[a.cardKey];
    if (card && !card.teamName) {
      if (!d.state.missions[a.sessionId]) d.state.missions[a.sessionId] = { sessionId: a.sessionId, text: card.text || card.title, ts, complete: false };
      a.assignment = d.state.missions[a.sessionId]!.text;
      delete d.state.cards[a.cardKey];
    }
    a.cardKey = undefined;
  }
}

/**
 * An intern's or teammate's assignment becomes a card they carry and pin to Done when finished, so
 * finished work is visible on the board. Not for teams with a task list: those cards already do it.
 */
function syncAssignmentCard(d: Draft, a: Actor, ts: number) {
  if (!a.agentId || !a.assignment) return;
  const teamName = a.role === 'teammate' ? (a.teamName ?? teamNameForSession(a.sessionId)) : undefined;
  const key = `${a.key}:assignment`;
  let card = d.card(key);
  if (!card) {
    if (teamName && Object.values(d.state.cards).some((c) => c.teamName === teamName && !c.assignment)) return;
    if (a.cardKey) return; // already carrying a task-list card
    card = {
      key,
      id: `a-${a.agentId}`,
      sessionId: a.sessionId,
      ...(a.role === 'teammate' && a.teamName ? { teamName: a.teamName } : {}),
      title: cardTitle(a.assignment),
      status: 'in_progress',
      ownerKey: a.key,
      ownerName: a.name,
      blockedBy: [],
      failed: false,
      assignment: true,
      createdTs: ts,
      updatedTs: ts,
    };
    d.setCard(card);
  }
  card.title = cardTitle(a.assignment);
  card.status = a.assignmentDone ? 'completed' : 'in_progress';
  card.updatedTs = ts;
  a.cardKey = a.assignmentDone ? (a.cardKey === key ? undefined : a.cardKey) : (a.cardKey ?? key);
}

/**
 * A background agent ended without its own SubagentStop: the lead stopped it (TaskStop), or Claude
 * Code reported it back (`<task-notification>`). Completed counts as done; anything else is
 * "stopped": they leave (interns) or go idle (teammates), and their unfinished card comes down.
 */
function endAgent(d: Draft, sessionId: string, agentId: string, ts: number, completed: boolean) {
  const a = d.actor(`${sessionId}:${agentId}`);
  if (!a || a.status === 'gone') return;
  a.pendingTools = [];
  a.needs = undefined;
  if (completed) {
    a.assignmentDone = true;
    finish(a, a.assignment, ts);
    syncAssignmentCard(d, a, ts);
  } else {
    const key = `${a.key}:assignment`;
    if (d.state.cards[key] && d.state.cards[key]!.status !== 'completed') d.deleteCard(key);
    if (a.cardKey === key) a.cardKey = undefined;
    a.finished = undefined;
  }
  if (a.role === 'teammate') {
    goIdle(a);
    a.activity = completed ? 'Done, waiting' : 'Stopped';
  } else {
    a.status = 'gone';
    a.activity = completed ? 'left' : 'stopped';
    a.bubble = null;
  }
}

function finish(a: Actor, what: string | undefined, ts: number) {
  if (what) a.finished = { what, ts };
}

function goIdle(a: Actor) {
  a.status = 'idle';
  a.station = 'lounge';
  a.bubble = 'idle';
  a.activity = 'idle';
  a.needs = undefined;
}

function applyTool(d: Draft, a: Actor, tool: ToolInfo, e: AmbEvent) {
  const station = stationForCategory(tool.category);
  if (station) a.station = station;
  if (tool.useId) {
    a.pendingTools.push(tool.useId);
    if (a.pendingTools.length > DONE_TOOLS_MAX) a.pendingTools.shift();
  }
  a.bubble = bubbleFor(tool);
  a.activity = activityFor(tool);
  a.status = 'working';
  const chip = chipFor(tool);
  if (chip) a.chip = chip;
  a.toolCalls += 1;
  d.state.stats.toolCalls += 1;
  if (a.agentId) a.assignmentDone = false;

  // Remember spawns so the next SubagentStart gets its assignment ("Security review of repo").
  if (tool.category === 'spawn' && tool.detail && !a.agentId) {
    const list = [...(d.state.spawns[a.sessionId] ?? [])];
    list.push({ description: tool.detail, ...(tool.targets[0] ? { type: tool.targets[0] } : {}), ...(tool.agentName ? { name: tool.agentName } : {}) });
    d.state.spawns[a.sessionId] = list.slice(-20);
  }

  // TaskUpdate carries claims (owner + in_progress) and completions; no hook reports a claim.
  if (tool.category === 'task' && tool.taskPatch?.id) {
    const teamName = a.teamName ?? teamOfActor(d.state, e) ?? teamNameForSession(e.sessionId);
    const status = tool.taskPatch.status as TaskStatus | undefined;
    const valid = status === 'pending' || status === 'in_progress' || status === 'completed' ? status : undefined;
    const owner = tool.taskPatch.owner ?? (valid === 'in_progress' && a.role !== 'lead' ? a.name : undefined);
    upsertTeamCard(d, teamName, e.sessionId, { id: tool.taskPatch.id, subject: tool.taskPatch.subject, status: valid, owner }, e.ts);
  }
}

function markDone(a: Actor, useId: string | undefined) {
  if (!useId) return;
  a.doneTools.push(useId);
  if (a.doneTools.length > DONE_TOOLS_MAX) a.doneTools.splice(0, a.doneTools.length - DONE_TOOLS_MAX);
}

function closeSoloCard(d: Draft, a: Actor, ts: number, failed = false) {
  if (!a.cardKey) return;
  const card = d.card(a.cardKey);
  if (card && !card.teamName) {
    card.status = failed ? card.status : 'completed';
    card.failed = failed;
    card.updatedTs = ts;
    if (!failed && card.ownerKey === a.key) finish(a, card.title, ts);
  }
  if (!failed) a.cardKey = undefined;
}

function checkMissionComplete(d: Draft, lead: Actor, ts: number, summary: string | undefined) {
  if (!lead.teamName) return;
  const cards = Object.values(d.state.cards).filter((c) => c.teamName === lead.teamName);
  if (cards.length === 0 || cards.some((c) => c.status !== 'completed')) return;
  const mission = d.state.missions[lead.sessionId];
  if (mission && !mission.complete) {
    d.state.missions[lead.sessionId] = { ...mission, complete: true };
    lead.needs = { type: 'mission', ts, ...(summary ? { message: summary } : {}) };
    lead.station = 'door';
    lead.status = 'waiting';
    finish(lead, mission.text, ts);
  }
}

/** Finished their last piece of work and hasn't started anything new (D29). */
export function isFinished(a: Actor): boolean {
  return !!a.finished && a.status !== 'working' && a.status !== 'error' && !(a.status === 'waiting' && a.needs?.type !== 'mission');
}

/** The project someone works in: their own session's folder (interns and teammates share the lead's). */
export function projectOf(state: WorldState, a: Actor): string {
  const root = a.parentKey ? (state.actors[a.parentKey] ?? a) : a;
  return root.cwd || '';
}

/** Projects with someone in the office, busiest first. */
export function projectsIn(state: WorldState, live: (a: Actor) => boolean = (a) => a.status !== 'gone'): Array<{ path: string; name: string; people: number }> {
  const counts = new Map<string, number>();
  for (const a of Object.values(state.actors)) {
    if (!live(a)) continue;
    const p = projectOf(state, a);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts]
    .map(([path, people]) => ({ path, name: path.split('/').filter(Boolean).pop() ?? path, people }))
    .sort((x, y) => y.people - x.people || x.name.localeCompare(y.name));
}

/** The office as seen through one project: its people, cards, missions and conflicts. */
export function filterByProject(state: WorldState, project: string | null): WorldState {
  if (!project) return state;
  const actors: Record<string, Actor> = {};
  for (const a of Object.values(state.actors)) if (projectOf(state, a) === project) actors[a.key] = a;
  const inProject = (sessionId: string) => {
    const root = state.actors[sessionId];
    return root ? projectOf(state, root) === project : false;
  };
  const cards: Record<string, Card> = {};
  for (const c of Object.values(state.cards)) if ((c.ownerKey && actors[c.ownerKey]) || inProject(c.sessionId)) cards[c.key] = c;
  const missions: Record<string, Mission> = {};
  for (const m of Object.values(state.missions)) if (inProject(m.sessionId)) missions[m.sessionId] = m;
  return { ...state, actors, cards, missions, conflicts: (state.conflicts ?? []).filter((c) => actors[c.first.actorKey] || actors[c.second.actorKey]) };
}

export function reduce(prev: WorldState, e: AmbEvent): WorldState {
  const d = new Draft(prev);
  const s = d.state;
  s.stats.events += 1;
  s.lastTs = Math.max(s.lastTs, e.ts);

  if (e.kind === 'team.snapshot') {
    if (!e.teamName) return s;
    const members = e.members ?? [];
    const lead = members.find((m) => m.agentType === 'team-lead');
    const leadSessionId = lead?.sessionId;
    s.teams[e.teamName] = { members, ...(leadSessionId ? { leadSessionId } : {}) };
    for (const a of Object.values(s.actors)) {
      if (a.status === 'gone') continue;
      const ownTeam = !a.agentId && teamNameForSession(a.sessionId) === e.teamName;
      if (ownTeam) {
        promoteToLead(d, d.actor(a.key)!, e.teamName, e.ts);
        continue;
      }
      const m = members.find((mm) => isMember(mm, a));
      if (m) {
        const w = d.actor(a.key)!;
        w.role = 'teammate';
        w.teamName = e.teamName;
        w.tint = false;
        if (m.name) nameFromLead(s, w, m.name);
      }
    }
    return s;
  }

  if (e.kind === 'task.snapshot') {
    if (!e.teamName) return s;
    for (const t of e.tasks ?? []) upsertTeamCard(d, e.teamName, e.sessionId, t, e.ts);
    return s;
  }

  const a = ensureActor(d, e);
  if (a.status === 'gone' && e.ts <= a.lastTs && e.kind !== 'context') {
    // Late event for someone who already left: count it, don't move them.
    if (e.kind === 'turn.stop') closeSoloCard(d, a, e.ts);
    return s;
  }
  a.lastTs = Math.max(a.lastTs, e.ts);
  if (e.transcriptPath && !a.agentId) a.transcriptPath = e.transcriptPath;

  switch (e.kind) {
    case 'session.start':
      if (e.model) a.model = e.model;
      a.status = 'idle';
      a.activity = 'arrived';
      if (e.summary === 'compact') a.bubble = null;
      break;

    case 'session.end':
      a.status = 'gone';
      a.activity = 'left';
      a.bubble = null;
      a.needs = undefined;
      for (const other of Object.values(s.actors)) {
        if (other.parentKey === a.key && other.status !== 'gone') {
          const w = d.actor(other.key)!;
          w.status = 'gone';
        }
      }
      break;

    case 'prompt': {
      if (e.notice) {
        // Claude Code reporting a background agent back to the lead: not a new request.
        endAgent(d, a.sessionId, e.notice.taskId, e.ts, e.notice.status === 'completed');
        a.status = 'working';
        a.bubble = 'thinking';
        a.activity = 'reading a report';
        break;
      }
      a.finished = undefined;
      a.status = 'working';
      a.bubble = 'thinking';
      a.activity = 'thinking';
      a.needs = undefined;
      const text = e.summary ?? '';
      if (a.role === 'lead') {
        a.station = 'board';
        // Follow-ups ("wrap up", "status?") don't replace a mission that is still running.
        const current = s.missions[a.sessionId];
        if (!current || current.complete) s.missions[a.sessionId] = { sessionId: a.sessionId, text, ts: e.ts, complete: false };
        a.assignment = s.missions[a.sessionId]!.text;
      } else if (!a.agentId) {
        closeSoloCard(d, a, e.ts);
        const n = (s.promptSeq[a.sessionId] ?? 0) + 1;
        s.promptSeq[a.sessionId] = n;
        const key = `${a.sessionId}:p${n}`;
        d.setCard({
          key,
          id: `p${n}`,
          sessionId: a.sessionId,
          title: cardTitle(text || 'Request'),
          text,
          status: 'in_progress',
          ownerKey: a.key,
          ownerName: a.name,
          blockedBy: [],
          failed: false,
          createdTs: e.ts,
          updatedTs: e.ts,
        });
        a.cardKey = key;
        a.assignment = cardTitle(text || 'Request');
        a.assignmentDone = false;
        a.station = 'board';
      }
      break;
    }

    case 'tool.pre':
      if (!e.tool) break;
      if (e.tool.useId && a.doneTools.includes(e.tool.useId)) break; // arrived after its PostToolUse
      a.finished = undefined;
      applyTool(d, a, e.tool, e);
      break;

    case 'tool.post':
    case 'tool.fail': {
      if (!e.tool) break;
      if (e.tool.useId && a.doneTools.includes(e.tool.useId)) break; // duplicate
      // The Pre may have been lost or may still be in flight; apply its effects now.
      const pendingAt = e.tool.useId ? a.pendingTools.indexOf(e.tool.useId) : -1;
      if (pendingAt >= 0) a.pendingTools.splice(pendingAt, 1);
      else applyTool(d, a, e.tool, e);
      if (e.tool.useId) a.pendingTools = a.pendingTools.filter((id) => id !== e.tool!.useId);
      markDone(a, e.tool.useId);
      // The lead stopped a background agent: it won't send its own SubagentStop.
      if (e.kind === 'tool.post' && (e.tool.name === 'TaskStop' || e.tool.name === 'KillShell')) {
        for (const id of e.tool.targets) endAgent(d, a.sessionId, id, e.ts, false);
      }
      if (a.needs?.type === 'approval') {
        a.needs = undefined;
        a.status = 'working';
      }
      if (e.kind === 'tool.fail') {
        a.errors += 1;
        s.stats.errors += 1;
        a.bubble = e.tool.category === 'test' ? 'bug' : 'error';
        a.chip = { text: (e.outcome?.error ?? 'failed').split('\n')[0]!.slice(0, 60), tone: 'error' };
      } else if (e.tool.category === 'test') {
        a.bubble = 'check';
      }
      break;
    }

    case 'permission':
      a.status = 'waiting';
      a.station = 'door';
      a.bubble = 'approval';
      a.needs = { type: 'approval', ts: e.ts, ...(e.needsUser?.message ? { message: e.needsUser.message } : {}), ...(e.tool ? { tool: e.tool.name } : {}) };
      break;

    case 'notification':
      if (e.needsUser && !a.needs) {
        a.status = 'waiting';
        a.station = 'door';
        a.bubble = e.needsUser.type === 'approval' ? 'approval' : 'question';
        a.needs = { type: e.needsUser.type, ts: e.ts, ...(e.needsUser.message ? { message: e.needsUser.message } : {}) };
      }
      break;

    case 'turn.stop':
      a.pendingTools = [];
      closeSoloCard(d, a, e.ts);
      if (e.needsUser?.type === 'question') {
        a.status = 'waiting';
        a.station = 'door';
        a.bubble = 'question';
        a.activity = 'has a question';
        a.needs = { type: 'question', ts: e.ts, ...(e.needsUser.message ? { message: e.needsUser.message } : {}) };
      } else {
        goIdle(a);
      }
      if (a.role === 'lead') checkMissionComplete(d, a, e.ts, e.summary);
      break;

    case 'turn.fail':
      a.status = 'error';
      a.bubble = 'error';
      a.activity = 'turn failed';
      a.chip = { text: (e.outcome?.error ?? 'error').slice(0, 60), tone: 'error' };
      a.errors += 1;
      s.stats.errors += 1;
      closeSoloCard(d, a, e.ts, true);
      break;

    case 'subagent.start': {
      // Fired in the parent's context; the intern itself is the agent_id actor.
      const queue = s.spawns[a.sessionId] ?? [];
      if (queue.length && !a.assignment) {
        const want = (a.agentType ?? '').toLowerCase();
        let i = queue.findIndex((q) => q.name?.toLowerCase() === want);
        if (i < 0) i = queue.findIndex((q) => q.type?.toLowerCase() === want);
        if (i < 0) i = 0;
        a.assignment = queue[i]!.description;
        s.spawns[a.sessionId] = queue.filter((_, j) => j !== i);
      }
      a.assignmentDone = false;
      a.finished = undefined;
      syncAssignmentCard(d, a, e.ts);
      a.status = 'working';
      a.station = 'whiteboard';
      a.bubble = null;
      a.activity = `briefed by ${a.parentKey ? s.actors[a.parentKey]?.name ?? 'lead' : 'lead'}`;
      if (a.parentKey) {
        const parent = d.actor(a.parentKey);
        if (parent) {
          parent.station = 'whiteboard';
          parent.bubble = 'plan';
        }
      }
      break;
    }

    case 'subagent.stop':
      if (a.agentId) {
        a.assignmentDone = true;
        finish(a, a.assignment, e.ts);
        syncAssignmentCard(d, a, e.ts);
        if (a.role === 'teammate') {
          // Teammates stay in the office between turns; interns leave when done.
          goIdle(a);
          a.activity = 'Done, waiting';
        } else {
          a.status = 'gone';
          a.activity = 'left';
          a.bubble = null;
        }
      }
      break;

    case 'agent.meta': {
      const m = e.meta;
      if (!m || !a.agentId) break;
      if (m.description) {
        a.assignment = m.description;
        syncAssignmentCard(d, a, e.ts);
      }
      if (m.taskKind?.includes('teammate') && a.role !== 'teammate') {
        a.role = 'teammate';
        a.tint = false;
        if (m.teamName) a.teamName = m.teamName;
      }
      if (m.name && a.role === 'teammate') nameFromLead(s, a, m.name);
      if (m.model && !a.model) a.model = m.model;
      break;
    }

    case 'task.created':
    case 'task.completed': {
      if (!e.task) break;
      const teamName = teamOfActor(s, e) ?? a.teamName ?? teamNameForSession(e.sessionId);
      if (!a.agentId && teamNameForSession(a.sessionId) === teamName) promoteToLead(d, a, teamName, e.ts);
      upsertTeamCard(d, teamName, e.sessionId, e.task, e.ts);
      if (e.kind === 'task.completed') {
        const owner = e.task.owner ? findActorByName(s, e.task.owner, teamName) : undefined;
        if (owner) {
          const w = d.actor(owner.key)!;
          w.station = 'board';
          w.bubble = 'check';
          finish(w, cardTitle(e.task.subject ?? `Task ${e.task.id}`), e.ts);
          if (w.cardKey === `${teamName}:${e.task.id}`) w.cardKey = undefined;
        }
      }
      break;
    }

    case 'teammate.idle': {
      // Fired by the teammate itself (agent_id) or on its behalf by name.
      const target = a.agentId ? a : e.agentName ? findActorByName(s, e.agentName, e.teamName) : undefined;
      const w = target ? d.actor(target.key)! : a;
      goIdle(w);
      w.assignmentDone = true;
      w.activity = 'Done, waiting';
      if (!w.finished) finish(w, w.assignment, e.ts);
      syncAssignmentCard(d, w, e.ts);
      break;
    }

    case 'compact.pre':
      if (a.station !== 'archive') a.returnStation = a.station;
      a.station = 'archive';
      a.bubble = 'archive';
      a.activity = 'filing notes';
      break;

    case 'compact.post':
      // Files the papers, then walks back to where they were working.
      a.bubble = null;
      a.activity = 'Notes filed';
      if (a.station === 'archive' && a.returnStation) a.station = a.returnStation;
      a.returnStation = undefined;
      break;

    case 'conflict':
      if (e.conflict) s.conflicts = [...s.conflicts, { ...e.conflict, id: e.id, ts: e.ts }].slice(-30);
      break;

    case 'cwd.changed':
      a.cwd = e.cwd;
      break;

    case 'context':
      if (e.context) {
        a.memory = { used: e.context.used, max: e.context.max, pctFree: e.context.pctFree };
        if (e.context.model) a.model = e.context.model;
      }
      break;

    default:
      break;
  }
  return s;
}

export function reduceAll(events: Iterable<AmbEvent>, start: WorldState = emptyWorld()): WorldState {
  let s = start;
  for (const e of events) s = reduce(s, e);
  return s;
}

/** §4.2: a card stays in progress after its owner went idle → "stale?". */
export function isStale(card: Card, state: WorldState, now: number): boolean {
  if (card.status !== 'in_progress' || !card.ownerKey) return false;
  const owner = state.actors[card.ownerKey];
  if (!owner) return false;
  return (owner.status === 'idle' || owner.status === 'gone') && now - owner.lastTs > STALE_AFTER_MS;
}

export const DORMANT_AFTER_MS = 60 * 60_000;

/** A session that went quiet without SessionEnd (closed terminal, crash). Shown as away, not on the floor. */
export function isDormant(actor: Actor, now: number): boolean {
  return actor.status !== 'gone' && actor.status !== 'waiting' && actor.status !== 'working' && now - actor.lastTs > DORMANT_AFTER_MS;
}

export function isBlocked(card: Card, state: WorldState): boolean {
  if (card.status !== 'pending' || card.blockedBy.length === 0) return false;
  return card.blockedBy.some((id) => state.cards[`${card.teamName}:${id}`]?.status !== 'completed');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Order-independent fingerprint of a state, for fixture tests and replay checks. */
export function stateHash(state: WorldState): string {
  return hashString(stable(state)).toString(16).padStart(8, '0');
}

export type InboxItem =
  | { id: string; kind: 'approval'; actorKey: string; ts: number; command?: string; tool?: string }
  | { id: string; kind: 'question'; actorKey: string; ts: number; message?: string }
  | { id: string; kind: 'mission'; actorKey: string; ts: number; summary?: string; mission?: string }
  | { id: string; kind: 'conflict'; ts: number; path: string; firstKey: string; secondKey: string; first: { added: number; removed: number }; second: { added: number; removed: number } };

export const CONFLICT_INBOX_MS = 30 * 60_000;

/**
 * Everything that needs Deb, newest first (spec §10.2): approvals, questions, mission-complete
 * summaries, and recent conflicts. Ids are stable so the viewer can remember dismissals.
 */
export function inboxItems(state: WorldState, now: number): InboxItem[] {
  const items: InboxItem[] = [];
  for (const a of Object.values(state.actors)) {
    if (!a.needs || a.status === 'gone') continue;
    const id = `${a.needs.type}:${a.key}:${a.needs.ts}`;
    if (a.needs.type === 'approval') items.push({ id, kind: 'approval', actorKey: a.key, ts: a.needs.ts, ...(a.needs.message ? { command: a.needs.message } : {}), ...(a.needs.tool ? { tool: a.needs.tool } : {}) });
    else if (a.needs.type === 'question') items.push({ id, kind: 'question', actorKey: a.key, ts: a.needs.ts, ...(a.needs.message ? { message: a.needs.message } : {}) });
    else {
      const mission = state.missions[a.sessionId]?.text;
      items.push({ id, kind: 'mission', actorKey: a.key, ts: a.needs.ts, ...(a.needs.message ? { summary: a.needs.message } : {}), ...(mission ? { mission } : {}) });
    }
  }
  for (const c of state.conflicts ?? []) {
    if (now - c.ts > CONFLICT_INBOX_MS) continue;
    items.push({ id: `conflict:${c.id}`, kind: 'conflict', ts: c.ts, path: c.path, firstKey: c.first.actorKey, secondKey: c.second.actorKey, first: { added: c.first.added, removed: c.first.removed }, second: { added: c.second.added, removed: c.second.removed } });
  }
  return items.sort((x, y) => y.ts - x.ts);
}

/** People involved in a conflict in the last few minutes (warning outline in the office). */
export function inConflict(state: WorldState, now: number, windowMs = 5 * 60_000): Set<string> {
  const out = new Set<string>();
  for (const c of state.conflicts ?? []) {
    if (now - c.ts > windowMs) continue;
    out.add(c.first.actorKey);
    out.add(c.second.actorKey);
  }
  return out;
}

export * from './replay.ts';

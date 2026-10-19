// Transcript enrichment (§4.3, §4.4): latest token usage → memory meter.
// Reads only the tail of the JSONL file; never stores transcript contents.

import { open, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { lstatSync } from 'node:fs';
import { claudeDir } from './watcher.ts';
import { contextWindowFor, pctFree } from '@agent-mission-floor/protocol';

const TAIL_BYTES = 512 * 1024;

export interface UsageReading {
  used: number;
  max: number | null;
  pctFree: number | null;
  model?: string;
  /** Timestamp of the assistant message the reading came from. */
  ts?: number;
}

async function readTail(path: string, bytes: number): Promise<string> {
  const { size } = await stat(path);
  const start = Math.max(0, size - bytes);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Drop the partial first line when we started mid-file.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await fh.close();
  }
}

/**
 * Context tokens in use = input + cache creation + cache read of the latest main-chain
 * assistant message (that is what the next request re-sends). Sidechain (subagent) messages are skipped.
 */
export function usageFromLines(text: string, opts: { disable1m?: boolean; includeSidechain?: boolean } = {}): UsageReading | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"usage"')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type !== 'assistant' || (rec.isSidechain === true && !opts.includeSidechain)) continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const usage = msg?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const n = (k: string) => (typeof usage[k] === 'number' ? (usage[k] as number) : 0);
    const used = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('output_tokens');
    if (used <= 0) continue;
    const model = typeof msg?.model === 'string' ? (msg.model as string) : undefined;
    const max = contextWindowFor(model, opts);
    const reading: UsageReading = { used, max, pctFree: pctFree(used, max) };
    if (model) reading.model = model;
    if (typeof rec.timestamp === 'string') reading.ts = Date.parse(rec.timestamp);
    return reading;
  }
  return null;
}

/** `includeSidechain`: an agent's own transcript (subagents/agent-*.jsonl) is all sidechain. */
export async function readUsage(path: string, includeSidechain = false): Promise<UsageReading | null> {
  if (!safeTranscriptPath(path)) return null;
  try {
    return usageFromLines(await readTail(path, TAIL_BYTES), { disable1m: process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1', includeSidechain });
  } catch {
    return null;
  }
}

/**
 * Hook payloads say where the transcript is; never trust that blindly (review M-A). Only an
 * absolute `.jsonl` path inside Claude's data folder (or the simulator's temp folder) is read.
 */
export function safeTranscriptPath(p: string | undefined): string | null {
  if (!p || !isAbsolute(p) || !p.endsWith('.jsonl') || p.includes('\0')) return null;
  const real = resolve(p);
  if (real.startsWith(resolve(claudeDir()) + sep)) return real;
  const sim = resolve(tmpdir(), 'amb-sim-transcripts');
  return real.startsWith(sim + sep) && ownedByMe(sim) ? real : null;
}

/** The simulator's temp folder counts only if this user owns it (a shared /tmp on Linux). */
function ownedByMe(dir: string): boolean {
  try {
    const s = lstatSync(dir);
    return s.isDirectory() && (!process.getuid || s.uid === process.getuid());
  } catch {
    return false;
  }
}

/** Ids and names that become part of a file path (review L-A). */
export function safeId(id: string | undefined): string | null {
  return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

/** Where Claude Code keeps an in-process teammate's / subagent's own transcript (verified 2026-10-18). */
export function agentTranscriptPath(sessionTranscript: string, sessionId: string, agentId: string): string | null {
  const base = safeTranscriptPath(sessionTranscript);
  const s = safeId(sessionId);
  const a = safeId(agentId);
  return base && s && a ? safeTranscriptPath(join(dirname(base), s, 'subagents', `agent-${a}.jsonl`)) : null;
}

export function agentMetaPath(sessionTranscript: string, sessionId: string, agentId: string): string | null {
  const t = agentTranscriptPath(sessionTranscript, sessionId, agentId);
  return t ? t.replace(/\.jsonl$/, '.meta.json') : null;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  models: string[];
}

type Usage4 = [number, number, number, number];

interface LedgerEntry {
  offset: number;
  totals: UsageTotals;
  /** Usage per message id: Claude Code writes one line per content block with the usage repeated. */
  seen: Map<string, Usage4>;
}

/**
 * Whole-transcript token totals, read incrementally: each call only parses bytes appended since
 * the last one. Counts every assistant message in the file (`includeSidechain` for agent files).
 */
export class UsageLedger {
  private entries = new Map<string, LedgerEntry>();
  private queue = new Map<string, Promise<unknown>>();

  /** Serialized per file so two concurrent reads can't count the same bytes twice. Never throws. */
  totals(path: string, includeSidechain = false): Promise<UsageTotals | null> {
    if (!safeTranscriptPath(path)) return Promise.resolve(null);
    const prev = this.queue.get(path) ?? Promise.resolve();
    const next = prev.then(() => this.read(path, includeSidechain)).catch(() => null);
    this.queue.set(path, next.catch(() => undefined));
    return next;
  }

  private async read(path: string, includeSidechain: boolean): Promise<UsageTotals | null> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return null;
    }
    let entry = this.entries.get(path);
    if (!entry || size < entry.offset) {
      entry = { offset: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, models: [] }, seen: new Map() };
      this.entries.set(path, entry);
    }
    if (size === entry.offset) return { ...entry.totals, models: [...entry.totals.models] };
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(size - entry.offset);
      await fh.read(buf, 0, buf.length, entry.offset);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) return { ...entry.totals, models: [...entry.totals.models] };
      // Only complete lines; a partial last line is read next time.
      entry.offset += Buffer.byteLength(text.slice(0, lastNl + 1));
      for (const line of text.slice(0, lastNl).split('\n')) {
        if (!line.includes('"usage"')) continue;
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (rec.type !== 'assistant' || (rec.isSidechain === true && !includeSidechain)) continue;
        const msg = rec.message as Record<string, unknown> | undefined;
        const u = msg?.usage as Record<string, unknown> | undefined;
        if (!u) continue;
        const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
        const T = entry.totals;
        const now: Usage4 = [n('input_tokens'), n('output_tokens'), n('cache_read_input_tokens'), n('cache_creation_input_tokens')];
        const id = typeof msg?.id === 'string' ? (msg.id as string) : `line:${entry.offset}:${T.messages}`;
        const before = entry.seen.get(id);
        if (before) {
          T.input -= before[0];
          T.output -= before[1];
          T.cacheRead -= before[2];
          T.cacheWrite -= before[3];
        } else T.messages += 1;
        entry.seen.set(id, now);
        T.input += now[0];
        T.output += now[1];
        T.cacheRead += now[2];
        T.cacheWrite += now[3];
        if (typeof msg?.model === 'string' && !T.models.includes(msg.model as string)) T.models.push(msg.model as string);
      }
    } finally {
      await fh.close();
    }
    return { ...entry.totals, models: [...entry.totals.models] };
  }
}

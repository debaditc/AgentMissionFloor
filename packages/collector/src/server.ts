// HTTP + WebSocket on 127.0.0.1 only. Token auth everywhere except /health; foreign
// origins and hosts are rejected (DNS-rebinding guard).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AmbEvent } from '@agent-mission-floor/protocol';
import type { WorldState } from '@agent-mission-floor/world';
import type { Collector } from './collector.ts';
import type { Store } from './store.ts';
import { parseTaskFile, parseTeamConfig } from './watcher.ts';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Legacy cookie name (before it was scoped per port); still accepted so old bookmarks keep working. */
const LEGACY_COOKIE = 'amb_token';
/** One-time login codes live this long (spec: the long-lived token never goes in a URL). */
export const LOGIN_CODE_TTL_MS = 2 * 60_000;
/** Same-origin only; no plugins, no <base> tricks, never framed by another site (clickjacking). */
const CSP =
  "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // The one-time sign-in code is in the /login URL; never leak a URL to another site.
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export interface ServerOptions {
  collector: Collector;
  store: Store;
  token: string;
  /** Mount points, longest prefix first wins, e.g. { '/raw/': rawDir, '/': distDir }. */
  staticDirs: Record<string, string>;
  version: string;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieToken(req: IncomingMessage, names: string[]): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k && names.includes(k)) {
      try {
        return decodeURIComponent(v.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export class AmbServer {
  readonly http: Server;
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private clients = new Set<WebSocket>();
  private stateTimer: NodeJS.Timeout | undefined;
  private port = 0;
  private opts: ServerOptions;
  /** One-time login codes → expiry (ms). */
  private codes = new Map<string, number>();

  constructor(opts: ServerOptions) {
    this.opts = opts;
    // Never an unhandled rejection: a failing request gets a 500, the collector keeps running.
    this.http = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) this.send(res, 500, { error: 'internal error' });
        else res.destroy();
      });
    });
    this.http.on('upgrade', (req, socket, head) => {
      if (!this.hostOk(req) || !this.originOk(req) || !this.authed(req) || !req.url?.startsWith('/v1/stream')) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onClient(ws));
    });
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        // The remembered port is taken: fall back to a random one.
        if (port !== 0 && err.code === 'EADDRINUSE') this.listen(0).then(resolve, reject);
        else reject(err);
      };
      this.http.once('error', onError);
      this.http.listen(port, '127.0.0.1', () => {
        this.http.off('error', onError);
        const addr = this.http.address();
        this.port = typeof addr === 'object' && addr ? addr.port : port;
        resolve(this.port);
      });
    });
  }

  close(): Promise<void> {
    clearTimeout(this.stateTimer);
    for (const c of this.clients) c.terminate();
    this.wss.close();
    return new Promise((resolve) => {
      this.http.close(() => resolve());
      // An open browser tab (keep-alive or a half-closed socket) must not hold shutdown hostage.
      this.http.closeAllConnections();
    });
  }

  /** Called by the collector for each accepted event. */
  broadcast(e: AmbEvent, world: WorldState) {
    if (this.clients.size === 0) return;
    const msg = JSON.stringify({ type: 'event', event: e });
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(msg);
    // World snapshots are coalesced to ≤ 10/s.
    if (!this.stateTimer) {
      this.stateTimer = setTimeout(() => {
        this.stateTimer = undefined;
        const state = JSON.stringify({ type: 'state', state: this.opts.collector.world });
        for (const c of this.clients) if (c.readyState === c.OPEN) c.send(state);
      }, 100);
    }
    void world;
  }

  private onClient(ws: WebSocket) {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
    ws.send(JSON.stringify({ type: 'hello', version: this.opts.version, state: this.opts.collector.world, events: this.opts.store.recent(300) }));
  }

  private hostOk(req: IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (curl, tests) send none
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  /** Cookie scoped to this port, so two boards on one machine don't overwrite each other. */
  private get cookieName(): string {
    return `amb_token_${this.port}`;
  }

  private bearerOk(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    return !!auth?.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), this.opts.token);
  }

  /** Bearer header or the board cookie. The token is never accepted in a URL (D31). */
  private authed(req: IncomingMessage): boolean {
    if (this.bearerOk(req)) return true;
    const c = cookieToken(req, [this.cookieName, LEGACY_COOKIE]);
    return !!c && safeEqual(c, this.opts.token);
  }

  private setCookieHeader(): string {
    // Persistent (1 year) so a bookmarked plain URL survives browser restarts (D27).
    return `${this.cookieName}=${encodeURIComponent(this.opts.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  }

  /** A single-use code that signs a browser in without the token ever appearing in a URL. */
  issueLoginCode(now = Date.now()): string {
    for (const [c, exp] of this.codes) if (exp < now) this.codes.delete(c);
    const code = randomBytes(18).toString('base64url');
    this.codes.set(code, now + LOGIN_CODE_TTL_MS);
    return code;
  }

  private send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}),
      ...headers,
    });
    res.end(text);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!this.hostOk(req) || !this.originOk(req)) return this.send(res, 403, { error: 'forbidden origin' });
    if (url.pathname === '/health' && req.method === 'GET') {
      return this.send(res, 200, { ok: true, app: 'agent-mission-floor', version: this.opts.version, pid: process.pid });
    }

    // Sign-in, step 1 (opener script, bearer only): get a 2-minute single-use code.
    if (url.pathname === '/v1/login-code' && req.method === 'POST') {
      if (!this.bearerOk(req)) return this.send(res, 401, { error: 'unauthorized' });
      return this.send(res, 200, { code: this.issueLoginCode() });
    }
    // Sign-in, step 2 (browser): trade the code for the board cookie.
    if (url.pathname === '/login' && req.method === 'GET') {
      const code = url.searchParams.get('code') ?? '';
      const exp = this.codes.get(code);
      this.codes.delete(code);
      if (!exp || exp < Date.now()) {
        return this.send(res, 401, 'This sign-in link has expired or was already used.\n\nIn a terminal, in the project folder, run:\n\n    npm run open\n', { 'content-type': 'text/plain; charset=utf-8' });
      }
      return this.send(res, 302, undefined, { location: '/', 'set-cookie': this.setCookieHeader() });
    }

    if (url.pathname === '/v1/hook' && req.method === 'POST') return this.handleHook(req, res);

    if (!this.authed(req)) {
      return this.send(
        res,
        401,
        'This board needs its access link once per browser.\n\nIn a terminal, in the project folder, run:\n\n    npm run open\n\nIt opens the board and remembers this browser for a year.\n',
        { 'content-type': 'text/plain; charset=utf-8' },
      );
    }

    if (url.pathname === '/v1/state' && req.method === 'GET') return this.send(res, 200, this.opts.collector.world);
    if (url.pathname === '/v1/actor' && req.method === 'GET') {
      const key = url.searchParams.get('key') ?? '';
      const summary = await this.opts.collector.actorSummary(key);
      return summary ? this.send(res, 200, summary) : this.send(res, 404, { error: 'unknown person' });
    }
    if (url.pathname === '/v1/events' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since'));
      if (Number.isFinite(since) && since > 0) {
        // Replay: a time range, oldest first.
        const until = Number(url.searchParams.get('until')) || Date.now();
        const limit = Math.min(100_000, Math.max(1, Number(url.searchParams.get('limit')) || 50_000));
        return this.send(res, 200, this.opts.store.range(since, until, limit));
      }
      const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 300));
      return this.send(res, 200, this.opts.store.recent(limit));
    }
    if (req.method === 'GET') return this.serveStatic(url.pathname, res);
    return this.send(res, 404, { error: 'not found' });
  }

  private handleHook(req: IncomingMessage, res: ServerResponse) {
    if (!this.authed(req)) {
      req.resume();
      return this.send(res, 401, { error: 'unauthorized' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      // Reply first: the sender (and so Claude Code) never waits on processing.
      this.send(res, tooBig ? 413 : 204);
      if (tooBig) return;
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return;
      }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
      const tsHeader = Number(req.headers['x-amb-ts']);
      const idHeader = req.headers['x-amb-id'];
      const id = typeof idHeader === 'string' && /^[0-9]+-[0-9]+$/.test(idHeader) ? `s-${idHeader}` : undefined;
      const source = req.headers['x-amb-source'] === 'simulator' ? 'simulator' : 'hook';
      const body = raw as Record<string, unknown>;
      // The simulator stands in for the team/task files the watcher reads in real use.
      if (source === 'simulator' && typeof body.amb_simulator === 'string' && typeof body.team_name === 'string') {
        if (body.amb_simulator === 'team') {
          const snap = parseTeamConfig(body.team_name, body);
          if (snap) this.opts.collector.ingestTeam(snap);
        } else if (body.amb_simulator === 'tasks') {
          this.opts.collector.ingestTasks({ teamName: body.team_name, tasks: parseTaskFile(body.tasks, '') });
        }
        return;
      }
      this.opts.collector.ingestHook(raw as Record<string, unknown>, {
        ...(Number.isFinite(tsHeader) && tsHeader > 0 ? { ts: tsHeader } : {}),
        ...(id ? { id } : {}),
        source,
      });
    });
  }

  private async serveStatic(pathname: string, res: ServerResponse) {
    if (pathname === '/raw') return this.send(res, 301, undefined, { location: '/raw/' });
    const mount = Object.keys(this.opts.staticDirs)
      .sort((a, b) => b.length - a.length)
      .find((m) => pathname.startsWith(m));
    if (!mount) return this.send(res, 404, { error: 'not found' });
    const sub = pathname.slice(mount.length);
    const rel = sub === '' || sub.endsWith('/') ? `${sub}index.html` : sub;
    const root = normalize(this.opts.staticDirs[mount] + sep);
    const file = normalize(join(root, rel));
    if (!file.startsWith(root)) return this.send(res, 404, { error: 'not found' });
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'content-security-policy': CSP,
      });
      res.end(body);
    } catch {
      this.send(res, 404, { error: 'not found' });
    }
  }
}

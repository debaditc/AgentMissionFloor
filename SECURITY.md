# Security

AgentMissionFloor runs entirely on your machine. It sees what your Claude Code sessions do (prompts, commands, file paths), so we treat it as sensitive software.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. You'll get a reply within a few days, and credit in the fix if you'd like it.

## How it's protected

- **Local only:**
  - The collector listens on `127.0.0.1`. It makes no outbound connections and sends no telemetry.
  - It rejects other hosts (DNS rebinding), other origins (cross-site requests) and framing (clickjacking).
- **Access:**
  - A random token in `~/.agent-mission-floor/token` (readable only by you) protects everything except `/health`.
  - Browsers sign in with a one-time code (2 minutes, single use) that becomes an HttpOnly, SameSite=Strict cookie.
  - The token is never printed, never put in a URL, and never accepted from one.
- **What's stored:**
  - Events are redacted (keys, tokens, passwords, cookies, connection strings) **before** they're shortened and stored.
  - File contents are never stored; only counts and paths are. Data is kept for 14 days.
  - The data folder is private to you (`0700`, files `0600`).
- **Never slows or steers Claude Code:** hooks are async, silent (no output reaches Claude), always exit 0, and never hook `WorktreeCreate`/`WorktreeRemove`. The plugin only reads from `~/.claude`.
- **Hostile input:** hook data can't choose which files are read (paths and ids are validated), can't inject HTML into the page, and is size-capped at every step.

## Known limits

- **Redaction is pattern-based.** A secret in an unusual format could still be stored in `events.db` for up to 14 days.
  - Turn sending off with `AMF_DISABLED=1`.
  - Delete everything with `npm run uninstall -- --purge`.
- **Hook payloads touch disk briefly.** Each one is written to a private temp file (≤ 2 MB) for the few milliseconds it takes to send, so nothing is lost if the collector is down.
- **Anyone who can read your files can read your board:** another process running as you, or an admin on the machine.

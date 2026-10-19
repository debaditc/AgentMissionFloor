# AgentMissionFloor

A live isometric office for Claude Code sessions. Spec: `AGENT_MISSION_FLOOR_SPEC.md`. Plan: `docs/PLAN.md`. Decisions: `docs/DECISIONS.md` (log every non-trivial one).

## Commands
- `npm install`: install (npm workspaces; also builds the viewer)
- `npm run setup` / `doctor` / `status` / `stop` / `demo` / `uninstall [-- --purge]`: the CLI (`packages/cli`)
- `npm run typecheck`: tsc (type-check only; Node runs `.ts` directly)
- `npm test`: all tests (`node --test`)
- `npm run build`: build the 3D office (packages/viewer → dist, served at `/` by the collector)
- `npm run collector`: run the collector (prints the board URL)
- `npm run sim -- [team|solo|permission|compaction|conflict|flaky] [--speed 4] [--loop]`: play scenarios
- `npm run open`: open the board with a one-time sign-in link (starts the collector if needed)
- `npm run sync:sender`: after editing `packages/sender/bin/amb-send`, copy it into the plugin
- Try it in Claude Code: `npm run setup`, or for one session `claude --plugin-dir packages/plugin`
- Settings are `AMF_*` (legacy `AMB_*` still read); data in `~/.agent-mission-floor`

## Structure
protocol (event schema, redaction) → world (pure reducer) → collector (ingest, redact, SQLite, watcher, HTTP/WS) → viewer (Three.js office at `/`, raw page at `/raw/`). Plus sender (sh + curl), plugin (hooks, command), cli and simulator.

## Rules (spec §1, non-negotiable)
- Clean-room: never read or copy claude-ville, pixel-agents, claude-office or pixtuoid. No pixel art.
- Never slow Claude Code: hooks are async, < 50 ms, always exit 0, silent (no stdout). Near-zero token cost.
- Local-only: bind 127.0.0.1, no telemetry, no runtime network egress, bundled assets.
- Every movement means something; no random wandering.
- Text lives in the DOM, never in the 3D scene.
- Calm daylight look: no neon, bloom or glow.
- Ask before adding heavy dependencies (> ~200 KB gzipped, or native modules).
- Read-only toward `~/.claude`. Never hook WorktreeCreate/WorktreeRemove.
- TS: `erasableSyntaxOnly` (no enums, namespaces or parameter properties); import with `.ts` extensions.

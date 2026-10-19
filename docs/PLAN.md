# AgentMissionFloor: plan and status

The source of truth for intent is `AGENT_MISSION_FLOOR_SPEC.md`. Every design choice and its reason is in `docs/DECISIONS.md` (D1…). This file says where things stand and what comes next.

## Status (2026-10-18)

| Phase | What | Status |
|---|---|---|
| 0 | Data truth: hooks → sender → collector, redaction, SQLite, team/task watcher, transcripts, simulator, raw page | ✅ built (D1–D12) |
| 1 | The office: Three.js isometric scene, characters, DOM overlay, side panel | ✅ built (D13–D15) |
| 1.5 | Real agent-team identity, assignments, plain-language activity, person drill-down, realistic look, LOD labels | ✅ built (D16–D19) |
| 2 | Walking (A* + choreography), mission-board animations, interns, café, ping pong, neutral palette, names | ✅ built (D20–D23) |
| 3 | Your inbox, notifications, conflicts, close-up, Follow; Deb in the office | ✅ built (D24, D26) |
| 4 | Replay: lanes, footprints, moments, debrief, highlight reel, clip export | ✅ built (D25) |
| A | Security hardening from our own reviews | ✅ built (D27) |
| B | Effortless install: `npm install` + `npm run setup`, doctor, demo, uninstall, local marketplace, rename internals to `agent-mission-floor` | ✅ built (D28) |
| U | UI round: readable board sheet, office fills the window, Focus mode, hover legend, grouped team panel, away digest, project filter; stopped agents leave | ✅ built (D33, D34) |
| U2 | Empty-state demo button, keyboard/aria polish, daily summary export, optional sounds + shortcuts overlay | planned |
| Docs | README architecture: end-to-end flow diagrams and the security design | ⏳ next |
| 5 | Approve / deny from the inbox (opt-in, 30 s fallback), optional sound | planned |
| 6 | Distribution: `npx` launcher, Windows, desktop shell evaluation | planned |

Still to confirm with a real session: a team that uses a **task list**, so cards flow across the board (Phase 2 acceptance), and **clip export** recorded in a real browser.

## Architecture

```
Claude Code ──async command hooks──▶ amb-send (sh + curl, ~19 ms, silent)
                                        │  only if the collector's pid is alive
                                        ├──POST 127.0.0.1 + bearer──▶ collector ──WS──▶ board (Three.js + DOM)
                                        └──collector down──▶ spool/ (≤ 64 KB, ≤ 2,000 files) ──▶ ingested later
~/.claude/teams · tasks · transcripts · subagents/*.meta.json ──read-only──▶ collector
```

| Package | Role |
|---|---|
| `protocol` | Event schema, tool categories, hook normalizer, **redaction** (runs before clipping) |
| `world` | Pure reducer: events → office state; inbox selector; replay index (lanes, moments, debrief, `stateAt`) |
| `collector` | Ingest, redact, SQLite (14 days), team watcher, transcripts and token ledger, conflict detector, HTTP + WS, one-time sign-in codes |
| `sender` | `amb-send` (copied into the plugin) |
| `plugin` | Async hooks for every event (never WorktreeCreate/Remove), `/…:open`, `amb-open` |
| `viewer` | Office scene, overlay, panel, drawer, inbox, replay, clip export; raw log at `/raw/` |
| `simulator` | Six scripted scenarios for demos and tests |
| `cli` | `setup`, `doctor`, `open`, `status`, `stop`, `demo`, `uninstall` |

## Dependencies

| Package | Version | Why |
|---|---|---|
| Node.js | ≥ 22.18 | built-in `node:sqlite` and TypeScript type stripping (no native modules, no build step for the collector) |
| `ws` | 8.22 | WebSocket server, pure JS |
| `three` | 0.186.1 | 3D office, `three/webgpu` with WebGL2 fallback (~227 KB gzipped, D13) |
| `vite` | 8.3 | builds the viewer |
| `@fontsource/rubik`, `@fontsource/jetbrains-mono` | 5.3 | bundled fonts (no CDN) |
| `typescript`, `@types/*` | dev | type-checking only |

## Quality bar
- `npm test`: 89 tests (protocol, world, collector integration, sender, plugin config, CLI safety, viewer placement, navigation and choreography).
- `npm run typecheck`: strict TypeScript.
- CI on macOS and Linux (read-only token, pinned actions) runs `npm audit`, typecheck, tests and the viewer build.
- Visual changes are checked with headless-Chrome screenshots before they ship.

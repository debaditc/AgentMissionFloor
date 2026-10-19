# AGENT MISSION FLOOR — Build Spec v2 (the office)

> **AgentMissionFloor**: a live, animated isometric office where your Claude Code sessions are a small team at work. You (Deb) are the boss. Requests become cards on a mission board, teammates pick them up, walk to the right station, do the work, pin the card to Done and grab the next one.
> Owner: **Deb**. Status: greenfield. This file is the source of truth until superseded by `docs/DECISIONS.md`.
> Reference art: `docs/reference/agent-mission-floor-office-reference.svg` (static isometric layout drawing). Concept mockups exist as a private canvas; Deb can share screenshots on request. Everything visual is also described in words below, so you don't need the mockups to start.

---

## 0. How you (Claude Code) should use this document

1. Read this entire file.
2. Verify the Claude Code facts in §4 against the official docs at https://code.claude.com/docs (hooks, agent teams, plugins). Claude Code changes quickly. If anything differs, note it in `docs/DECISIONS.md`, adapt, and tell Deb in one line.
3. **Start immediately.** All product decisions are already made (§17). Do not send Deb a questionnaire. Ask only when you are truly blocked and no default applies.
4. Write `docs/PLAN.md` (Phases 0–1: file layout, dependencies with versions and why, risks), then begin Phase 0 in the same session.
5. At the end of **each phase**: stop, demo what works (how to run it, what to look at), list what's broken, and wait for Deb's go-ahead.
6. Log every non-trivial decision in `docs/DECISIONS.md` (context → decision → consequences).

---

## 1. Ground rules (non-negotiable)

- **Clean-room originality.** Do NOT open, read, copy or adapt source, assets, sprites, layouts or schemas from: `honorstudio/claude-ville`, `pixel-agents` (any fork), `paulrobello/claude-office`, `pixtuoid`. Don't search for their code. **No pixel art.** Everything is designed from this spec and Claude Code's official docs.
- **Never slow Claude Code down.** Hooks are fire-and-forget, < 50 ms, always exit 0, and never change Claude's behavior (except the opt-in control features in Phase 5).
- **Local-only, private by default.** Bind `127.0.0.1` only. No telemetry. No network egress at runtime. Bundle fonts and assets.
- **Every movement means something.** A character moves, changes station or changes expression only because a real event happened. Small idle loops (breathing, sipping coffee) are allowed; random wandering is not.
- **Text lives in HTML, never in the 3D scene.** Name tags, bubbles' text, cards' text, panels and logs are DOM overlays anchored to scene positions.
- **Calm by default.** Light, clean, daylight office. No neon, no bloom, no glow effects.
- **Ask before adding heavy dependencies** (> ~200 KB gzipped or native modules).

---

## 2. Product concept

The screen is a cut-away isometric office floor (two back walls, open front, like a dollhouse). Each Claude Code session is a **teammate** with a name, shirt color and memory meter. Where they stand and what they hold tells you what they're doing:

- **Where** each teammate is working and on what kind of task
- **Who is free**, and how much **memory** (free context window) each one has left
- **Which task** each one is carrying, from a shared **mission board** on the wall
- **Who needs you**: they walk to your glass office door and raise a hand
- **What happened today**: replay with footprint trails and a timeline

### Cast

| Character | Real thing | Notes |
|---|---|---|
| **Boss (Deb)** | The user | Not drawn as a character. The glass "Boss office · You" is your space; your inbox is a screen. |
| **Lead** | Agent-team lead session | The manager. Stands at the mission board when splitting a request into tasks; has a desk next to it. |
| **Teammate** | Agent-team teammate, or an independent session | Full-size character. |
| **Intern** | Subagent (Task/Agent tool without a team) | 85% size, dashed-outline name tag, dashed tether line to its lead or parent. Leaves the office when done. |

Names: auto-generated, friendly, stable per session ID (e.g. Atlas, Juno, Rex, Mira, Kit, Bolt). If a teammate was given a name by the lead, use that name. The name tag's second line shows the task in a few words.

---

## 3. Users and success criteria

- **Primary user:** a developer running 1–10 Claude Code sessions or one agent team on one machine.
- **Success for v1:**
  - Deb keeps it open on a second monitor for 2+ weeks.
  - At a glance, Deb can answer: who is working, on what, who is idle, who is blocked, who is running out of memory.
  - A 15–30 s replay clip is fun enough to share.
  - Install is ≤ 3 steps. Zero measurable slowdown in Claude Code.

---

## 4. Data sources (verify all of this in the docs)

### 4.1 Hooks (primary)
Claude Code exposes many hook events. Ones AgentMissionFloor uses (confirm exact names and payloads):

- `SessionStart`, `SessionEnd`: teammate arrives / leaves the office
- `UserPromptSubmit`: Deb gave this session a request → mission card
- `PreToolUse`, `PostToolUse`, `PostToolUseFailure`: station changes, activity bubbles, errors
- `PermissionRequest`, `Notification`: someone needs Deb → walk to the boss door
- `Stop`, `StopFailure`: turn finished (idle / question for Deb) or failed
- `SubagentStart`, `SubagentStop`: intern arrives / leaves
- `TaskCreated`, `TaskCompleted`, `TeammateIdle`: mission board lifecycle for agent teams
- `PreCompact`, `PostCompact`: memory compaction → trip to the Archive
- `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`: optional context

Check whether an HTTP hook type exists. If so, prefer it over spawning a process per event.

### 4.2 Agent teams (the mission board engine)
Claude Code's experimental **agent teams** (enabled with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) already provide:
- a lead and teammates, each its own session with its own context window
- a shared task list with states pending, in progress and completed, plus dependencies
- teammates self-claiming the next unassigned, unblocked task after finishing one, with file-locked claiming
- on-disk state: the team config at `~/.claude/teams/{team-name}/config.json` (members) and the task list in `~/.claude/tasks/{team-name}/`

AgentMissionFloor **reads** these (hooks first, files for backfill and reconciliation). **Never write** to them: the format is internal and may change. Parse defensively, version-gate, and degrade gracefully if the shape changes.

Known limitations to reflect honestly in the UI:
- Teammates don't spawn in non-interactive (`-p`) mode.
- Task status can lag (a card stays "in progress" after its owner went idle). Show a **"stale?"** flag on such cards.
- There is one team per session and no nested teams.
- Teammate permission prompts surface in the lead's terminal.

### 4.3 Transcripts (enrichment)
Session transcript files (path is in hook payloads; verify) provide token usage for the memory meter, the last assistant message (a question for Deb), and backfill for events missed while AgentMissionFloor was down.

### 4.4 Memory meter
Memory free % = 1 − (context tokens used / context window size). Derive "used" from the latest usage data in the transcript, and the window size from the model in use (keep a small lookup table, logged in DECISIONS.md). If it can't be determined, show "—" rather than a guess.

---

## 5. Mission board flow

### 5.1 Team mode (agent teams enabled)
1. Deb types a request to the **Lead** in its terminal (`UserPromptSubmit`). The Lead walks to the mission board. A speech card shows a short version of the request.
2. `TaskCreated` → a sticky note pops onto **To do** (a small "pop" scale animation). A task with unfinished dependencies shows a padlock.
3. A teammate claims a task (status → in progress, with that teammate as owner). They walk to the board, take the card, and the card **attaches to their name tag**. Then they walk to the station that matches their first tool call.
4. While working, they move between stations as their tool calls change (§8). The card stays with them and also shows on their desk.
5. `TaskCompleted` → they walk back to the board, pin the card to **Done**, and a check-mark pops. The progress bar in the side panel advances.
6. `TeammateIdle` → if an unblocked card exists they take it (step 3). Otherwise they walk to the **Lounge** (coffee, "zz" bubble).
7. When all cards are Done, the Lead walks to Deb's door with a "Mission complete" card. This goes to the inbox with the Lead's final summary.

### 5.2 Solo mode (independent sessions, no team)
- Each `UserPromptSubmit` creates a card that is **already assigned** to that session (Deb assigned it by typing there). The character still walks to the board and takes it, for visual consistency.
- The session's own todo list, if it has one, appears as small sub-cards under the main card.
- `Stop` = card moves to Done. The character goes to the Lounge until Deb sends a new prompt.
- No automatic hand-off between independent sessions in v1. Do not build a custom dispatcher (e.g. feeding tasks via a blocking `Stop` hook) unless Deb asks; it's risky (runaway cost, file conflicts).

### 5.3 Card anatomy (DOM)
A sticky note colored by column: To do yellow `#ffe27a`, Doing pink `#ffc2d6`, Done green `#bfe8c4`. Each card carries:
- a short title (≤ 40 characters, from the task subject or the first line of the prompt)
- the owner avatar dot
- the age
- optional badges: padlock (blocked), "stale?", red corner (failed)

Clicking a card opens its detail: full text, owner, timeline and files touched.

---

## 6. The office layout

An isometric floor on a **20 × 14** grid with two back walls (along y=0 and x=0, height 3) and a cut-away front. Coordinates are grid units (x right-down, y left-down). The reference drawing `docs/reference/agent-mission-floor-office-reference.svg` shows this layout.

| Zone | Approx. grid area | Furniture | Meaning |
|---|---|---|---|
| **Mission board** | back wall y=0, x 2.6–8.6, height 1.05–2.65 | Wall board with 3 columns: To do / Doing / Done | Shared task list |
| **Lead desk** | in front of the board, x 2.6–5, y 1.6–2.4 | Desk + chair (add; not in the reference SVG) | Lead's home |
| **Dev desks** | x 3.4–9.1, y 4–7.6 (2 × 2 cluster) | Desks, monitors (with code lines), chairs | Edit / Write |
| **Library** | left wall x 0.1–0.75, y 1.6–7.8 | 3 tall bookshelves + reading armchair | Read / Grep / Glob / search |
| **Archive** | left wall x 0.1–0.8, y 7.9–9.3 | Filing cabinets | Memory compaction |
| **Window** | back wall x 9.3–11.9 | Window with sky | Web search / fetch |
| **Server room** | back wall x 13.1–17.2, y 0.1–1.0 | 3 server racks with status LEDs | Shell commands (non-test) |
| **Test lab** | x 12.9–16.9, y 2.5–3.5 | Bench, scope, monitor | Tests, debugging, build |
| **Planning** | x 10.5–13.1, y 6 | Standing whiteboard | Plan mode, briefing interns |
| **Lounge** | x 0.9–6.2, y 10.3–13.6 | Sofa, coffee table, coffee machine, water cooler, plant | Idle / ready for work |
| **Boss office · You** | x 13–19.9, y 9–13.9 | Glass walls (back + left, door gap at y 10.6–11.8), wood desk, empty chair, inbox tray, plants, "AI ORCHESTRATOR" on glass | Deb's space; door = approvals and questions |

Floor: light oak with plank lines; soft colored rugs mark zones. Walls: off-white. Plants are scattered for life. Seats and standing spots per station (grid): desk chairs at (4.7,5.6) (7.8,5.6) (4.7,8.2) (7.8,8.2); shelf (1.25,3.6); armchair (1.8,5.0); archive (1.3,8.6); window (10.6,1.3); rack (14.0,1.75); bench (14.2,4.2); whiteboard (11.8,6.9); coffee (1.1,11.2); sofa (2.05,12.4); cooler (6.9,11.3); boss door, outside (12.3,11.2); board (5.6,1.0).

**Scaling.** If there are more teammates than seats, add desks by extending the dev cluster (deterministic). If someone's station seat is taken, use the next free spot in that zone.

---

## 7. Visual style

- **Look:** clean, friendly, isometric vector office in daylight. Think architectural model meets a modern sim game. Soft shadows. **No neon, no bloom, no pixel art.**
- **UI theme:** light. Page `#f3f5f7`, panels `#ffffff` with border `#e3e7ec`, text `#1d2433`, secondary text `#5b6576`. Fonts: **Rubik** (UI) and **JetBrains Mono** (paths, code, numbers), bundled locally.
- **Teammate colors** (shirt + name dot), assigned stably per session: blue `#1f6feb`, purple `#b4329f`, orange `#e07b00`, green `#2e9d4f`, teal `#0e8f99`, light blue `#5aa2ff` (interns use a lighter tint of their lead's color).
- **State colors:** needs-you amber `#f2a900` / `#ffd34d`; error / failing red `#c4361b`; conflict `#d23d1f`.
- **Memory bar:** green above 50% free, amber 25–50%, red below 25%.
- **Characters:** simple, charming, low-detail people. Rounded torso in shirt color, darker arms, dark trousers, round head with a hair cap, and a soft ground shadow. Front view when facing the camera, back view (all hair) when facing a desk or bench. They sit at desks with the chair back in front of them. They walk with a light bob. They raise a hand at the boss door. They hold a mug in the lounge.
- **Status bubble** above each head: a white circle with a ring in the teammate's color (red when failing) and an icon. Icons: pencil (edit), magnifier (read/search), terminal `>_` (shell), bug (failing test/debugging), globe (web), clipboard (planning), box (archiving/compaction), "zz" (idle), "?" (question for Deb), "!" (needs approval; yellow bubble, bounces).
- **Name tag** (DOM pill): color dot, **Name** · activity, then a memory bar with "NN% free". Interns get a dashed border.
- **Small activity cards** near a desk or bench: e.g. `session.ts +42 −9` (dark code-style chip), `2 failing · run 3 of 3` (dark red chip).
- **Signature:** a tiny, deliberately unobtrusive "© Debaditya Chakravorty · Deb" in the bottom-right corner of the scene card (≈ 7–8 px, low-contrast `#b8bdc4`, DOM text, not selectable-looking UI). It is decorative, so it's exempt from the 4.5:1 contrast rule; it must never compete with real UI.
- **Accessibility:** never rely on color alone (icons + text everywhere), 4.5:1 text contrast, and `prefers-reduced-motion` (characters teleport instead of walking; no bouncing).

---

## 8. Event → visual mapping

| Event / state | Character behavior | Extras |
|---|---|---|
| Session starts | Walks in from the front edge to the board (team) or to a free desk (solo) | Name tag appears |
| Request submitted | Lead (or the solo session) goes to the board | Card pops onto To do |
| Task claimed | Walks to board, takes card, card attaches to name tag | Card moves To do → Doing |
| Edit / Write / MultiEdit / notebook edit | Sits at their dev desk, typing | Pencil bubble; `file +N −M` chip |
| Read / Grep / Glob / LS | Stands at library shelves (or armchair for long reads) | Magnifier bubble; file name chip |
| Bash: tests (`test`, `jest`, `pytest`, `vitest`…) | Test lab bench | Terminal bubble → bug bubble on failure, check on pass |
| Bash: other | Server room rack | Terminal bubble; command chip (redacted) |
| WebSearch / WebFetch | At the window | Globe bubble; domain chip |
| Plan mode / spawning subagent | Whiteboard | Clipboard bubble; intern appears beside them |
| Thinking (no tool call yet) | Stays put; subtle "…" bubble | — |
| Tool failure | Red bubble flash at station | Error chip; counts toward "errors today" |
| Context ≥ 75% used | Memory bar turns red; occasional "sigh" animation | — |
| Compaction | Walks to Archive, files papers, walks back | Box bubble; memory bar refills |
| Permission request / notification | Walks to boss door, raises hand | Yellow "!" bubble; office dims slightly; inbox badge; OS notification |
| Stop with a question in the last message | Walks to boss door | "?" bubble; inbox item quoting the question |
| Task completed | Walks to board, pins card to Done | Check-mark pop; mission progress advances |
| Teammate idle, no tasks | Walks to Lounge | "zz" bubble; memory bar visible |
| Two teammates editing the same file within N s | Both get warning outline; dashed red arc between them | Conflict item in inbox (§10.2) |
| Session ends | Waves, walks out the front edge | Footprints remain for replay |

**Movement:** walk on a grid navmesh around furniture (A* on a 0.25-unit grid, precomputed). Speed ≈ 2.5 grid units per second. Coalesce rapid tool calls: if a station would change for < 1.5 s, stay and just swap the bubble. That prevents ping-pong between stations.

---

## 9. Rendering approach

- **Three.js with an orthographic camera** (true isometric angle), WebGPU renderer with WebGL2 fallback. Furniture is procedural low-poly geometry (boxes, cylinders) built from a layout JSON. Using real 3D gives correct depth sorting, smooth zoom into close-ups, and soft shadows.
- **Lighting:** a warm directional "sun" through the window plus ambient light; soft shadow maps; tone mapping. **No bloom.**
- **Characters:** procedural low-poly (capsule body, sphere head, cap hair) with simple procedural animations (walk bob, sit, type, wave, raise hand). No external character assets.
- **DOM overlay** for every bit of text (name tags, bubbles' labels, cards on the board, chips), positioned by projecting 3D anchors each frame.
- **Camera:** default fixed isometric framing of the whole floor. Smooth zoom/pan. A "Follow" mode keeps a selected teammate centered. A close-up zooms ~2.4× onto a teammate's station.
- **State/render split:** a pure reducer turns the event stream into world state; the renderer reads that state. Replay reuses the same reducer.
- The mockups were drawn as flat SVG approximations. Match their composition, colors and readability, not their exact pixels.

---

## 10. Screens

Header on every screen: logo + "AgentMissionFloor", repo chip (`owner/repo · branch`), view tabs **Office floor · Your inbox (badge) · Replay**, and status on the right ("Live · 5 on the team · 4 working · 1 idle").

### 10.1 Office floor (default, live)
- **Left (main):** the office scene in a rounded card (16:10). Below it, a legend row of chips explaining stations: "Desk · editing code", "Library · reading & searching files", "Test lab · tests & debugging", "Server room · shell commands", "Window · web research", "Whiteboard · planning & briefing interns", "Archive · memory compaction", "Lounge · idle, ready for work", "Your door · needs your approval" (amber).
- **Right (side panel):**
  - **Today's mission:** the current request in quotes, plus a progress bar ("3 of 7 tasks").
  - **The team:** one row per teammate with avatar initial, name, task, current activity (mono) and memory %. Interns are indented with dashed borders. Clicking a row opens the close-up.
  - **Stat tiles:** tokens today, tool calls, waiting on you.

### 10.2 Your inbox
- The scene dims and desaturates slightly. The boss office floor gets a dashed amber outline. The teammate at the door bounces a big yellow "!". Other teammates are shown as grey dots labelled "still working".
- **Inbox items** (side panel):
  - **Approval:** who, the exact command or tool (redacted), why it's asking, their note, and **Approve / Deny** buttons. Opt-in Phase 5 feature; unanswered after 30 s, it falls back to Claude Code's normal prompt.
  - **Question:** the quoted last message, with "Reply in <name>'s terminal" (AgentMissionFloor does not inject prompts in v1).
  - **Conflict:** two teammates on one file, with a side-by-side diff and "Open in editor".
  - **Mission complete:** the Lead's summary.
- A "Desktop notification sent" toast and a "Meanwhile" list of who is still working.

### 10.3 Close-up (teammate profile)
- The scene zooms ~2.4× onto the teammate's station. A floating dark terminal card shows their latest relevant output (e.g. a failing test summary).
- **Side panel:**
  - header: avatar, name, session id, time on the job, state chip
  - **memory ring** (donut) with "NN% free" and plain-language advice ("When it fills, they go to the Archive to compact notes")
  - **current task** with checklist sub-steps
  - **on their desk:** files touched with "edited 3×" / "read 2×"
  - **last moves:** timestamped tool calls
  - buttons: Open transcript, Open file, Follow
- "← Back to the whole floor" link.

### 10.4 Replay
- Office scene with **footprint trails** (dotted lines in each teammate's color) between the stations they visited, numbered stops, and avatar markers at the playhead position. Labels for key moments ("Bolt waited 2m 14s", "Kit archived notes").
- **Side panel, end-of-day debrief:** mission tasks done, files touched, % team time working, time waiting on Deb, plus a **Jump to** list of moments.
- **Timeline** (full width below):
  - play/pause, clock (`17:05 / 18:22`), speed toggle (1× 4× 8× 30× 60×)
  - Highlight reel (auto 30 s) and Export clip (WebM of the scene)
  - one lane per teammate with colored blocks by station type (desk / library / lab-server / at your door / lounge) and a playhead line
  - a legend

---

## 11. Architecture

Monorepo (pnpm workspaces, TypeScript strict).

```
agent-mission-floor/
├── packages/
│   ├── protocol/    # versioned event schema, validators, fixtures
│   ├── plugin/      # Claude Code plugin: hooks, slash commands, marketplace manifest
│   ├── sender/      # tiny hook sender (fire-and-forget POST)
│   ├── collector/   # local daemon: ingest, normalize, redact, persist, team/task watcher, broadcast
│   ├── world/       # pure reducer: events → office state (who, where, carrying what, memory)
│   ├── viewer/      # Three.js office + DOM overlay UI
│   └── simulator/   # synthetic teams and sessions for dev, tests and demo mode
├── docs/ PLAN.md · DECISIONS.md · VISUAL_LANGUAGE.md · reference/agent-mission-floor-office-reference.svg
├── AGENT_MISSION_FLOOR_SPEC.md
└── CLAUDE.md
```

Data flow:

```
Claude Code ──hooks──▶ sender ──POST──▶ collector ──WS──▶ viewer
~/.claude/teams, ~/.claude/tasks, transcripts ──watch/backfill──▶ collector ──▶ SQLite
```

- **protocol:** every event has `id`, `ts`, `protocolVersion`, `source`, `sessionId`, `parentSessionId?`, `teamName?`, `agentName?`, `cwd`, `kind`, `tool?` (name, category, targets), `task?` (id, subject, status, owner, blockedBy), `outcome?`, `context?` (used, max, pctFree), `needsUser?` (approval/question), and `summary?` (redacted).
- **sender:** must not assume Node is installed (Claude Code can be installed natively). Evaluate a prebuilt single-file binary per OS vs `curl` vs Node, and recommend one in PLAN.md.
- **collector:**
  - binds 127.0.0.1 on a random port, with a token in `~/.agent-mission-floor/runtime.json` (0600)
  - normalizes events, runs **redaction** (keys, tokens, `.env` values, private keys)
  - SQLite persistence (14-day retention)
  - **team/task watcher** (read-only)
  - **conflict detector** (same file, two teammates, within N s)
  - single-instance lock and health endpoint
- **world:** deterministic. It maps events to station assignments (§8), applies coalescing rules, assigns seats, and tracks card ownership. It's unit-tested with fixture streams and state hashes.
- **simulator:** scripted scenarios: "team of 5 with dependencies", "solo sessions", "permission wait", "compaction", "conflict", "flaky test". It powers `npx agent-mission-floor --demo`.

---

## 12. Security & privacy
- Collector on 127.0.0.1 only. Token auth on HTTP and WebSocket. Reject foreign origins.
- `~/.agent-mission-floor/` is user-only. Redaction is mandatory and tested against a corpus of fake secrets.
- No CDNs or remote fonts at runtime.
- README section: what AgentMissionFloor sees, what it stores, where, and how to wipe it.
- Read-only toward Claude Code's own files (`~/.claude/...`). Control features (Phase 5) are opt-in and clearly labelled.

## 13. Performance budgets
- Hook overhead p99 < 50 ms.
- Collector < 80 MB RSS, < 2% CPU idle.
- Viewer at 60 fps with 12 characters on an M1-class laptop; ≥ 30 fps on integrated GPUs (shadows reduced).
- First render < 2 s.
- Perf HUD on the backtick key.

---

## 14. Phases (each ends with a demo + Deb's go-ahead)

**Phase 0 — Data truth.**
- Monorepo and tooling; CI on macOS and Linux.
- protocol, plugin + sender, collector (ingest, redaction, SQLite, team/task watcher, transcript backfill), simulator.
- A raw page with an event log and a per-session state table (station, task, memory %).
- *Accept:* 3 solo sessions plus one agent team. Every tool call shows within 200 ms; tasks and owners match Claude's task list; killing the collector doesn't affect Claude Code; restart backfills; redaction tests pass.

**Phase 1 — The office.**
- Layout JSON → Three.js office matching §6, with lighting and shadows.
- Characters that sit and stand at stations; the DOM overlay (name tags, bubbles, memory bars); the side panel (mission, team, stats).
- *Accept:* simulator team renders at 60 fps; a real session's teammate sits at a desk when editing and stands at the shelves when reading.

**Phase 2 — Movement & the mission board.**
- Navmesh walking with coalescing rules.
- Mission board cards (pop, claim, carry, pin to Done, padlock, "stale?").
- Lounge idle; Archive compaction trips; interns with tethers.
- *Accept:* a real agent team's tasks flow across the board, and teammates visibly pick up the next card after finishing one.

**Phase 3 — Your inbox & close-up.**
- Boss-door walk for permission/notification/question, with dimming, OS notification and inbox items.
- Conflict detection and inbox item.
- Close-up view with memory ring, checklist, files and last moves; Follow mode.
- *Accept:* Deb notices a waiting teammate within 5 s from across the room.

**Phase 4 — Replay.**
- Timeline lanes, footprints, jump-to list, speeds.
- WebM export and highlight reel.
- *Accept:* Deb exports a 30 s clip she'd post.

**Phase 5 — Control (opt-in).**
- Approve or deny from the inbox via the documented hook decision mechanism (verify `PreToolUse` / `PermissionRequest` decision fields), with a timeout fallback to the normal prompt.
- "Open file in editor".
- *Accept:* no deadlocks; disabling the feature fully restores default behavior.

**Phase 6 — Distribution.**
- Plugin marketplace repo (≤ 3-step install), `npx agent-mission-floor` + `--demo`.
- Evaluate a Tauri shell (tray, native notifications); note signing/notarization costs.
- Windows support.

---

## 15. Engineering standards
- TypeScript strict. Tests for protocol, redaction, world reducer, conflict detector and task reconciliation.
- Visual regression screenshots of simulator scenarios (Playwright).
- Small, conventional commits.
- `CLAUDE.md` with commands, structure and §1's rules.
- `docs/VISUAL_LANGUAGE.md` mirrors §7–§8 and stays in sync with code.
- MIT license (public after Phase 2).

---

## 16. Out of scope for v1
- Injecting prompts into running sessions or writing to Claude's task files.
- A custom task dispatcher for independent sessions.
- Multi-machine / remote sessions.
- Other CLIs (Codex, Gemini); design the adapter boundary only.

---

## 17. Decisions already made (do not re-ask)

| Topic | Decision |
|---|---|
| Concept | Isometric office; Deb is the boss; mission board = task list |
| Look | Light daylight vector style; no neon, bloom or pixel art |
| Engine | Three.js orthographic, WebGPU with WebGL2 fallback, DOM overlay for text |
| UI | React or vanilla is your call. Justify it in DECISIONS.md. |
| Fonts | Rubik + JetBrains Mono, bundled |
| Platforms | macOS + Linux first; Windows in Phase 6 |
| Runtime | Node 20+ OK for collector/viewer; the sender must not require Node |
| Delivery | Browser viewer launched by the plugin (`/agent-mission-floor:open`); Tauri later |
| Audio | Optional, off by default |
| Control features | Yes, opt-in, Phase 5 |
| Name | "AgentMissionFloor" (check npm/GitHub conflicts before publishing) |
| Repo visibility | Private until Phase 2, then MIT |

## 18. First message to Deb (do this now)
1. One line: "Read the spec; starting Phase 0."
2. Any spec facts that turned out wrong after checking the docs (bullet list, or "none").
3. Link to `docs/PLAN.md`, then start building Phase 0.

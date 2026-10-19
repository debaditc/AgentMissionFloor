# Decisions

Format: context → decision → consequences.

## D1 · Spec facts checked against code.claude.com/docs (2026-10-17, Claude Code 2.1.302)
- **Context:** §0 asks for the Claude Code facts in §4 to be verified.
- **Decision / findings:**
  - Every hook named in §4.1 exists. Payloads have `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and `agent_id`/`agent_type` inside subagents or teammates.
  - `TaskCreated`/`TaskCompleted` carry `task_id`, `task_subject`, `task_description?`, `teammate_name?` and `team_name?` (deprecated).
  - `TeammateIdle` carries `teammate_name` and `team_name`. `Stop` has `last_assistant_message`. `PostToolUseFailure` has `error`.
  - **There is no "task claimed" hook.** Claims are taken from `TaskUpdate` tool calls (`PreToolUse`) and the task-dir poll.
  - Team name is `session-` + the first 8 chars of the lead's session id. **The team config dir is deleted at session end; the tasks dir stays.**
  - **`WorktreeCreate` replaces default git behaviour.** Registering a hook on it would break worktrees, so we never hook it.
  - An `http` hook type exists (fixed URL, env-interpolated headers). See D2.
  - Context windows: 1M for Opus ≥ 4.7, Sonnet ≥ 5, Haiku 5.5 and Fable 5.x. 200K for Opus/Sonnet 4.6 unless `[1m]`, and 200K for unknown IDs (Claude Code's own default). `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` forces 200K.
- **Consequences:** The spec's §4 is accurate apart from the missing claim hook and the WorktreeCreate trap.

## D2 · Sender = async command hook running POSIX sh + curl (not an http hook, not a binary)
- **Context:** The sender must not require Node, and the hook must be < 50 ms and never block. `http` hooks need a fixed URL, but the spec wants a random port and a token. `http` hooks are also synchronous: Claude waits for the response.
- **Decision:** Every event is a `type: "command"` hook with `"async": true` that runs `scripts/amb-send`. It reads the URL and the auth header from files in `~/.agent-mission-board/`. The header is passed via `curl -H @file`, so the token never shows in `ps`. It POSTs stdin with `--max-time 1` and always exits 0. When the POST fails it writes the payload to a spool file.
- **Consequences:**
  - Claude never waits on us.
  - Async hooks can't return decisions, so Phase 5 approvals will need a separate synchronous `PermissionRequest` hook (opt-in).
  - Windows needs a twin in Phase 6.
  - Rejected: a single-file binary (signing and build matrix too early) and Node (not always installed).

## D3 · Node ≥ 22.18, built-in sqlite + type stripping, no build step
- **Context:** The spec says "Node 20+ OK". `better-sqlite3` is a native module, which §1 says needs approval.
- **Decision:** Require Node 22.18+. Use `node:sqlite` (`DatabaseSync`) and run `.ts` directly via Node's type stripping. `tsc` is used only for type-checking (`erasableSyntaxOnly`).
- **Consequences:**
  - No native modules and no bundler for the collector.
  - `node:sqlite` prints an ExperimentalWarning, which we suppress in the collector entry.
  - Node 20 isn't supported (it's EOL anyway).

## D4 · Actor identity
- **Context:** Hooks inside subagents and teammates carry the parent's `session_id` plus `agent_id`.
- **Decision:** The actor key is `session_id` or `session_id:agent_id`. An actor is a teammate if its `agent_id` or name is in a team config's `members`, otherwise an intern (subagent). The lead is the session that owns `session-<8>`.
- **Consequences:** Must be confirmed against a real agent team (no `~/.claude/teams` on this machine yet).

## D5 · Privacy: store shapes, not contents
- **Decision:**
  - We never store Write/Edit bodies, Read results or prompts in full. We store paths, line counts (`+N −M`), commands (redacted, ≤ 400 chars), URL host+path, prompts clipped to 200 chars (redacted; card titles are ≤ 40 of those) and a redacted tail of Bash output (≤ 600 chars).
  - Redaction runs before SQLite and WS.
- **Consequences:** Replay can't show file contents. That's by design.

## D6 · UI stack for the viewer: vanilla TypeScript (decided now so Phase 1 can plan)
- **Context:** §17 leaves the choice between React and vanilla to us.
- **Decision:** Vanilla TS with a tiny store and keyed DOM pools.
- **Consequences:** Overlays update every frame from projected 3D positions, and React reconciliation adds cost with nothing to gain at 60 fps. The panels are simple. This saves about 45 KB gzipped.

## D7 · Near-zero token cost
- **Context:** Deb asked that the plugin add as little Claude token cost as possible.
- **Decision:**
  - Hooks are async and print nothing, so nothing enters Claude's context.
  - The token is persisted (`~/.agent-mission-board/token`) and the last port is reused, so the board URL can be bookmarked.
  - `scripts/amb-open` / `pnpm open` open the board from your own terminal without a model turn.
  - `/agent-mission-board:open` has `disable-model-invocation: true`, so it isn't offered to the model each session, and its body is one line.
- **Consequences:** Watching costs 0 tokens. Using the slash command costs one short turn. The persisted token rotates only when the file is deleted.

## D8 · `idle_prompt` notifications don't send anyone to the door
- **Context:** Claude Code sends `idle_prompt` when a finished session has waited about 60 s for input.
- **Decision:** Treat it as idle (Lounge). Only permission prompts, elicitations and `agent_needs_input` count as needing Deb. Questions are detected from the last message on Stop.
- **Consequences:** Fewer false alarms at the door.

## D9 · Branding
- **Decision:** The glass label on the boss office reads "AI ORCHESTRATOR". A tiny low-contrast "© Debaditya Chakravorty · Deb" signature sits in the scene's bottom-right corner (spec §6/§7, reference SVG updated). Both will be DOM overlay text in Phase 1.

## D10 · Simulator team snapshots
- **Context:** The watcher reads real team files from `~/.claude`, which the simulator must never write to.
- **Decision:** With `x-amb-source: simulator`, `/v1/hook` accepts `{amb_simulator: "team"|"tasks", …}` payloads and parses them with the watcher's own parsers. Real hooks can't trigger this path, because the header comes from the simulator CLI and real payloads never carry `amb_simulator`.

## D11 · Recover events from senders killed mid-send
- **Context:** In a real `claude -p` run, the `Stop` event was lost. Claude Code kills async hooks at `-p` teardown, which left a half-sent `.tmp` file in the spool.
- **Decision:**
  - Every 5 s (and on start), the collector ingests orphaned `.<ms>-<pid>.tmp` files older than 2 s, alongside normal spool files.
  - Spool ids equal the live `X-AMB-Id`, so an event that was in fact delivered is deduplicated by the store's primary key.
  - The world ignores late events for actors who already left, apart from closing their card.
- **Consequences:** No lost Stops in `-p` mode. A recovered event can appear up to ~7 s late.

## D12 · Dormant sessions
- **Decision:** An actor that's idle with no events for 60 min is "away" (`isDormant`). It's hidden from the floor and counted separately. This covers sessions that end without `SessionEnd` (closed terminal, crash).

## D13 · Viewer bundle: three/webgpu ≈ 227 KB gzipped (just over the ~200 KB guideline)
- **Context:** §1 says to ask before adding dependencies over ~200 KB gzipped. §17 already chose Three.js with WebGPU and a WebGL2 fallback.
- **Decision:** Ship `three@0.186.1` via `three/webgpu`. Everything except fonts is one 818 KB (227 KB gzipped) chunk. Fonts are @fontsource Rubik and JetBrains Mono (OFL), bundled; the browser only downloads the latin subsets it needs.
- **Consequences:** This is a local page served from 127.0.0.1, so first render is dominated by parsing, not download. If it becomes a problem, the WebGL-only build (`three` core) would save roughly 60 KB.

## D14 · The collector serves the built viewer
- **Decision:** `packages/viewer/dist` (built with `npm run build`) is served at `/`, and the Phase 0 raw page at `/raw/`. Before the first build, `/` falls back to the raw page. Same origin, so the token cookie and WebSocket work unchanged, and there's no CDN.

## D15 · Collector shutdown has a hard deadline
- **Context:** An open browser tab kept `server.close()` waiting forever. The stuck process held the single-instance lock, so `npm run open` couldn't start a new collector.
- **Decision:** `close()` also calls `closeAllConnections()`, and `stop()` force-exits after 1.5 s, clearing the runtime files and lock first.

## D16 · Real agent-team shapes (verified against a live team, 2026-10-18), resolves D4
- **Findings:**
  - Team config members are `{name, agentId: "<name>@<team>", agentType}`, with no sessionId.
  - In-process teammates fire hooks with the **lead's** `session_id`, `agent_id: "a<name>-<hex>"` and `agent_type: "<name>"`.
  - `SubagentStart`/`SubagentStop` and `TeammateIdle` fire for teammates.
  - Each agent has `<transcriptDir>/<sessionId>/subagents/agent-<agentId>.jsonl` (all lines `isSidechain: true`) and `agent-<agentId>.meta.json` (`description`, `name`, `model`, `taskKind: "in_process_teammate"`, `teamName`).
  - Transcripts repeat the same `usage` on every content-block line of one message.
- **Decision:**
  - Match members by `agent_type === name`, by the `a<name>-` prefix, or by the `name@team` agentId.
  - Read `meta.json` read-only into an `agent.meta` event (assignment, name, model, teammate role).
  - Per-agent memory and token totals come from the agent's own transcript.
  - Totals are de-duplicated by `message.id` and read incrementally (`UsageLedger`).
  - A team without a task list shows progress as finished assignments.
- **Consequences:** Teammates are no longer shown as interns. Every person has an assignment, a model and consumption figures.

## D17 · Read-only shell commands count as reading
- **Context:** Real agents investigate code through Bash (`grep`, `rg`, `sed -n`, `git log`), so they looked like server-room work.
- **Decision:** A Bash command whose every pipeline segment is a known read-only command (and has no redirection, `xargs`, `rm` and the like) is category `read`. It goes to the library and shows "Searching code: …". Its output isn't stored at all.

## D18 · Person drill-down (`GET /v1/actor?key=`)
- **Decision:** An early version of spec §10.3's close-up, done now at Deb's request. It shows identity, model, assignment, the context ring, token totals (tokens only: Deb chose no $ estimate), files touched, last moves and tool mix, and for a lead the crew plus the team total. Built from stored events plus the transcript, read-only.

## D19 · "Modern, realistic, not messy, not slow" (Deb, 2026-10-18)
- **Context:** Deb found the stacked label cards messy and asked for a next-gen, realistic look, with performance kept in balance.
- **Decision, look:**
  - Calm daylight is kept (spec §1/§7: no neon, bloom or glow), but rendered as a realistic architectural model.
  - Image-based light (RoomEnvironment, prefiltered once), neutral tone mapping, and PBR roughness/metalness per material.
  - Rounded furniture edges and a procedural white-oak floor with grain.
  - Soft pre-baked contact shadows instead of SSAO, and a warm window-light patch on the floor.
  - A CSS studio-gradient backdrop behind a transparent canvas.
- **Decision, labels:** levels of detail instead of stacking.
  - Idle people get a status dot, working people a one-line pill, people who need you an amber pill, and hover or selection shows the full card.
  - When two labels would collide, the less important one shrinks to a dot.
  - Label sizes are cached so there's no per-frame layout thrash.
- **Decision, performance:**
  - Static furniture is merged into one mesh per material (hundreds of parts become a few dozen draw calls).
  - The sun's shadow map re-renders only when someone moves or the view changes.
  - Full frame rate only while something moves; a calm office renders at half rate.
  - Automatic quality fallback: if frames run slow, pixel ratio drops to 1 and the shadow map to 1024. The HUD (`) shows the tier.
- **Consequences:** No post-processing pass, so it stays cheap on integrated GPUs. Real SSAO or GTAO stays off the table unless profiling shows headroom.

## D20 · Phase 2 movement
- **Walking:**
  - `nav.ts`: A* on a 0.25-unit grid, obstacles from the layout inflated by a 0.2 body radius, no corner cutting, string-pulled into straight segments. A path takes ~0.13 ms; the grid builds in 0.2 ms and rebuilds only when overflow desks appear.
  - People enter and leave through the open front edge (`ENTRANCE`), and the glass office only through its door gap.
- **When people move:** `choreo.ts` (pure, tested).
  - A station change is walked only after it has held for 1.5 s (the label swaps at once).
  - The door and the mission board are urgent, and the board has a 1.2 s minimum dwell so taking or pinning a card is visible.
  - Walking speed is 2.5 units/s. Reduced motion teleports.
  - On page load everyone is placed where they are; only later arrivals walk in.
- **Sticky seats:** placement keeps people at their spot in a zone when others come and go.
- **Compaction:** walk to the Archive, then back to the previous station (`returnStation`).
- **Board:** cards are keyed DOM elements. New ones pop onto To do, moved ones pop into their column, and Done gets a check-mark pop. A carried card shows as a small sticky in the carrier's pill.
- **Interns:** a dashed SVG tether connects each intern to whoever briefed them, and interns spawn beside that person.

## D21 · Modern "Gen-Z" office decor (Deb, 2026-10-18)
- **Decision:** A pastel accent palette (sage, lilac, butter, peach, sky) on a white-oak and white base.
  - two-tone walls with a sage lower band
  - arched wall art and framed prints
  - pastel desk chairs and pots, matte-black desk legs, lighter wood
  - a lilac sofa, bean bags you can sit on, a mushroom floor lamp and a round checker rug
  - terrazzo in the AI Orchestrator's office
- **Constraints kept:** still calm daylight, no neon or emissive glow, no text in 3D. All pieces merge into the existing per-material draw calls.

## D22 · Café corner, ping pong, and a natural neutral look (Deb, 2026-10-18)
- **Café:** the lounge is now a café: a coffee bar against the left wall (espresso machine, grinder, cups), two bistro tables, the sofa and a floor lamp. Idle people fill the café tables first, in pairs facing each other. At a table of two or more, one person talks (free-hand gesture, small nod, chat icon) while the others listen (coffee icon); the speaker rotates every ~3 s.
- **Ping pong, exactly two players:**
  - Players are chosen only when at least two people are idle. Current players keep playing while they stay idle; otherwise the longest-idle people play.
  - A lone idler never plays, and everyone beyond two goes for coffee.
  - When one player gets work, the other continues with the next idle person, or goes to the café if there's none.
  - Rule in `placement.ts`, tested.
- **Not robotic (Deb):** each shot has its own pace (drive, lob, quick flat), angle and height. The receiver shuffles sideways to the ball and crouches deeper, winds up with a torso twist as it comes, snaps through and follows through, and both players' heads track the ball. Points end after a few shots with a short serve pause.
- **Look:** the pastel accents became natural neutrals (muted sage, linen, oat, clay, stone, charcoal) on white oak. The lounge rug is woven jute and the terrazzo uses neutral chips. Still calm daylight: no neon, no glow.
- **Layout and nav:** the ping pong table sits front-middle. The cooler and a plant moved so walkways stay open (nav tests guard this).

## D23 · People's names (Deb, 2026-10-18)
- **Decision:**
  - Auto names come from two equal lists: English (Emma, James, Olivia, Oliver, Sophie, Harry) and Indian, which are Deb's picks (Deb, Puja, Rahul, Parna, Reshmi, Raj).
  - **Balanced on the board:** each newcomer is named from whichever group has fewer people in the office right now (ties go by session hash, so names stay stable). Past twelve people, a name gets a letter suffix.
  - A first name the lead gives a teammate ("emma") is kept.
  - A role-like name ("security-reviewer") becomes a **handle** shown beside a friendly first name ("Ananya · security reviewer").
  - Task owners and TeammateIdle match either the name or the handle.
- **Consequences:** This deviates from spec §2's "if a teammate was given a name by the lead, use that name" for role-like names only, at Deb's request.

## D24 · Phase 3: your inbox, conflicts, close-up, Follow
- **Inbox:** `inboxItems(state)` is a pure world selector: approvals (command + tool), questions (the last message), mission complete (the lead's summary + mission) and conflicts from the last 30 min, newest first, with stable ids.
  - Dismissals are a per-browser convenience (localStorage).
  - The Inbox view dims and desaturates the scene (CSS filter, no extra 3D pass), outlines the AI Orchestrator's office in dashed amber, and greys out everyone who doesn't need you ("still working"). The side panel lists items plus a "Meanwhile" list.
- **Getting noticed from across the room (acceptance: within 5 s):**
  - an amber bouncing pill and a walk to the door
  - a `(n)` count in the tab title and an amber dot on the favicon
  - a desktop notification via the browser Notification API (opt-in button; when off, an in-page toast)
  - Notifications fire only for items that appear after the page loads.
- **Approvals:** answered in the agent's terminal. Approve/Deny from the inbox is Phase 5 (opt-in), as the spec says.
- **Conflicts:** the collector's `ConflictDetector` fires when two different people (teammates count separately) edit the same file within 2 min, once per file, pair and window. It emits a `conflict` event (stored, so replay shows it). The office shows red outlines and a dashed red arc between the two, and the inbox shows both edits' line counts and "Open in editor" (`vscode://file…`).
  - We don't store file contents (D5), so there's no side-by-side diff; the editor link is the way to the diff.
- **Close-up (§10.3):** selecting zooms ~2.4×, and a dark terminal card shows the person's latest shell or test output (redacted, ≤ 600 chars, from `/v1/actor` `lastOutput`). Drawer actions are Follow (the camera tracks them; any drag or Esc stops it) and Open file.

## D25 · Phase 4: replay
- **Data:** `GET /v1/events?since=&until=` (≤ 50k events, oldest first). The viewer replays them through the **same pure reducer** (`buildReplay`/`stateAt` in world), with checkpoints every 200 events so seeking is instant. A test proves seeking equals a straight replay.
- **Playback:** a virtual clock at 1×/4×/8×/30×/60×. People walk at virtual speed so they keep up. A seek places everyone instantly and clears trails. Key moments float a short note above the person as playback passes them.
- **Analysis:** lanes per person (desk / library & window / lab & server / at your door / café & ping pong), drawn on one 2D canvas; click or drag to seek.
  - Moments: arrived, waited (> 5 s), archived notes, task finished, failed, conflict, mission complete, left.
  - Debrief: tasks done, files touched, % team time working, time waiting on you, tool calls.
  - Idle stretches cap at the 1-hour dormant rule so a forgotten session doesn't swamp the day.
- **Footprints:** one InstancedMesh of small floor dots in each person's color (a dot every 0.35 u walked, a bigger one at each stop). Cleared on seek.
- **Highlight reel:** the whole day in 30 s. **Export clip:** MediaRecorder on a 2D canvas that composites the 3D frame plus name pills, a timestamp and the signature (the 3D canvas has no text, by design). Saved as WebM.
- **Deep links:** `?view=inbox|replay`, and for replay `&at=0..1&speed=N&play=1`.

## D26 · Deb, the AI Orchestrator, is drawn in the office (Deb, 2026-10-18)
- **Context:** Spec §2 said the boss isn't drawn as a character. Deb asked for "a person named Deb who is the manager/orchestrator", always in the AI Orchestrator's office working on something.
- **Decision:**
  - A viewer-only character (`__deb`, never in world state) sits at the glass-office desk typing.
  - When anyone is waiting (approval or question), Deb walks to the inside of the door and faces them with a listening nod. The label reads "Listening to <first in line>" or "N waiting on you" (amber). Once nobody waits, Deb walks back to the desk (the 1.5 s coalescing applies).
  - Deb never leaves the glass office. Clicking Deb opens the Inbox.
  - Deb also appears in exported clips and in replay (driven by the replayed state).
  - "Deb" is removed from the agents' name pool (`HUMAN_NAME`). A lead-given "deb" also gets a different name. The name lists are now 5 English + 5 Indian (Puja, Rahul, Parna, Reshmi, Raj), still balanced on the board.

- **Update (Deb, 2026-10-18):** the name lists are now English: Harry, Ron, Hermione, David, Sophie; Indian: Puja, Parna, Reshmi, Rajan, Raj. Still balanced on the board, and "Deb" is still reserved.

## D27 · Security hardening from our own reviews (2026-10-18)
- **Context:** Two internal reviews (phase-1 and phase-3-4) found no critical issues but several medium and low ones. All are fixed before the repo goes public, each with a test.
- **Decisions:**
  - **Redact before clipping** (M1, M2). Redaction moved into `protocol` so the normalizer redacts *then* clips, and a secret can't be cut in half and slip through. The collector redacts again before storage.
    - Every quantifier is bounded and input is capped at 64 KB, so hostile 1 MB strings stay fast (tested).
    - New coverage: `*_PASS`, `*_KEY`, Azure `AccountKey`, `mysql -p…`, `whsec_`, Cookie/Set-Cookie, secret query parameters (`sig`, `api_key`, `access_token`, …) and URL-encoded secrets.
    - Every hook field is length-bounded (names 128, paths 1,024).
  - **The token never goes in a URL or into Claude's context** (M4). `amb-open` gets a **one-time sign-in code** (2 min, single use) from `POST /v1/login-code` (bearer only), and the browser trades it at `/login?code=` for the cookie. `/…:open` replies "Opened the board".
    - The legacy `/?token=` handoff still works for old links, but nothing prints it.
    - `?token=` is no longer accepted on API routes (only the WebSocket upgrade and the page handoff).
  - **The cookie is scoped by port** (`amb_token_<port>`, legacy name still accepted) and lasts a year (`Max-Age=31536000`) so a bookmarked plain URL survives browser restarts.
  - **Sender and opener only talk to the real collector** (M-B): the pid in `runtime.json` must be alive (`kill -0`), and the opener also checks `/health` reports this app. Both find the collector relative to the script, never the cwd (M5).
  - **Smaller spool** (M3): ≤ 64 KB per event and ≤ 2,000 files (≈128 MB worst case, down from ≈5 GB). Files are user-only and deleted once read.
  - **Hook input can't steer file access or crash the collector** (M-A, L-A):
    - Transcript paths must be absolute `.jsonl` files inside `~/.claude` (or the simulator's temp folder).
    - Agent and session ids must match `[A-Za-z0-9_-]{1,128}` before they're used in a path.
    - Ledger reads never throw, and the HTTP handler turns any failure into a 500.
  - **Low items:**
    - `/health` checks Host too.
    - The collector runs with `umask 077`, so the DB, WAL and SHM are user-only.
    - CI also builds the viewer.
    - Tests poll instead of using fixed sleeps where timing mattered.
    - The tautological spool test was fixed.
    - A `hooks.json` test enforces async-only hooks and no WorktreeCreate/Remove.

## D28 · Effortless install, and the rename to agent-mission-floor (2026-10-18)
- **Context:**
  - Installing took pnpm (which most people don't have) and a `--plugin-dir` flag on every Claude start.
  - The internal id still said "board" while the product is AgentMissionFloor.
- **Decisions:**
  - **npm workspaces only.** pnpm and its lockfile are gone (`"*"` internal deps, `package-lock.json`). A `postinstall` builds the viewer, so `npm install` leaves a working office.
  - **`npm run setup`** registers the clone as a local marketplace (`.claude-plugin/marketplace.json`) and installs the plugin through Claude Code's own `claude plugin` commands. Syntax was checked against the CLI help and the marketplace reference; `claude plugin validate .` passes. We never edit `~/.claude` ourselves.
  - **An installed plugin is a cached copy**, so it can't find the collector next to itself. `setup` writes `~/.agent-mission-floor/install.json` with the repo path, and `amb-send`/`amb-open` fall back to it. This was verified end to end in an isolated `CLAUDE_CONFIG_DIR`: install, the cached sender auto-starts the collector, the session appears, and `uninstall --purge` leaves nothing behind.
  - **CLI** (`packages/cli`):
    - `doctor` shows ✓/✗ with a one-line fix for each check.
    - `demo` runs a throwaway office in a temp folder; Ctrl+C deletes it.
    - also `status`, `stop` and `uninstall [--purge]`.
  - **Rename:**
    - `@agent-mission-floor/*`, plugin `agent-mission-floor` (so `/agent-mission-floor:open`).
    - Data folder `~/.agent-mission-floor`, moved once from `~/.agent-mission-board`, so the token, port and bookmark keep working.
    - `AMF_*` settings, with `AMB_*` still read. The wire headers (`X-AMB-*`) and script names stay as they are; they're internal.
  - **`ws` 8.18 → 8.22** (`npm audit`: two high advisories, GHSA-58qx-3vcg-4xpx and GHSA-96hv-2xvq-fx4p). Exposure was low: the socket only serves authenticated local clients, with a 64 KB message cap.
- **Consequences:**
  - After `git pull`, run `npm install && npm run setup` again to refresh the cached plugin.
  - A GitHub-only install (`/plugin install … --marketplace debaditc/AgentMissionFloor`) would bring the hooks without the collector, so it waits for the `npx` launcher (Phase 6).

## D29 · Finished work is marked, on the person and on the board (2026-10-18)
- **Context:** Deb: "when an agent is done with the work… mark it… else hard to tell when agent is done", or "put that in the mission board that the task x, y, z are done". A finished agent just turned idle, which looks the same as one that never started. Interns (subagents) and teammates spawned without a task list never had a card at all.
- **Decisions:**
  - **The world records `finished: { what, ts }`** when someone completes work:
    - a solo request closes;
    - a teammate finishes a task-list card;
    - a teammate or intern stops (SubagentStop, TeammateIdle);
    - the lead's mission completes.
    - It's cleared as soon as they start something new (a prompt, a tool call, a new briefing), so "Done" never lingers over real work.
  - **Assignment cards:** an intern's or teammate's assignment becomes a card they carry and pin to **Done** when finished (`Card.assignment`).
    - Teams with a real task list don't get these; if a task list appears later, the assignment cards for that team are removed.
    - These cards count toward mission progress, so a team without a task list completes its mission the same way.
  - **On screen:**
    - The person's label gets a solid green ✓ and says "Done" ("Done, having a coffee"), with the finished task underneath. Labels stay full pills, not dots, so finished people stand out.
    - Done notes on the board name who finished them ("✓ Olivia").
    - The team panel shows a "✓ Done" pill and "finished 3 min ago".
    - A toast says "✓ Ron finished: Fix the login bug". When the tab is in the background and notifications are on, a quiet desktop notification is sent as well. Nothing fires for work finished before the page loaded.
- **Consequences:**
  - Replay shows the same marks, since it uses the same reducer.
  - The colour is a calm green: no glow, and amber stays reserved for "needs you".

## D30 · Names stay unique even when the lead picks one (2026-10-18)
- **Context:** The lead arrived first and got an automatic name ("Harry"). Then the team roster named a teammate "harry", and a name chosen by the lead always won, so two people were called Harry.
- **Decision:**
  - A first name the lead gives is kept only if nobody in the office already has it.
  - Otherwise the newcomer gets a free name from the balanced lists (D23), and the lead's name is kept as a hidden `alias`.
  - Task owners, TeammateIdle and messages addressed to that name still reach the right person. Within the team, the alias wins over a different person who has that name.
  - Whoever was already on screen keeps their name: nobody is renamed in front of you.

## D31 · Pre-release security pass (2026-10-19)
- **Context:** Before the first push to GitHub we checked:
  - every commit on every branch for secrets and personal data;
  - dependencies (`npm audit`);
  - the server, the viewer and the scripts, by hand.
- **Found and fixed:**
  - **The collector printed the long-lived token in a URL** (`npm run collector`, and its "already running" message). It now prints a one-time `/login?code=` link instead, and nothing ever prints the token.
  - **The token is no longer accepted in a URL at all:**
    - The legacy `/?token=` page handoff (D27) is removed.
    - `?token=` is no longer accepted on the WebSocket either.
    - Sign-in is a one-time code → cookie; scripts use the `Authorization` header. Old token links now get the "run `npm run open`" page.
  - **Security headers on every response:** `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'` (no clickjacking), `Referrer-Policy: no-referrer` (the one-time code never leaks), COOP/CORP same-origin, and `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`.
  - **Editor links** (`vscode://file…`) encode the path, so a hostile file name can't add URL parts. The memory ring renders only numbers.
- **Checked and fine:**
  - no tokens, keys, private keys, `.env` files, databases or home paths in history; `npm audit` reports 0;
  - SQL is parameterised; subprocesses are spawned without a shell;
  - static files can't escape the build folder; token comparisons are timing-safe;
  - request bodies are capped and read only after auth; the cookie is HttpOnly + SameSite=Strict;
  - agent text reaches the page only as text.
- **Left to the owner:** older commits carry the machine's default git email; rewrite them before the first push.

## D32 · Security officer review: our own tools, size limits, supply chain (2026-10-19)
- **Context:** A second, adversarial pass, working from a threat model:
  - a malicious website;
  - another user account on the same machine;
  - hostile content reaching the hooks (prompt injection);
  - the supply chain;
  - our own CLI misbehaving.
  A live attack run against an isolated collector blocked all 22 attempts: traversal, encodings, DNS rebinding, CSRF, `Origin: null`, token guessing, unauthenticated WebSocket, oversized and malformed bodies.
- **Found and fixed:**
  - **`stop` and `uninstall` could kill an unrelated process** if the pid in `runtime.json` had been reused after a crash. Now a process is only signalled if `/health` answers as our collector with that pid.
  - **`uninstall --purge` deleted the whole data folder** (`rm -rf $AMF_HOME`), so a mistaken `AMF_HOME=~` would have wiped the home folder. Now it deletes only the files we create, refuses `/`, home, the repo and `~/.claude`, and removes the folder only if it's empty.
  - **Size limits:**
    - The sender writes at most 2 MB of a payload to disk; the rest is drained, never written.
    - The collector drops spool files over 2 MB unread, including leftovers from killed senders.
  - **Shared `/tmp` (Linux):** the simulator and the collector use `amb-sim-transcripts` only if this user owns it.
  - **CI:**
    - `permissions: contents: read`;
    - actions pinned to commit SHAs;
    - `persist-credentials: false`;
    - a 15-minute timeout;
    - `npm audit --audit-level=high` fails the build.
  - **`SECURITY.md`** explains private reporting, the protections and the known limits.
- **Accepted (documented):**
  - Redaction is pattern-based.
  - Payloads touch disk for milliseconds (so nothing is lost when the collector is down).
  - `style-src 'unsafe-inline'` stays, because labels are positioned with inline styles. Scripts are still `'self'` only.

## D23 update · Indian names (2026-10-19)
- Deb's picks: Puja → **Bini**, Parna → **Moon**, Reshmi → **Rinchi**.
- Indian list is now Bini, Moon, Rinchi, Rajan and Raj. English is unchanged: Harry, Ron, Hermione, David and Sophie.

## D33 · UI round: readable board, bigger office, team by what matters, away digest, project filter (2026-10-19)
- **Context:** The wall board was unreadable at normal zoom, chrome (legend row, stat tiles, a 16:10 card) competed with the office, the team list was in arrival order, coming back gave no idea what happened, and several repos showed as one office.
- **Decisions:**
  - **Board sheet** (`boardsheet.ts`): click the wall board, the mission bar or press **B** to open a flat, full-size To do / Doing / Done view.
    - It shows every card, its owner, and "✓ Name, N min ago" on Done cards, newest first.
    - Clicking an owner selects them.
  - **The office fills the window:** the side panel scrolls on its own. **Focus mode (F, or `?focus=1`)** shows only the office, for a wall display.
  - **The legend row is gone:**
    - Hovering the floor names the place and what it means (`zones.ts`, from the layout's spots and rugs).
    - A one-time "How to read the office" card appears, and can be reopened with **?**.
  - **Header:** presence dots (amber = needs you, green ✓ = done) replace the "N on the team" text. Raw moves to a panel footer link.
  - **Panel** (`team.ts`, pure and tested):
    - Groups people as Needs you (longest waiting first), Working, Done (newest first), and Idle (collapsed).
    - Each row is one plain sentence plus a thin memory bar.
    - The mission is shown as a headline with a segmented bar (one segment per task) and a compact "Today" line. It's one continuous surface, not stacked cards.
  - **While you were away** (`digest.ts`):
    - After 15+ minutes away (tracked per browser in `localStorage`), one card lists missions completed, tasks finished (by whom), who waited and for how long, and failures.
    - It offers **Show the board** and **Replay it** (starts the replay where you left).
    - People are referenced by key, with names taken from the live office.
    - Replay moments now carry structured `what`/`ms`, and a "task" moment fires for **any** card reaching Done.
  - **Project filter:** `projectOf` / `projectsIn` / `filterByProject` (pure, world) narrow the whole view to one project's people, cards and missions.
    - The header chip becomes a picker when 2+ projects are live; the choice is remembered in the URL and `localStorage`.
    - The inbox badge still counts everyone, so nothing that needs Deb is hidden.
- **Consequences:**
  - No new dependencies, and the scene is no heavier.
  - Checked with headless-Chrome screenshots driven over the DevTools protocol, in an isolated demo.

## D34 · Background agents that are stopped leave the office (2026-10-19)
- **Context:** Deb stopped three background reviewers ("can you stop the work"), but the board kept showing them mid-command. Claude Code sends no SubagentStop for an agent killed by `TaskStop`.
  - It does send the lead's `TaskStop` PostToolUse (with `task_id`).
  - It also feeds the lead a `<task-notification>` "prompt" with the agent id and a status. Those notifications were being treated as Deb's requests.
- **Decisions:**
  - **Normalizer:**
    - `TaskStop`/`KillShell` keep the target id.
    - A `<task-notification>` prompt becomes `notice: { taskId, status }`. Only the id and status are kept, never the output path or the text.
  - **Reducer `endAgent`:**
    - A stop (TaskStop, or any non-`completed` notice) ends the agent: interns leave with "stopped", teammates go idle with "Stopped".
    - The unfinished assignment card is taken down, and no ✓ Done mark is given.
    - A `completed` notice counts as done (✓, card pinned to Done).
  - **Notices never create cards or missions:** the lead shows "reading a report".
- **Test:** the real sequence (three background agents, three `TaskStop` calls, three `killed` notifications) is replayed in `world.test.ts`.

# Visual language

This mirrors spec §7–§8. Keep it in sync with the code: `viewer/src/scene/*`, `overlay.ts`, `placement.ts`, `styles.css`.

## Look
- Daylight architectural-model realism (D19): image-based light, neutral tone mapping, PBR materials, rounded furniture, pale white-oak floor, soft contact shadows, warm window light on the floor, studio-gradient backdrop. A true-isometric orthographic camera, warm sun through the window (back wall) plus hemisphere fill, soft PCF shadows, ACES tone mapping. **No bloom, no neon, no glow, no pixel art.**
- Natural neutral palette (D22, supersedes D21's pastels): muted sage `#c3cdb9`, linen `#ddd3c3`, oat `#e6dccb`, clay `#d8b9a3`, stone `#a9b8c2`, charcoal `#3c3f44`. Café corner + ping pong table. (Earlier D21 pastel accents sage `#b7d3c0`, lilac `#cdbfe8`, butter `#f5e2a0`, peach `#f6c3ae`, sky `#bcdcf2` on white oak and white; two-tone sage walls, arch art, bean bags, checker rug, terrazzo.
- Floor: pale white oak with grain. Walls: off-white. Rugs mark zones (dev `#dfe7ef`, library `#f0d9b5`, lab `#e3ece3`, lounge `#f2dcb8`, AI Orchestrator `#e7e1f0`).
- UI: page `#f3f5f7`, panels `#fff` with border `#e3e7ec`, text `#1d2433` / `#5b6576`. Fonts are bundled: Rubik (UI) and JetBrains Mono (paths, numbers).
- **All text is DOM.** Wall text (mission board, "AI ORCHESTRATOR" on the glass) is a DOM element mapped onto the wall plane with an affine CSS matrix (orthographic projection is affine).
- Signature: "© Debaditya Chakravorty · Deb", 7.5 px, `#b8bdc4`, bottom-right of the scene card. Decorative, so exempt from the contrast rule.

## People
- Team colors, stable per session: `#1f6feb #b4329f #e07b00 #2e9d4f #0e8f99 #5aa2ff`. Interns use a lighter tint of their parent's color, are drawn at 85% size, and get a dashed tag.
- Body: capsule torso in shirt color, darker sleeves, dark trousers, sphere head with a hair cap set back (front view shows a face, back view all hair), soft ground shadow. Skin and hair are picked by hashing the session.
- Poses: **sit** (desk chair, armchair, sofa) or **stand**. Props: typing arms at a working desk, raised hand at the door, mug in the lounge, papers at the archive. Idle breathing only, never random wandering.
- People **walk** (Phase 2): A* paths around furniture at 2.5 u/s with a walk cycle (legs and arms swing, light bob), turning toward their heading; they enter and leave through the front edge. A station change is walked only after it holds for 1.5 s; the door and the board are urgent. With `prefers-reduced-motion`: no glide, no breathing, no bouncing.

## Overlay
- **People** are drawn at 1.35× furniture scale (interns 85% of that), with a ground ring in their team color. The selected person gets a second, dark ring.
- **Levels of detail:** idle people show a status **dot**, working people a one-line **pill** (name · activity), people who need you an **amber pill**, and hover or selection shows the full **card**. Labels never stack; on collision the less important one shrinks to a dot.
- **Label** above the head (merges the bubble and the name tag): a status icon, **Name** · plain-language activity ("Reading session.ts", "Searching code: grep …", "Messaging the lead"), the assignment (✓ when done), and the memory bar. A thin leader line connects a pushed-up label to its head. Click a label, a person or a team row to open the drill-down.
- **Status icon** in the label: white circle ringed in the person's color, with an icon: pencil (edit), magnifier (read), `>_` (shell/test), bug (failing, red ring), check (passed), globe (web), clipboard (planning), box (archive), "zz" (idle), "?" (question, amber), "!" (needs approval, yellow, bounces), "…" (thinking), × (error, red). Every bubble has an aria-label and title, so meaning never rests on color alone.
- **Name tag** under the feet: color dot, **Name** · activity, the current task's title, and a memory bar with "NN% free" (green > 50, amber 25–50, red < 25; "—" when unknown). Idle people get a compact tag (name and memory only). Tags never overlap: they're placed front to back, each pushed down past any tag already placed.
- **Activity chip** next to the person: dark code chip (`session.ts +42 −9`, a command) or a dark red error chip.

## Stations (§8)
| Activity | Station | Pose |
|---|---|---|
| Edit / Write / MultiEdit / NotebookEdit | own desk (lead: lead desk) | sit, typing |
| Read / Grep / Glob / LS | library shelves (armchair once two people are at the shelves) | stand / sit |
| Bash: tests | test lab bench | stand |
| Bash: other | server room rack (LEDs blink while someone works there) | stand |
| WebSearch / WebFetch | window | stand |
| Plan mode / spawning an intern | whiteboard | stand |
| Task tools / taking a card | mission board | stand |
| Compaction | archive | stand, papers |
| Idle | café (tables in pairs, chatting) or ping pong (exactly two players) | standing with a mug / paddle; sofa |
| Needs approval / question / mission complete | AI Orchestrator's door | stand, hand raised |

Seats: first free spot in the zone, in order of arrival. A full zone overflows into a deterministic ring of extra spots. Overflow desks appear only when someone is assigned to them.

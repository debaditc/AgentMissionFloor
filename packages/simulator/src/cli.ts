// `npm run sim -- [scenario…] [--speed N] [--loop] [--list]`: plays scenarios into the running collector.

import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setting } from '@agent-mission-floor/protocol';
import { buildScenario, SCENARIOS, usageLine, type Step } from './index.ts';

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const [name, make] of Object.entries(SCENARIOS)) console.log(`${name.padEnd(11)} ${make({ runId: 'x', transcriptDir: '' }).description}`);
  process.exit(0);
}
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const speed = Math.max(0.1, Number(flag('--speed') ?? 1));
const loop = args.includes('--loop');
const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--speed');
const chosen = names.length ? names : ['team'];

const home = setting('HOME') ?? join(homedir(), '.agent-mission-floor');
let url: string;
let auth: string;
try {
  url = readFileSync(join(home, 'sender.url'), 'utf8').trim();
  auth = readFileSync(join(home, 'sender.headers'), 'utf8').trim().replace(/^Authorization:\s*/i, '');
} catch {
  console.error('No running collector found. Start it first: npm run open (or try: npm run demo)');
  process.exit(1);
}
const transcriptDir = join(tmpdir(), 'amb-sim-transcripts');
mkdirSync(transcriptDir, { recursive: true, mode: 0o700 });
// On a shared /tmp another user could create this folder first: only use it if it's ours.
const owned = lstatSync(transcriptDir);
if (!owned.isDirectory() || (process.getuid && owned.uid !== process.getuid())) {
  console.error(`${transcriptDir} belongs to someone else; not using it.`);
  process.exit(1);
}
chmodSync(transcriptDir, 0o700);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(payload: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json', 'x-amb-source': 'simulator', 'x-amb-ts': String(Date.now()) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`collector replied ${res.status}`);
}

async function play(steps: Step[]) {
  const start = Date.now();
  for (const step of steps) {
    const due = start + step.at / speed;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    if (step.usage) appendFileSync(join(transcriptDir, `${step.usage.session}.jsonl`), usageLine(step.usage.used, step.usage.model, Date.now()) + '\n');
    if (step.payload) await post(step.payload);
  }
}

let run = 0;
do {
  run++;
  const runId = `sim${Date.now().toString(36)}`;
  await Promise.all(
    chosen.map(async (name) => {
      const sc = buildScenario(name, { runId: `${runId}${name.slice(0, 2)}`, transcriptDir });
      console.log(`▶ ${name}: ${sc.description} (${sc.steps.length} steps, ~${Math.round(sc.steps.at(-1)!.at / speed / 1000)}s)`);
      await play(sc.steps);
      console.log(`✓ ${name}`);
    }),
  );
} while (loop);

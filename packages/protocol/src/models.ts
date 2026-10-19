// Context window lookup (verified 2026-10-17 against code.claude.com/docs/en/model-config; see DECISIONS D1).

const ONE_M = 1_000_000;
const TWO_HUNDRED_K = 200_000;

/** Returns the context window size for a model id, or null when unknown. */
export function contextWindowFor(model: string | undefined, opts: { disable1m?: boolean } = {}): number | null {
  if (!model) return null;
  const id = model.toLowerCase();
  if (opts.disable1m) return TWO_HUNDRED_K;
  if (id.endsWith('[1m]')) return ONE_M;
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m) return null;
  const family = m[1];
  const major = Number(m[2]);
  // Date-suffixed ids (claude-sonnet-4-20250514) carry no minor version.
  const minor = m[3] && m[3].length < 3 ? Number(m[3]) : 0;
  const v = major + minor / 10;
  if (family === 'fable') return ONE_M;
  if (family === 'opus') return v >= 4.7 ? ONE_M : TWO_HUNDRED_K;
  if (family === 'sonnet') return v >= 5 ? ONE_M : TWO_HUNDRED_K;
  if (family === 'haiku') return v >= 5.5 ? ONE_M : TWO_HUNDRED_K;
  return null;
}

/** Memory free % = 1 − used / max, clamped; null when the window is unknown. */
export function pctFree(used: number, max: number | null): number | null {
  if (!max || max <= 0 || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round((1 - used / max) * 100)));
}

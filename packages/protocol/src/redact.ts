// Mandatory redaction (spec §12). Runs on every free-text string *before* it is clipped (so a
// secret can't be cut in half and slip through) and again in the collector before storage.
// Patterns favour false positives over leaks. Every quantifier is bounded, so hostile input
// can't trigger catastrophic backtracking; inputs are capped at MAX_SCAN characters.

export const REDACTED = '[REDACTED]';

/** Strings longer than this are cut before scanning (callers clip far shorter anyway). */
export const MAX_SCAN = 64 * 1024;

const PATTERNS: RegExp[] = [
  // Private key blocks (PEM / OpenSSH), including truncated ones.
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
  // Vendor tokens.
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bwhsec_[A-Za-z0-9+/=]{16,}/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

// Credentials inside URLs: scheme://user:pass@host → scheme://[REDACTED]@host
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/gi;

// Secret-looking query parameters (Azure SAS `sig=`, `access_token=`, `api_key=`, …).
const QUERY_SECRET = /([?&](?:sig|signature|token|access_token|refresh_token|id_token|api_key|apikey|key|code|password|secret)=)[^&\s"'#]{1,2048}/gi;

// Authorization headers / bearer tokens.
const BEARER = /\b(bearer|token|basic)(\s+|=)([A-Za-z0-9._~+/=-]{12,})/gi;

// Cookie headers carry session secrets wholesale.
const COOKIE = /\b((?:set-)?cookie\s*:\s*)[^\n]{1,4096}/gi;

// mysql / mariadb password glued to -p (`mysql -uroot -phunter2`).
const MYSQL_P = /\b((?:mysql\w{0,10}|mariadb\w{0,10})\b[^\n]{0,400}?\s-p)(?=[^\s-])([^\s'"]{1,256})/gi;

// KEY=value / "key": "value" / --flag value assignments whose *name* looks secret. Names are
// bounded ({0,40}) so the scan stays linear.
const NAME_CORE =
  '(?:secret|token|passw(?:or)?d|passphrase|pwd|pass|api[_-]?key|apikey|private[_-]?key|access[_-]?key|accountkey|auth|credential|session[_-]?key|signing[_-]?key|[_.-]key|dsn)';
const SECRET_NAME = `[A-Za-z0-9_.-]{0,40}${NAME_CORE}[A-Za-z0-9_.-]{0,40}`;
const ASSIGNMENT = new RegExp(`\\b(${SECRET_NAME})(\\s{0,4}[=:]\\s{0,4})("[^"\\n]{0,2048}"|'[^'\\n]{0,2048}'|[^\\s"',;]{1,2048})`, 'gi');
const JSON_PAIR = new RegExp(`("${SECRET_NAME}"\\s{0,4}:\\s{0,4})"[^"\\n]{0,4096}"`, 'gi');
const CLI_FLAG = new RegExp(`(--${SECRET_NAME})(=|\\s{1,4})([^\\s"']{1,2048}|"[^"]{0,2048}"|'[^']{0,2048}')`, 'gi');

function core(input: string): string {
  let out = input;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  out = out.replace(QUERY_SECRET, `$1${REDACTED}`);
  out = out.replace(COOKIE, `$1${REDACTED}`);
  out = out.replace(MYSQL_P, `$1${REDACTED}`);
  out = out.replace(BEARER, (_m, word: string, sep: string) => `${word}${sep}${REDACTED}`);
  out = out.replace(JSON_PAIR, `$1"${REDACTED}"`);
  out = out.replace(CLI_FLAG, (_m, flag: string, sep: string) => `${flag}${sep}${REDACTED}`);
  out = out.replace(ASSIGNMENT, (m, name: string, sep: string, value: string) => {
    if (value === REDACTED || value.includes(REDACTED)) return m;
    // Leave obvious non-secrets alone: empty, booleans, shell variable references.
    if (/^["']?(?:|true|false|null|undefined|\$\{?[A-Za-z_][A-Za-z0-9_]{0,64}\}?)["']?$/i.test(value)) return m;
    return `${name}${sep}${REDACTED}`;
  });
  return out;
}

function decodePercent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/%([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
}

/**
 * Redacts secrets in `input`. Input longer than MAX_SCAN is cut first (keep `end` to keep the
 * tail instead of the head). URL-encoded secrets are caught by also scanning a decoded copy:
 * if that finds anything, the decoded, redacted text is returned (lossy, but never leaky).
 */
export function redactString(input: string, opts: { keep?: 'head' | 'end' } = {}): string {
  let s = input;
  if (s.length > MAX_SCAN) s = opts.keep === 'end' ? s.slice(-MAX_SCAN) : s.slice(0, MAX_SCAN);
  const out = core(s);
  if (out.includes('%')) {
    const decoded = decodePercent(out);
    if (decoded !== out) {
      const scrubbed = core(decoded);
      if (scrubbed !== decoded) return scrubbed;
    }
  }
  return out;
}

/** Deep-redacts every string in a JSON-like value. Returns a new value. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v);
    return out as T;
  }
  return value;
}

/** True for paths whose contents must never be shown (.env files, key files). */
export function isSecretPath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? path;
  if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template)$/.test(base)) return true;
  return /^(id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|p12|pfx))$/.test(base) || /(^|[\\/])\.ssh[\\/]/.test(path);
}

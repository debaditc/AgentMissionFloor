import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactString, redactValue, isSecretPath, REDACTED } from '../src/redact.ts';

// Corpus of fake secrets. Every one must disappear; the surrounding text must survive.
const SECRETS: Array<[string, string]> = [
  ['anthropic', 'export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['anthropic bare', 'curl -H "x-api-key: sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzz" https://api.example.com'],
  ['openai', 'OPENAI=sk-proj-abcdefghijklmnopqrstuvwxyz012345'],
  ['stripe', 'charge with sk_live_51HbCdEfGhIjKlMnOp'],
  ['aws key id', 'aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE'],
  ['aws secret', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['github', 'git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r'],
  ['github pat', 'GH=github_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
  ['gitlab', 'token glpat-abcdefghijklmnopqrst'],
  ['slack', 'SLACK=xoxb-123456789012-123456789012-abcdefghijklmnop'],
  ['slack webhook', 'post to https://hooks.slack.com/services/T000/B000/XXXXXXXX'],
  ['google', 'key=AIzaSyA-abcdefghijklmnopqrstuvwxyz12345'],
  ['npm', '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['jwt', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['bearer', 'curl -H "Authorization: Bearer abc123def456ghi789jkl"'],
  ['url creds', 'psql postgres://admin:hunter2pass@db.internal:5432/app'],
  ['env password', 'DB_PASSWORD="correct horse battery staple"'],
  ['env token', 'MY_SERVICE_TOKEN=abcd1234efgh5678'],
  ['json secret', '{"client_secret": "s3cr3t-value-123", "name": "ok"}'],
  ['cli flag', 'mysql --password=hunter2 -u root'],
  ['private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----'],
  ['truncated key', 'cat key.pem → -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA'],
  ['huggingface', 'HF=hf_abcdefghijklmnopqrstuvwxyzABCDEF'],
];

const LEAK_FRAGMENTS = [
  'AbCdEfGhIjKlMnOp', 'zzzzzzzzzzzzzzzz', 'abcdefghijklmnopqrstuvwxyz012345', '51HbCdEf', 'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI', 'ghp_abcdef', 'github_pat_11', 'glpat-abc', 'xoxb-1234', 'T000/B000', 'AIzaSyA', 'npm_abcdef',
  'eyJhbGciOiJIUzI1NiJ9', 'abc123def456', 'hunter2pass', 'correct horse', 'abcd1234efgh', 's3cr3t', 'hunter2',
  'b3BlbnNzaC1rZXkt', 'MIIEpAIBAAKCAQEA', 'hf_abcdef',
];

test('every fake secret in the corpus is redacted', () => {
  for (const [label, text] of SECRETS) {
    const out = redactString(text);
    assert.ok(out.includes(REDACTED), `${label}: nothing redacted in ${out}`);
    for (const frag of LEAK_FRAGMENTS) assert.ok(!out.includes(frag), `${label}: leaked "${frag}" in ${out}`);
  }
});

test('ordinary text survives', () => {
  const samples = [
    'pnpm test --filter world',
    'Edit src/session.ts +42 −9',
    'git commit -m "fix: token refresh race"',
    'grep -rn "password" src/',
    'NODE_ENV=production node server.js',
    'AUTH_ENABLED=true',
    'export TOKEN=$GITHUB_TOKEN',
    'https://github.com/owner/repo/pull/12',
  ];
  for (const s of samples) assert.equal(redactString(s), s, s);
});

test('redactValue walks nested objects and arrays', () => {
  const out = redactValue({ a: ['DB_PASSWORD=hunter2', { b: 'ok' }], n: 3, t: null });
  assert.deepEqual(out, { a: ['DB_PASSWORD=[REDACTED]', { b: 'ok' }], n: 3, t: null });
});

test('secret paths', () => {
  for (const p of ['/app/.env', '.env.local', '/home/u/.ssh/config', 'certs/server.key', 'id_ed25519']) assert.ok(isSecretPath(p), p);
  for (const p of ['.env.example', 'src/env.ts', 'README.md', 'keyboard.ts']) assert.ok(!isSecretPath(p), p);
});

test('hardening: newly covered secret formats are redacted (review M2)', () => {
  const cases: Array<[string, string]> = [
    ['DB_PASS=s3cretP4ss', 's3cretP4ss'],
    ['STRIPE_KEY=rk_abcdefghijklmnop', 'rk_abcdefghijklmnop'],
    ['DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==;EndpointSuffix=core.windows.net', 'Zm9vYmFyYmF6'],
    ['mysql -uroot -phunter2pw shop', 'hunter2pw'],
    ['STRIPE_WEBHOOK=whsec_abcdefghijklmnopqrstuvwx', 'whsec_abcdefghij'],
    ['curl -H "Cookie: session=abc123xyz789; theme=dark" https://x.test', 'abc123xyz789'],
    ['Set-Cookie: sid=deadbeefcafe0011; HttpOnly', 'deadbeefcafe0011'],
    ['curl "https://api.x.test/v1?api_key=k-9f8e7d6c5b4a&q=1"', 'k-9f8e7d6c5b4a'],
    ['https://acct.blob.core.windows.net/c/f?sv=2024&sig=abcDEF123%2Bxyz%3D', 'abcDEF123'],
    ['echo key%3Dsk-ant-api03-ABCDEFGHIJKLMNOPQRST', 'ABCDEFGHIJKLMNOPQRST'],
    ['Server=db;Database=app;User Id=sa;Password=Pa55w0rd!;', 'Pa55w0rd'],
  ];
  for (const [text, secret] of cases) {
    const out = redactString(text);
    assert.ok(!out.includes(secret), `${text} → ${out}`);
  }
});

test('hardening: hostile input is bounded and fast (review M1)', () => {
  const hostile = [
    'a'.repeat(1_000_000),
    'x_'.repeat(500_000),
    'secret_'.repeat(150_000),
    ('k=' + 'v'.repeat(3000) + ' ').repeat(300),
    '-----BEGIN RSA PRIVATE KEY-----' + 'A'.repeat(900_000),
  ];
  for (const h of hostile) {
    const t0 = performance.now();
    const out = redactString(h);
    const ms = performance.now() - t0;
    assert.ok(ms < 150, `${ms.toFixed(1)} ms for a ${h.length}-char input`);
    assert.ok(out.length <= 70_000, 'scan is capped');
  }
});

test('hardening: secrets are redacted before clipping, never split (review M2)', async () => {
  const { clip, tail, normalizeHook } = await import('@agent-mission-floor/protocol');
  const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  const prompt = 'x'.repeat(190) + ' ' + secret;
  const c = clip(prompt, 200);
  assert.ok(!c.includes('sk-ant-api03-ABC'), c.slice(-40));
  const t = tail(secret + ' ' + 'y'.repeat(590), 600);
  assert.ok(!t.includes('KLMNOPQRSTUVWXYZ'), t.slice(0, 40));
  // Every free-text field from a hook is bounded.
  const e = normalizeHook(
    { session_id: 's', hook_event_name: 'SessionEnd', reason: 'r'.repeat(100_000), cwd: '/'.repeat(100_000), agent_type: 'a'.repeat(100_000), transcript_path: 'p'.repeat(100_000) },
    { id: 'x', ts: 1, source: 'hook' },
  )!;
  assert.ok(JSON.stringify(e).length < 4000, `event is ${JSON.stringify(e).length} chars`);
});

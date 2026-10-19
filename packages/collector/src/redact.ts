// Redaction lives in the protocol package so the normalizer can redact *before* clipping.
// The collector re-exports it and runs it again on every event before storage (defence in depth).
export { REDACTED, MAX_SCAN, redactString, redactValue, isSecretPath } from '@agent-mission-floor/protocol';

/**
 * Secret scrubber for the consent-gated analytics pipeline.
 *
 * This is the safety-critical boundary: nothing reaches an analytics envelope
 * without passing through {@link redactContent} first. The function runs a
 * fixed sequence of passes that redact whole secret VALUES *before* any size
 * truncation, so a cap can never split a credential and leak a usable prefix.
 *
 * Design rules:
 *   - Redact-then-truncate. Truncation only ever runs on text whose secrets
 *     are already collapsed to placeholder tokens, so slicing a token leaks
 *     nothing.
 *   - Default-deny. Any exception anywhere in the pipeline drops the whole
 *     field (returns ""), never the raw input.
 *   - Reuse the repo's existing, audited redactors rather than reinventing:
 *       * `redactAuthValues` / `authSecretValues` — ../agent/auth-redaction.js
 *       * `redactSensitiveHeaders`               — ../disclose/template.js
 *     and mirror the credential SHAPES from the CLI's `SECRET_RULES`
 *     (packages/cli/src/tui/feedback.ts) — but as REPLACE, not detect. That
 *     module lives in `@0sec/cli`, which core must not depend on, so the
 *     shapes are re-declared here; keep them in sync.
 */

import { redactAuthValues } from "../agent/auth-redaction.js";
import { redactSensitiveHeaders } from "../disclose/template.js";

// ---------------------------------------------------------------------------
// Typed replacement tokens
// ---------------------------------------------------------------------------

/** OpenAI / Anthropic-style `sk-…` API key. */
export const REDACTED_OPENAI = "<REDACTED-OPENAI>";
/** AWS access key id (`AKIA…` / `ASIA…`). */
export const REDACTED_AWS = "<REDACTED-AWS>";
/** GitHub token (`ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_`). */
export const REDACTED_GH = "<REDACTED-GH>";
/** Google API key (`AIza…`). */
export const REDACTED_GCP = "<REDACTED-GCP>";
/** Slack token (`xox[abprs]-…`). */
export const REDACTED_SLACK = "<REDACTED-SLACK>";
/** JSON Web Token (`eyJ…`). */
export const REDACTED_JWT = "<REDACTED-JWT>";
/** PEM private-key block. */
export const REDACTED_PEM = "<REDACTED-PEM>";
/** Generic credential (assignment value, connection-string creds, entropy run). */
export const REDACTED_SECRET = "<REDACTED-SECRET>";
/** Email address (PII). */
export const REDACTED_EMAIL = "<REDACTED-EMAIL>";

/** All tokens this scrubber can emit, for tests / allowlists. */
export const REDACTION_TOKENS = [
  REDACTED_OPENAI,
  REDACTED_AWS,
  REDACTED_GH,
  REDACTED_GCP,
  REDACTED_SLACK,
  REDACTED_JWT,
  REDACTED_PEM,
  REDACTED_SECRET,
  REDACTED_EMAIL,
] as const;

/** Default size cap applied AFTER redaction. */
export const DEFAULT_REDACTION_CAP = 4000;

export interface RedactContext {
  /**
   * Operator-supplied target-auth values (bearer tokens, cookies, basic
   * creds, encoded forms). Removed first, by exact match, via the audited
   * `redactAuthValues` helper.
   */
  authSecretValues?: readonly string[];
  /** Override the post-redaction size cap. Defaults to {@link DEFAULT_REDACTION_CAP}. */
  maxChars?: number;
}

// ---------------------------------------------------------------------------
// Credential shapes (mirrors SECRET_RULES in the CLI, as REPLACE)
// ---------------------------------------------------------------------------

// Multi-line PEM private key block. Matched (and dropped) before the
// high-entropy sweep so the base64 body is not partially masked.
const PEM_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
const OPENAI_RE = /\bsk-[A-Za-z0-9_-]{16,}/g;
const GH_RE = /\bgh[pousr]_[A-Za-z0-9]{20,}/g;
const AWS_RE = /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g;
const GCP_RE = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const SLACK_RE = /\bxox[abprs]-[A-Za-z0-9-]{10,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g;

// scheme://user:pass@host — redact the credentials, keep the shape so a
// finding about the endpoint is still legible.
const CONN_STRING_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^\s:/@]+):([^\s:/@]+)@/gi;

// `password=` / `api_key=` / `apikey=` / `secret=` / `token=` / `pwd=`
// (`:` or `=`, value quoted or bare). Keeps the key + separator, replaces the
// value only.
const ASSIGNMENT_RE =
  /\b(pass(?:word|wd)?|pwd|api[_-]?key|apikey|secret|token|credentials?)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

// .env-style KEY=VALUE where the KEY itself reads as a credential name
// (…SECRET…, …TOKEN…, …KEY…, …PASSWORD…, …CREDENTIAL…). Line-oriented so it
// only bites a whole assignment, never mid-prose.
const ENV_SECRET_LINE_RE =
  /^([ \t]*(?:export[ \t]+)?[A-Za-z][A-Za-z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|PWD|CREDENTIAL|APIKEY)[A-Za-z0-9_]*)([ \t]*=[ \t]*)(.+)$/gim;

// Email address — generic, so it also catches the operator's own address.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/g;

// Long opaque runs: 40+ chars requiring mixed case AND a digit, so ordinary
// prose, paths and hyphenated identifiers do not trip it. Same shape as the
// CLI's high-entropy rule, applied last (placeholder tokens are all-caps with
// no digit, so they can never be re-matched).
const ENTROPY_RE =
  /(?=[A-Za-z0-9+/_-]{40,})(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}/g;

// ---------------------------------------------------------------------------
// Truncation (mirrors the private `truncate` in ../agent/action-log.ts)
// ---------------------------------------------------------------------------

/**
 * Identical semantics to the un-exported helper in action-log.ts. Applied
 * only after every value has already been collapsed to a token, so cutting
 * here cannot expose a secret prefix.
 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrub `text` for analytics transmission. Runs the passes in order, then
 * caps the result. Returns "" (drops the field) on any internal failure.
 */
export function redactContent(text: string, ctx: RedactContext = {}): string {
  try {
    if (typeof text !== "string" || text.length === 0) return "";
    let out = text;

    // Pass 1 — exact-value target-auth removal (audited helper).
    const secrets = ctx.authSecretValues ?? [];
    if (secrets.length > 0) out = redactAuthValues(out, secrets);

    // Pass 2 — header sweep (audited helper): Authorization/Cookie/X-*,
    // inline Bearer, curl -H, AWS keys, JWTs.
    out = redactSensitiveHeaders(out);

    // Pass 3 — credential shapes → typed tokens. PEM first (multi-line block).
    out = out.replace(PEM_RE, REDACTED_PEM);
    out = out.replace(OPENAI_RE, REDACTED_OPENAI);
    out = out.replace(GH_RE, REDACTED_GH);
    out = out.replace(AWS_RE, REDACTED_AWS);
    out = out.replace(GCP_RE, REDACTED_GCP);
    out = out.replace(SLACK_RE, REDACTED_SLACK);
    out = out.replace(JWT_RE, REDACTED_JWT);

    // Pass 4 — PII / structured credentials.
    out = out.replace(CONN_STRING_RE, `$1://${REDACTED_SECRET}@`);
    out = out.replace(ASSIGNMENT_RE, `$1$2${REDACTED_SECRET}`);
    out = out.replace(ENV_SECRET_LINE_RE, `$1$2${REDACTED_SECRET}`);
    out = out.replace(EMAIL_RE, REDACTED_EMAIL);

    // High-entropy runs last (catch-all for anything shaped like a token).
    out = out.replace(ENTROPY_RE, REDACTED_SECRET);

    // Pass 5 — size cap, strictly AFTER redaction.
    const cap = ctx.maxChars ?? DEFAULT_REDACTION_CAP;
    return truncate(out, cap);
  } catch {
    // Default-deny: never fall through to raw input.
    return "";
  }
}

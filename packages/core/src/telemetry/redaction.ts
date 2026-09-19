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
 *       * `redactAuthHeaders`                  — ../disclose/template.js
 *   - Preserve ordinary content: no email, entropy, or generic KEY masking.
 *     Recognized credential shapes and credential-named fields remain scrubbed.
 */

import { redactAuthValues } from "../agent/auth-redaction.js";
import { redactAuthHeaders } from "../disclose/template.js";

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
/** Generic credential (assignment value or connection-string credentials). */
export const REDACTED_SECRET = "<REDACTED-SECRET>";

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
] as const;

/** Default size cap applied AFTER redaction (bounded metadata fields). */
export const DEFAULT_REDACTION_CAP = 4000;

/**
 * Size cap for large-content redacted fields (argsRedacted, outputRedacted,
 * sourceRedacted). Receiver confirmed max 262 144 UTF-8 bytes per field.
 */
export const MAX_CONTENT_BYTES = 262144;

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
// Recognized credential shapes; diagnostic/advisory PII policies are separate.
// ---------------------------------------------------------------------------

// Match the entire private key, including its encoded body.
const PEM_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
const OPENAI_RE = /\bsk-[A-Za-z0-9_-]{16,}/g;
const GH_RE = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const AWS_RE = /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g;
const GCP_RE = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const SLACK_RE = /\bxox[abprs]-[A-Za-z0-9-]{10,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

// Keep the endpoint, removing user/password through the LAST @ in userinfo.
// Quotes and URL path/query delimiters bound the authority.
const CONN_STRING_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/?#"'`]+:[^\s/?#"'`]*@/gi;

// Only credential-named fields, not arbitrary identifiers containing KEY/TOKEN.
// The left boundary also permits APP_SECRET, while TOKEN_COUNT stays intact.
const CREDENTIAL_NAME =
  "password|passwd|pwd|secret|token|credentials?|api[_-]?key|access[_-]?key(?:[_-]?id)?|private[_-]?key|client[_-]?secret|(?:access|refresh|auth|session|bearer|api|csrf|xsrf)[_-]?token|session[_-]?cookie|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie";
const CREDENTIAL_KEY_RE = new RegExp(`(?:^|[^A-Za-z0-9])(?:${CREDENTIAL_NAME})$`, "i");
const HEADER_RE = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-auth-token|x-api-key|x-csrf-token|x-xsrf-token)$/i;
const ASSIGNMENT_RE = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z_][A-Za-z0-9_-]*)(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'\x60,;{}[\]&#\\]+)/g;
const QUOTED_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;

function credentialKey(name: string): boolean {
  return CREDENTIAL_KEY_RE.test(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

// ---------------------------------------------------------------------------
// Receiver-bounded metadata truncation, after credential scrubbing
// ---------------------------------------------------------------------------

/**
 * Include the marker in the cap: the receiver rejects metadata over 4,000
 * characters. Credentials have already been scrubbed before this boundary.
 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}${".".repeat(Math.min(3, max))}`;
}

/** End of a value in already-validated JSON, without losing duplicate keys. */
function jsonValueEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === "\\") i++;
      else if (char === '"') {
        quoted = false;
        if (depth === 0) return i + 1;
      }
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      if (depth === 0) return i;
      if (--depth === 0) return i + 1;
    } else if (depth === 0 && (char === "," || /\s/.test(char!))) return i;
  }
  return text.length;
}

/** Scrub unquoted text, never the escape sequences of a serialized string. */
function redactPlain(text: string, ctx: RedactContext): string {
  const secrets = ctx.authSecretValues ?? [];
  let out = secrets.length > 0 ? redactAuthValues(text, secrets) : text;
  out = redactAuthHeaders(out);
  out = out.replace(OPENAI_RE, REDACTED_OPENAI);
  out = out.replace(GH_RE, REDACTED_GH);
  out = out.replace(AWS_RE, REDACTED_AWS);
  out = out.replace(GCP_RE, REDACTED_GCP);
  out = out.replace(SLACK_RE, REDACTED_SLACK);
  out = out.replace(JWT_RE, REDACTED_JWT);
  return out.replace(CONN_STRING_RE, `$1${REDACTED_SECRET}@`);
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
    const cap = ctx.maxChars ?? DEFAULT_REDACTION_CAP;
    const contentContext = ctx.maxChars === Number.POSITIVE_INFINITY
      ? ctx : { ...ctx, maxChars: Number.POSITIVE_INFINITY };

    if (/^\s*[[{]/.test(text)) {
      let validJson = false;
      try {
        JSON.parse(text);
        validJson = true;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (validJson) {
        // Work on the original spans, not a parsed/re-serialized object:
        // duplicate keys and all noncredential bytes must survive.
        let out = "";
        let cursor = 0;
        for (const match of text.matchAll(QUOTED_RE)) {
          if (match.index < cursor) continue;
          const token = match[0];
          const decoded = JSON.parse(token) as string;
          const clean = redactContent(decoded, contentContext);
          const end = match.index + token.length;
          if (clean !== decoded) {
            out += text.slice(cursor, match.index) + JSON.stringify(clean);
            cursor = end;
          }
          let next = end;
          while (/\s/.test(text[next] ?? "")) next++;
          if (text[next] !== ":" || !credentialKey(decoded)) continue;
          next++;
          while (/\s/.test(text[next] ?? "")) next++;
          out += text.slice(cursor, next) + JSON.stringify(REDACTED_SECRET);
          cursor = jsonValueEnd(text, next);
        }
        return truncate(out + text.slice(cursor), cap);
      }
    }

    const assigned = text.replace(PEM_RE, REDACTED_PEM).replace(
      ASSIGNMENT_RE,
      (match, key: string, separator: string, value: string) => {
        let name = key.startsWith('"') || key.startsWith("'") ? key.slice(1, -1) : key;
        if (key.startsWith('"')) {
          try {
            name = JSON.parse(key) as string;
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
        }
        if (!credentialKey(name)) return match;
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
        // Bare HTTP headers need their whole value removed, not just "Basic".
        if (!quote && separator.includes(":") && HEADER_RE.test(name)) return match;
        return `${key}${separator}${quote}${REDACTED_SECRET}${quote}`;
      },
    );
    let out = "";
    let cursor = 0;
    for (const match of assigned.matchAll(QUOTED_RE)) {
      out += redactPlain(assigned.slice(cursor, match.index), ctx);
      const token = match[0];
      let decoded = token.slice(1, -1);
      if (token[0] === '"') {
        try {
          decoded = JSON.parse(token) as string;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      const clean = redactContent(decoded, contentContext);
      out += clean === decoded ? token
        : token[0] === '"' ? JSON.stringify(clean) : `'${clean}'`;
      cursor = match.index + token.length;
    }
    return truncate(out + redactPlain(assigned.slice(cursor), ctx), cap);
  } catch {
    // Default-deny: never fall through to raw input.
    return "";
  }
}

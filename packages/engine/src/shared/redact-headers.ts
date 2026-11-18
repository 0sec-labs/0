/** Redaction of auth headers, bearer tokens, AWS keys and long JWT-like strings. Used by the action log, telemetry and the event sink. */
// ── Sensitive-data redaction ────────────────────────────────────────────────
//
// Writing logs or reports that leak the operator's session cookie, AWS key,
// or JWT into a triage queue is the textbook "sensitive-data disclosure"
// own-goal — and most responsible-disclosure programs treat it as a CoC
// violation. Mask values for known
// auth headers (case-insensitive), AWS access keys, and JWT-looking strings.
// Inline by design — this is a small, mechanical transform applied right
// before content is emitted into a log, report or telemetry event.

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-auth-token",
  "x-api-key",
  "x-csrf-token",
  "x-xsrf-token",
]);

const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
// JWT: three base64url segments separated by dots, total length >= 80.
// Base64url charset: A-Z a-z 0-9 - _, with optional `=` padding.
const JWT_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+={0,2}\b/g;

// Inline `Bearer <token>` matches anywhere in a line. Targets shell commands
// like `curl -H "Authorization: Bearer eyJ..."` where the line-oriented
// `^Header:` matcher doesn't fire because the header lives inside an arg.
// Token is "non-whitespace, non-quote" so we don't swallow trailing quote
// or shell separators.
const INLINE_BEARER_RE = /\b(Bearer)\s+([^\s"'`]+)/gi;

// Inline `-H 'Sensitive-Header: ...'` / `-H "Sensitive-Header: ..."` /
// `--header 'Sensitive-Header: ...'` for curl-style commands. Quoting is
// optional (`-H Sensitive-Header: ...` is valid curl too).
const INLINE_CURL_HEADER_RE =
  /(-H|--header)(\s+|=)(["']?)([A-Za-z][A-Za-z0-9-]*)\s*:\s*([^"'\n]*)\3/gi;

/**
 * Redact sensitive header values, AWS access keys, and JWT-looking strings
 * from a block of text. Header redaction is line-oriented and case-
 * insensitive — `Authorization: Bearer xyz` becomes
 * `Authorization: <REDACTED-Authorization>`. AWS keys and JWTs are masked
 * wherever they appear in the body.
 *
 * Also masks two shell-command patterns that wouldn't be caught by the
 * line-oriented `^Header:` matcher:
 *   - inline `Bearer <token>` (e.g. embedded in a `curl -H` arg)
 *   - `curl -H 'Cookie: ...'` / `--header "Authorization: ..."`
 * Without these, a `pocSteps` shell step that wraps a real bearer token
 * inside its `cmd` field would leak verbatim into the rendered advisory.
 */
export function redactSensitiveHeaders(text: string): string {
  if (!text) return text;
  let out = redactAuthHeaders(text);
  out = out.replace(AWS_KEY_RE, "<REDACTED-AWS-KEY>");
  // Advisory output retains its conservative JWT-like string sweep.
  out = out.replace(JWT_RE, (match) => {
    if (match.length < 80) return match;
    return "<REDACTED-JWT>";
  });
  return out;
}

/** Scrub explicit authentication headers without masking ordinary opaque text. */
export function redactAuthHeaders(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  const redactedLines = lines.map((line) => {
    const m = /^(\s*)([A-Za-z][A-Za-z0-9-]*)\s*:\s*([^\r]*)(\r?)$/.exec(line);
    if (m && SENSITIVE_HEADER_NAMES.has(m[2].toLowerCase())) {
      return `${m[1]}${m[2]}: <REDACTED-${m[2]}>${m[4]}`;
    }
    return line;
  });
  let out = redactedLines.join("\n");
  out = out.replace(INLINE_CURL_HEADER_RE, (match, flag, sep, quote, name, _value) => {
    if (!SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) return match;
    return `${flag}${sep}${quote}${name}: <REDACTED-${name}>${quote}`;
  });
  return out.replace(INLINE_BEARER_RE, "$1 <REDACTED-Bearer>");
}

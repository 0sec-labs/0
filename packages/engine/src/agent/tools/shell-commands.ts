// Scoped-source tool allowlist, HTTP-egress detection and auth injection into shell commands.
// Extracted verbatim from ../tools.ts; the public API is re-exported there.
import type { ScopePolicy } from "../../scope/scope.js";
import { LIST_TOOLS_NAME, LOAD_TOOL_NAME } from "../deferred-tools.js";

// A scoped source audit processes attacker-controlled package contents. Do not
// offer generic process, network, or write capability inside that trust boundary.
// agent-runner routes these roles through the tool-mediated API loop; this list
// supplies only scope-canonicalized source browsing, and findings.
export const SCOPED_SOURCE_AUDIT_TOOLS: Record<string, true> = {
  // Deferred controls disclose definitions only; actual calls still pass this gate.
  [LIST_TOOLS_NAME]: true,
  [LOAD_TOOL_NAME]: true,
  // Methodology reads return bounded registry text, never execute its contents.
  load_skill: true,
  finding: true,
  memory: true,
  // Delegation shares the audit's scope, tool capabilities, budget and worker tree.
  spawn_agent: true,
  report_status: true,
  send_message: true,
  check_messages: true,
};

// Source-audit authority may include opt-in executable analysis; read-only
// delegation must never inherit that launcher or count it as mutation-free.
export function isCheckoutReadOnlyTool(name: string): boolean {
  return Object.hasOwn(SCOPED_SOURCE_AUDIT_TOOLS, name);
}

/**
 * Split a command on top-level `|` (pipe) characters, respecting
 * single + double quotes and backslash escapes. A naive
 * `command.split("|")` corrupts any \\\| or `|` that lives inside a
 * quoted regex pattern (very common in the audit agent's grep / rg
 * calls — e.g. `grep "foo\\|bar" file.js`).
 *
 * Exported for unit tests so the quote-handling invariants are
 * pinned without the surrounding {@link runCommand} machinery.
 */
export function splitOnTopLevelPipes(command: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  for (const ch of command) {
    if (escaping) {
      buf += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      buf += ch;
      escaping = true;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      buf += ch;
      quote = ch;
      continue;
    }
    if (ch === "|") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

// ── Auth injection in shell commands (0#282) ──────────────────
//
// Surfaced by the 2026-05-07 control-flow audit: the former HTTP tools injected auth headers automatically, but `shellExec` only
// EXPOSES `$AUTH_HEADER` / `$AUTH_VALUE` / `$AUTH_CURL_FLAG` env vars and
// trusts the agent to interpolate them. After conversation compaction
// the model loses this affordance and sends unauthenticated curls for
// 5+ turns. This is the highest-leverage code-not-prompt fix in the
// agent loop.
//
// `injectAuthIntoBashCommand` rewrites the command BEFORE exec to
// prepend the env-var indirection ($AUTH_CURL_FLAG / $AUTH_HEADER) into
// curl/wget invocations whose URL is in scope and which don't already
// include explicit auth. Python `requests`/`urllib`/`httpx` invocations
// are detected and refused with a hint to set the header explicitly or use curl.
//
// Env-var indirection is deliberate: the actual token NEVER appears in
// the rendered command, so transcripts/logs don't leak it.

export const AUTH_PRESENT_PATTERNS: RegExp[] = [
  /Authorization\s*:/i,                 // "Authorization:" header (any quoting)
  /Cookie\s*:/i,                        // "Cookie:" header
  /\B--user[\s=]/,                      // curl --user / --user=
  /\s-u\s+\S/,                          // curl -u USER:PASS
  /headers\s*=/i,                       // python requests/httpx kwarg
  /\$AUTH_CURL_FLAG\b/,                 // already injected
  /\$AUTH_HEADER\b/,                    // already injected (wget shape)
];

/**
 * Cheap heuristic: does the command already carry explicit auth? If
 * yes, the injector leaves it alone — the agent's manual auth choice
 * always wins, and we never want to double-inject (which would either
 * stomp the agent's intent or, worse, silently send two `Authorization`
 * headers, behaviour of which is server-dependent).
 */
export function commandHasExplicitAuth(command: string): boolean {
  return AUTH_PRESENT_PATTERNS.some((re) => re.test(command));
}

export type AuthInjectResult =
  | { kind: "rewrite"; command: string }
  | { kind: "unchanged" }
  | { kind: "refuse"; reason: string };

/**
 * http_audit bash-egress SSRF gate (FROZEN CONTRACT). The bash subprocess
 * bypasses node's fetch — and therefore the host/path scope checks the
 * the fetch-based tools enforce. In http_audit mode we
 * must guarantee the host+path allowlist holds for ALL egress, so we refuse
 * any raw HTTP-egress command (curl/wget/python http libs) that does not
 * carry an explicit, in-scope, in-path http(s) URL we can verify up front.
 *
 * This is intentionally fail-closed: an egress command whose destination we
 * can't statically resolve (obfuscated URL, variable, base64, DNS trick) is
 * refused rather than allowed, because the whole point of http_audit is a
 * bounded, auditable egress surface. Non-egress bash (grep, jq, echo, file
 * munging) is untouched.
 *
 * Returns the list of egress-tool segments found in the command (one per
 * pipe / `&&` / `;` segment whose executable is a known HTTP client).
 */
export const HTTP_EGRESS_BINARIES = new Set([
  "curl",
  "wget",
  "httpie",
  "http",
  "https",
]);

export const PYTHON_HTTP_RE = /(requests\.|urllib\.|httpx\.|http\.client|aiohttp\.|socket\.)/;

export function detectHttpEgressSegments(command: string): string[] {
  const hits: string[] = [];
  // Curl/wget/httpie detection: split on top-level `;`, `&&`, and `|`
  // (quote-aware so we don't split inside a quoted arg). Each segment whose
  // executable is a known HTTP client is an egress segment.
  const segments = command.split(/\s*(?:\|\||&&|;|\|)\s*/);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    let rest = trimmed;
    let m: RegExpMatchArray | null;
    while ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/))) {
      rest = rest.slice(m[0].length);
    }
    const exe = (rest.split(/\s+/)[0] ?? "").replace(/^.*\//, "");
    if (HTTP_EGRESS_BINARIES.has(exe)) {
      hits.push(trimmed);
    }
  }
  // python -c '…' scripts legitimately contain `;` inside the quoted body,
  // so the naive split above corrupts them. Detect a python HTTP-client
  // invocation against the WHOLE command instead and record the matched
  // python segment(s) by re-splitting only on top-level pipes (which a
  // `-c` body rarely contains unquoted).
  if (/(^|[\s;&|/])python(?:3)?(\s|$)/.test(command) && PYTHON_HTTP_RE.test(command)) {
    for (const seg of splitOnTopLevelPipes(command)) {
      const t = seg.trim();
      if (/(^|[\s;&|/])python(?:3)?(\s|$)/.test(t) && PYTHON_HTTP_RE.test(t)) {
        hits.push(t);
      }
    }
  }
  return hits;
}

/**
 * Find the index of the next URL token in a tokenized curl/wget invocation,
 * starting from `from`. Returns -1 if no URL token is present.
 *
 * We use this instead of "always insert flag at index 1" because curl
 * invocations frequently look like `curl -X POST -d '…' URL`, and we want
 * the flag to land BEFORE the URL but after the verb so the rewritten
 * command remains a syntactically valid curl call.
 */
export function findUrlTokenIdx(tokens: string[], from: number): number {
  for (let i = from; i < tokens.length; i++) {
    if (/^https?:\/\//i.test(tokens[i])) return i;
  }
  return -1;
}

/**
 * Rewrite a single shell segment (one side of `|`) to inject auth into
 * a leading curl or wget invocation. Python invocations short-circuit
 * with a refusal — see `injectAuthIntoBashCommand` for the policy.
 *
 * The segment may have leading whitespace (preserved verbatim) and may
 * begin with env-var assignments like `FOO=bar curl …`; we strip those
 * to find the executable token.
 */
export function rewriteSegmentForAuth(
  segment: string,
  scope: ScopePolicy | undefined,
): AuthInjectResult {
  // Skip purely-whitespace segments.
  if (!segment.trim()) return { kind: "unchanged" };

  // Tokenise on whitespace, but preserve original spacing for the
  // splice. We do the splice on the raw string by locating the
  // executable token's position so leading env-vars (`FOO=bar curl …`)
  // and the agent's whitespace pass through untouched.
  const trimmed = segment.trimStart();
  const leadingWs = segment.slice(0, segment.length - trimmed.length);

  // Skip leading `KEY=value` env-prefix tokens.
  let cursor = 0;
  while (cursor < trimmed.length) {
    const rest = trimmed.slice(cursor);
    const m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/);
    if (!m) break;
    cursor += m[0].length;
  }
  const afterEnv = trimmed.slice(cursor);

  // Tokenise the post-env-prefix part.
  const tokens = afterEnv.split(/\s+/);
  const exe = tokens[0];
  if (!exe) return { kind: "unchanged" };

  // Match curl / wget / python by basename (handles /usr/bin/curl too).
  const exeBase = exe.replace(/^.*\//, "");

  if (exeBase === "curl") {
    const urlIdx = findUrlTokenIdx(tokens, 1);
    if (urlIdx < 0) return { kind: "unchanged" };
    const url = tokens[urlIdx];
    // Out-of-scope check (hard refusal already handled upstream when
    // ctx.scope is set, but if the rewriter is called in isolation we
    // still must NOT inject auth into a non-engagement target).
    if (scope && !scope.match(url).allowed) return { kind: "unchanged" };
    if (!scope) return { kind: "unchanged" }; // no scope ⇒ can't verify ⇒ don't leak
    if (commandHasExplicitAuth(segment)) return { kind: "unchanged" };

    // Splice "$AUTH_CURL_FLAG" before the URL token. We rebuild from
    // tokens because curl tolerates whitespace collapse, and this keeps
    // the splice invariant simple.
    const before = tokens.slice(0, urlIdx).join(" ");
    const after = tokens.slice(urlIdx).join(" ");
    const rewrittenAfterEnv = `${before} $AUTH_CURL_FLAG ${after}`;
    return {
      kind: "rewrite",
      command: leadingWs + trimmed.slice(0, cursor) + rewrittenAfterEnv,
    };
  }

  if (exeBase === "wget") {
    const urlIdx = findUrlTokenIdx(tokens, 1);
    if (urlIdx < 0) return { kind: "unchanged" };
    const url = tokens[urlIdx];
    if (scope && !scope.match(url).allowed) return { kind: "unchanged" };
    if (!scope) return { kind: "unchanged" };
    if (commandHasExplicitAuth(segment)) return { kind: "unchanged" };

    const before = tokens.slice(0, urlIdx).join(" ");
    const after = tokens.slice(urlIdx).join(" ");
    const rewrittenAfterEnv = `${before} --header="$AUTH_HEADER: $AUTH_VALUE" ${after}`;
    return {
      kind: "rewrite",
      command: leadingWs + trimmed.slice(0, cursor) + rewrittenAfterEnv,
    };
  }

  // Python: refuse unless the call already has `headers=` / `auth=` /
  // explicit Authorization header. Detection is cheap text-search; the
  // refusal message points the agent at explicit headers or curl, which gets
  // auth injected.
  if (
    /python(?:3)?$/.test(exeBase) &&
    /(requests\.|urllib\.request\.|httpx\.)/.test(segment)
  ) {
    if (commandHasExplicitAuth(segment)) return { kind: "unchanged" };
    return {
      kind: "refuse",
      reason:
        "Python HTTP requests in shell mode must include explicit auth headers; " +
        "add `headers={'Authorization': 'Basic ...'}` to your call, " +
        "or use curl so auth is injected for you.",
    };
  }

  return { kind: "unchanged" };
}

/**
 * Walk every pipe / `&&` / `;` segment of the bash command and rewrite
 * each in turn. Returns either a fully-rewritten command, the original
 * (if no segment matched), or a `refuse` verdict (Python detection).
 *
 * Exported for unit tests so the rewrite invariants are pinned without
 * the surrounding `shellExec` machinery.
 */
export function injectAuthIntoBashCommand(
  command: string,
  scope: ScopePolicy | undefined,
): AuthInjectResult {
  // Python detection runs against the WHOLE command first because the
  // typical shape — `python3 -c 'import requests; requests.get(…)'` —
  // hides the `requests.` token inside a single-quoted block, and our
  // segment splitter doesn't track quoting beyond `splitOnTopLevelPipes`.
  // If the command both invokes a python interpreter and references a
  // requests-flavour HTTP call, refuse with the explicit-header hint —
  // unless explicit auth is already present (`headers=` / Authorization).
  if (
    /\bpython(?:3)?\b/.test(command) &&
    /(requests\.|urllib\.request\.|httpx\.)/.test(command) &&
    !commandHasExplicitAuth(command)
  ) {
    return {
      kind: "refuse",
      reason:
        "Python HTTP requests in shell mode must include explicit auth headers; " +
        "add `headers={'Authorization': 'Basic ...'}` to your call, " +
        "or use curl so auth is injected for you.",
    };
  }

  // Split on pipes first; then split each pipe-segment on `&&`/`||`/`;`.
  // We deliberately do NOT respect quoting beyond `splitOnTopLevelPipes`
  // — three similar branches beats an over-engineered shell parser, and
  // the worst-case (a quoted `&&` inside a curl arg) just means the
  // segment passes through to `rewriteSegmentForAuth` slightly larger
  // than necessary, which is harmless because the auth-flag splice
  // still lands in front of the URL.
  const pipeSegments = splitOnTopLevelPipes(command);

  // Track whether any segment was rewritten and rebuild the command in
  // the same shape (with the original `|` separators preserved).
  const rewritten: string[] = [];
  let anyRewrite = false;

  for (const pipeSeg of pipeSegments) {
    // Within each pipe segment, split on `&&` / `||` / `;` (top-level
    // only — we don't track quoting here, which is documented above).
    const subSegs = pipeSeg.split(/(\s*(?:&&|\|\||;)\s*)/);
    const rewrittenSubs: string[] = [];
    for (const sub of subSegs) {
      // Preserve the connector tokens verbatim.
      if (/^\s*(?:&&|\|\||;)\s*$/.test(sub)) {
        rewrittenSubs.push(sub);
        continue;
      }
      const verdict = rewriteSegmentForAuth(sub, scope);
      if (verdict.kind === "refuse") return verdict;
      if (verdict.kind === "rewrite") {
        anyRewrite = true;
        rewrittenSubs.push(verdict.command);
      } else {
        rewrittenSubs.push(sub);
      }
    }
    rewritten.push(rewrittenSubs.join(""));
  }

  if (!anyRewrite) return { kind: "unchanged" };
  return { kind: "rewrite", command: rewritten.join("|") };
}

/**
 * Feedback capture: a local file first, and an explicitly-requested,
 * one-shot HTTPS submission second.
 *
 * ## The local file is the product; the network is an accessory
 *
 * `appendFeedback` writes to a file on the operator's own machine and is the
 * only path that runs by default. Submission is layered *on top* of that, and
 * the ordering is load-bearing: the caller must append locally first and
 * submit afterwards, so a refused, timed-out, or failed transmission can never
 * be the reason a message was lost.
 *
 * ## Why submission is hedged this heavily
 *
 * This is a pentest tool, and feedback typed mid-engagement is not neutral
 * prose. It routinely contains client hostnames, finding detail, and sometimes
 * a credential the operator pasted while complaining about it. Two separate
 * things go wrong if we are careless:
 *
 *   1. The *content* leaves the engagement boundary.
 *   2. The *connection itself* leaves the engagement boundary. An outbound
 *      request from 0sec lands in the client's egress logs, and some
 *      engagement contracts flatly forbid tooling that phones home. That
 *      second harm happens even if the body is empty.
 *
 * So the rules encoded below are:
 *
 *   - **Never automatic.** The transport never initiates on its own and has
 *     no retry queue. Every transmission requires explicit caller consent —
 *     the existence of diagnostic or feedback data is never taken as implicit
 *     permission to transmit.
 *   - **Previewable.** {@link buildSubmitPreview} returns the literal bytes
 *     and the literal headers that would go on the wire, so the operator can
 *     read the hostname before it leaves rather than trusting a summary.
 *   - **Nothing auto-attached.** No transcript, no findings, no scan ids, no
 *     environment, no machine id. Only the fields the caller passed. The
 *     preview *is* the payload — {@link FEEDBACK_WIRE_FIELDS} is the whole
 *     list and a test asserts the serialized body carries nothing else.
 *   - **Warn, never scrub.** {@link scanForSecrets} flags credential shapes
 *     and returns the message untouched. Partial redaction was already
 *     rejected in this codebase for transcripts, for the right reason: a
 *     scrubber advertises a guarantee it cannot keep, and an operator who
 *     believes it stops reading what they are about to send. A warning that
 *     makes a human look is worth more than a filter that makes them stop
 *     looking.
 *   - **Centrally disableable.** See {@link submissionBlockedReason} — an
 *     organization can kill egress for every operator with one env var.
 *
 * `User-Agent` the Node HTTP stack attaches. Cloud-authenticated submissions
 * also carry a Bearer token; its header name is previewed but its value is
 * deliberately redacted so credentials never enter the transcript.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadCloudCredentials } from "@0sec/core";

export interface FeedbackEntry {
  message: string;
  /** ISO timestamp. Injected so the formatter stays deterministic. */
  timestamp: string;
  version?: string;
  model?: string;
  mode?: string;
}

export interface FeedbackResult {
  ok: boolean;
  path: string;
  error?: string;
}

export function feedbackFilePath(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".0sec", "feedback.md");
}

/** Render one entry as a Markdown block. Pure, so it is unit-testable. */
export function formatFeedbackEntry(entry: FeedbackEntry): string {
  const context = [
    entry.version ? `version ${entry.version}` : null,
    entry.model ? `model ${entry.model}` : null,
    entry.mode ? `mode ${entry.mode}` : null,
  ].filter((part): part is string => part !== null);

  const lines = [`## ${entry.timestamp}`];
  if (context.length > 0) lines.push(`_${context.join(" · ")}_`);
  lines.push("", entry.message.trim(), "");
  return `${lines.join("\n")}\n`;
}

/**
 * Append an entry. Never throws — a read-only home directory must not take
 * down the console, so failure is reported through the return value.
 */
export function appendFeedback(entry: FeedbackEntry, homeDir?: string): FeedbackResult {
  const path = feedbackFilePath(homeDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, formatFeedbackEntry(entry), "utf8");
    return { ok: true, path };
  } catch (error) {
    return {
      ok: false,
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Opt-in submission
// ---------------------------------------------------------------------------

export type FeedbackEnv = Record<string, string | undefined>;

/** The payload shape. Structurally identical to {@link FeedbackEntry}. */
export interface FeedbackPayload {
  message: string;
  timestamp: string;
  version?: string;
  model?: string;
  mode?: string;
}

/**
 * Parsed `/feedback` subcommand. `record` deliberately remains the default so
 * an ordinary sentence never creates a network side effect.
 */
export type FeedbackCommand =
  | { kind: "record"; message: string }
  | { kind: "submit"; message: string }
  | { kind: "send" }
  | { kind: "cancel" }
  | { kind: "usage" };

/** Parse the local-only and explicitly staged feedback command forms. */
export function parseFeedbackCommand(raw: string): FeedbackCommand {
  const text = raw.trim();
  if (!text) return { kind: "usage" };

  const separator = text.search(/\s/);
  const verb = separator < 0 ? text : text.slice(0, separator);
  const rest = separator < 0 ? "" : text.slice(separator).trim();
  if (verb === "submit") return rest ? { kind: "submit", message: rest } : { kind: "usage" };
  if (verb === "send") return rest ? { kind: "usage" } : { kind: "send" };
  if (verb === "cancel") return rest ? { kind: "usage" } : { kind: "cancel" };
  return { kind: "record", message: text };
}

/**
 * Every key that may appear in the serialized body, in wire order. Exported
 * so the guarantee is checkable from outside rather than asserted in prose.
 */
export const FEEDBACK_WIRE_FIELDS = ["message", "timestamp", "version", "model", "mode"] as const;

export interface SubmitPreview {
  url: string;
  /** The exact bytes of the request body. Show verbatim; do not summarize. */
  body: string;
  /** Headers shown to the operator; authentication values are redacted. */
  headers: Record<string, string>;
  warnings: string[];
}

export type SubmitSkipReason = "no-endpoint" | "opt-out" | "insecure-endpoint";

export interface SubmitResult {
  ok: boolean;
  status?: number;
  error?: string;
  skipped?: SubmitSkipReason;
}

/**
 * Explicit default endpoint. Intentionally empty: an endpoint configured by an
 * operator remains an override, while authenticated 0cloud delivery is derived
 * only from real CLI credentials below.
 */
export const DEFAULT_FEEDBACK_URL = "";

/** Env var holding the submission endpoint. */
export const FEEDBACK_URL_ENV = "0SEC_FEEDBACK_URL";

/** The authenticated 0cloud receiver behind the dashboard feedback channel. */
const CLOUD_FEEDBACK_PATH = "/api/cli-feedback";

export interface FeedbackResolveOptions {
  /**
   * Test seam for the local `0sec auth login` credential store. An explicit
   * 0SEC_FEEDBACK_URL always wins and never consumes this credential.
   */
  cloudCredentials?: () => { host: string; token: string } | null;
  /** Disable cloud-credential fallback for a caller without a reviewed preview. */
  allowCloud?: boolean;
}

interface FeedbackTarget {
  url: string;
  authorization?: string;
}

function defaultCloudCredentials(env: FeedbackEnv): { host: string; token: string } | null {
  try {
    const credentials = loadCloudCredentials({
      env: env as NodeJS.ProcessEnv,
      warn: () => {},
    });
    return { host: credentials.host, token: credentials.token };
  } catch {
    return null;
  }
}

function cloudFeedbackUrl(host: string): string | null {
  try {
    const url = new URL(host);
    // cloud.0sec.ai is a legacy redirect. Redirecting a POST can change its
    // method, so post to the canonical dashboard host directly.
    if (url.hostname === "cloud.0sec.ai") url.hostname = "cloud.0.security";
    url.pathname = CLOUD_FEEDBACK_PATH;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function resolveFeedbackTarget(
  env: FeedbackEnv = process.env,
  options: FeedbackResolveOptions = {},
): FeedbackTarget | null {
  const configured = env[FEEDBACK_URL_ENV]?.trim();
  if (configured) return { url: configured };
  if (DEFAULT_FEEDBACK_URL) return { url: DEFAULT_FEEDBACK_URL };
  if (options.allowCloud === false) return null;

  const credentials = (options.cloudCredentials ?? (() => defaultCloudCredentials(env)))();
  if (!credentials) return null;
  const url = cloudFeedbackUrl(credentials.host);
  return url ? { url, authorization: `Bearer ${credentials.token}` } : null;
}

/**
 * Env vars that hard-disable submission.
 *
 * `0SEC_OFFLINE` is the pre-existing convention in this repo (see
 * `../utils/update-check.ts`, which uses it to suppress the update ping), so
 * an operator who already sets it to keep 0sec off the network gets the
 * behaviour they asked for without learning a second knob. `0SEC_NO_TELEMETRY`
 * is added as the name people reach for, and `DO_NOT_TRACK` is honoured
 * because it is the cross-tool standard.
 */
export const FEEDBACK_OPT_OUT_ENV = ["0SEC_OFFLINE", "0SEC_NO_TELEMETRY", "DO_NOT_TRACK"] as const;

/** Request timeout. Short: this is a courtesy call behind a human keystroke. */
export const FEEDBACK_TIMEOUT_MS = 5000;

/** Refuse absurd bodies rather than hanging a socket on them. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * True when `value` reads as "on".
 *
 * `update-check.ts` tests `=== "1"` exactly. This is deliberately more
 * permissive, because the two have opposite failure directions: there, a
 * missed opt-out costs a suppressed update nudge; here, a missed opt-out means
 * client data crosses a boundary someone explicitly tried to close. Someone
 * who supplies `0SEC_OFFLINE=true` for a command has unambiguously stated an
 * intent, and honouring only `1` would transmit anyway. Anything set and not
 * explicitly falsy counts as opt-out.
 */
function isOptOutSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return false;
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * The configured endpoint, or the authenticated dashboard receiver associated
 * with `0sec auth login`. Scheme validation stays in
 * {@link submissionBlockedReason}, so callers can distinguish absent from
 * refused configuration.
 */
export function feedbackEndpoint(
  env: FeedbackEnv = process.env,
  options: FeedbackResolveOptions = {},
): string | null {
  return resolveFeedbackTarget(env, options)?.url ?? null;
}

/**
 * Why submission cannot happen, or null if it can. Lets the UI grey out the
 * send affordance with a real reason instead of discovering it post-hoc.
 */
export function submissionBlockedReason(
  env: FeedbackEnv = process.env,
  options: FeedbackResolveOptions = {},
): SubmitSkipReason | null {
  // Opt-out is checked first and wins over everything, including an
  // explicitly configured endpoint. That precedence is the point: the org
  // policy must beat the individual operator's request.
  for (const name of FEEDBACK_OPT_OUT_ENV) {
    if (isOptOutSet(env[name])) return "opt-out";
  }
  return targetBlockedReason(resolveFeedbackTarget(env, options));
}

function targetBlockedReason(target: FeedbackTarget | null): SubmitSkipReason | null {
  if (target === null) return "no-endpoint";
  let parsed: URL;
  try {
    parsed = new URL(target.url);
  } catch {
    return "insecure-endpoint";
  }
  // HTTPS only. Feedback bodies carry engagement context; plaintext would put
  // it in front of anything on the path, which is exactly the audience we are
  // trying to keep it away from.
  if (parsed.protocol !== "https:") return "insecure-endpoint";
  return null;
}

/** Human-readable explanation for a skip reason, for direct UI rendering. */
export function describeSkip(reason: SubmitSkipReason): string {
  switch (reason) {
    case "opt-out":
      return `Submission disabled by ${FEEDBACK_OPT_OUT_ENV.join(" / ")}. Saved locally only.`;
    case "no-endpoint":
      return `No feedback endpoint configured (set ${FEEDBACK_URL_ENV}). Saved locally only.`;
    case "insecure-endpoint":
      return `Refusing a non-HTTPS ${FEEDBACK_URL_ENV}. Saved locally only.`;
  }
}

interface SecretRule {
  label: string;
  pattern: RegExp;
}

/**
 * Credential shapes worth interrupting a human over.
 *
 * Tuned for precision rather than recall. This list is not a filter and must
 * not be read as one — it is a nudge to re-read before sending, and a nudge
 * that cries wolf gets clicked through, which is strictly worse than no nudge.
 */
const SECRET_RULES: SecretRule[] = [
  { label: "an OpenAI/Anthropic-style key (sk-…)", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "a GitHub token (ghp_/gho_/ghu_/ghs_/ghr_…)", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: "an AWS access key id (AKIA…/ASIA…)", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { label: "a Google API key (AIza…)", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "a Slack token (xox…)", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    label: "an Authorization header",
    pattern: /authorization\s*[:=]\s*(?:bearer|basic|token|digest)\s+\S+/i,
  },
  { label: "a JWT (eyJ…)", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/ },
  {
    label: "a PEM private key block",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  },
  {
    label: "a credential-shaped assignment (password=/api_key=/secret=…)",
    pattern: /\b(?:pass(?:word|wd)?|api[_-]?key|secret|token|credentials?)\s*[:=]\s*\S{6,}/i,
  },
  {
    // Long opaque runs. Requires mixed case *and* a digit so ordinary prose,
    // file paths, and hyphenated identifiers do not trip it.
    label: "a long high-entropy string (base64-ish)",
    pattern: /(?=[A-Za-z0-9+/_-]{40,})(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}/,
  },
];

/**
 * Report credential shapes found in `message`.
 *
 * Returns warnings only — `message` is never read back out and never
 * modified. Callers must surface these *before* the confirmation prompt, so
 * the decision to send is made with the finding in view.
 */
export function scanForSecrets(message: string): string[] {
  const warnings: string[] = [];
  for (const rule of SECRET_RULES) {
    // Only the shape's name is reported, never the matched text: the warning
    // may be rendered into a scrollback or a log the secret should not reach.
    if (rule.pattern.test(message)) warnings.push(`Message appears to contain ${rule.label}.`);
  }
  return warnings;
}

/**
 * Serialize the payload. The single place a body is constructed, so preview
 * and transmission cannot drift apart, and so the field allowlist is applied
 * exactly once. Optional fields are omitted when absent rather than sent as
 * null, keeping the wire form minimal.
 */
function serializePayload(payload: FeedbackPayload): string {
  const body: Record<string, string> = {
    message: payload.message,
    timestamp: payload.timestamp,
  };
  if (payload.version !== undefined) body.version = payload.version;
  if (payload.model !== undefined) body.model = payload.model;
  if (payload.mode !== undefined) body.mode = payload.mode;
  return JSON.stringify(body);
}

function requestHeaders(target: FeedbackTarget, redactAuthorization = false): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (target.authorization) {
    headers.authorization = redactAuthorization ? "Bearer <redacted>" : target.authorization;
  }
  return headers;
}

/**
 * The exact body and safe-to-display headers {@link submitFeedback} would use,
 * or null when {@link submissionBlockedReason} says it would make none.
 */
export function buildSubmitPreview(
  payload: FeedbackPayload,
  env: FeedbackEnv = process.env,
  options: FeedbackResolveOptions = {},
): SubmitPreview | null {
  if (submissionBlockedReason(env, options) !== null) return null;
  const target = resolveFeedbackTarget(env, options);
  if (target === null) return null;
  return {
    url: target.url,
    body: serializePayload(payload),
    headers: requestHeaders(target, true),
    warnings: scanForSecrets(payload.message),
  };
}

export interface SubmitOptions extends FeedbackResolveOptions {
  /** Injected transport, matching the repo's `fetchImpl` convention. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * When set, the transport re-derives the current endpoint, body, and
   * redacted-authorization headers and rejects (zero POST) if they differ
   * from the reviewed preview. This protects the operator from sending to a
   * destination they did not explicitly approve — the preview shown in the
   * confirmation dialog is locked to the bytes that actually go on the wire.
   *
   * Local opt-out and credential availability are re-evaluated from live state.
   * Header names and redacted values must match, but token contents are neither
   * compared nor persisted: credential rotation is allowed, not identity-bound
   * by this preview check.
   */
  expectedPreview?: SubmitPreview;
}

/**
 * Transmit one message, once.
 *
 * Never throws, never retries, never blocks past `timeoutMs`. The caller has
 * already written the message to disk, so every failure path here is
 * cosmetic — the correct response to `ok: false` is to tell the operator the
 * local copy is still there, not to try again.
 */
export async function submitFeedback(
  payload: FeedbackPayload,
  env: FeedbackEnv = process.env,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const blocked = submissionBlockedReason(env, opts);
  if (blocked !== null) return { ok: false, skipped: blocked, error: describeSkip(blocked) };

  const target = resolveFeedbackTarget(env, opts);
  const targetBlocked = targetBlockedReason(target);
  if (targetBlocked !== null) return { ok: false, skipped: targetBlocked, error: describeSkip(targetBlocked) };
  if (target === null) return { ok: false, skipped: "no-endpoint", error: describeSkip("no-endpoint") };

  const body = serializePayload(payload);
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, error: `Message too large to submit (limit ${MAX_BODY_BYTES} bytes).` };
  }

  // Re-derive the current preview shape and reject if it no longer matches
  // the caller's reviewed preview. The token is never compared — only the
  // redacted form, so token rotation between preview and send still allows
  // submission (the redacted form is always "Bearer <redacted>").
  const reviewed = opts.expectedPreview;
  if (reviewed !== undefined) {
    const currentHeaders = requestHeaders(target, true);

    if (
      target.url !== reviewed.url ||
      body !== reviewed.body ||
      Object.keys(currentHeaders).length !== Object.keys(reviewed.headers).length ||
      !Object.keys(currentHeaders).every((k) => currentHeaders[k] === reviewed.headers[k])
    ) {
      return {
        ok: false,
        error:
          "Reviewed feedback destination has changed. Preview the updated submission before sending again.",
      };
    }
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FEEDBACK_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Raced rather than relying on the abort signal alone: a transport that
  // ignores `signal` (a stub, a patched global, a future undici quirk) would
  // otherwise hang a keystroke-driven UI forever. The race makes the bound
  // ours instead of the transport's.
  const timeout = new Promise<SubmitResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: `Feedback submission timed out after ${timeoutMs}ms.` });
    }, timeoutMs);
    // Do not hold the event loop open on this timer alone.
    (timer as { unref?: () => void }).unref?.();
  });

  const attempt = (async (): Promise<SubmitResult> => {
    try {
      const response = await doFetch(target.url, {
        method: "POST",
        headers: requestHeaders(target),
        body,
        signal: controller.signal,
        redirect: "error",
      });
      return response.ok
        ? { ok: true, status: response.status }
        : { ok: false, status: response.status, error: `Endpoint returned ${response.status}.` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Diagnostic auto-report
// ---------------------------------------------------------------------------

export interface DiagnosticInfo {
  kind: "tool" | "runtime";
  version: string;
  platform: string;
  arch: string;
  runtime: string;
  runtimeVersion: string;
  toolName?: string;
  /**
   * The failure. Two uses, kept strictly apart:
   *   - On the WIRE ({@link buildDiagnosticFeedback}) only its finite *category*
   *     is read (via {@link diagnosticError}) — never the message/stack/output.
   *   - LOCALLY ({@link buildDiagnosticReview}) its real text is shown to the
   *     operator so they can see what actually failed, and decide.
   */
  error?: unknown;
  /**
   * Optional captured process output (stdout/stderr/exit notice) for the
   * LOCAL review only. Never transmitted. Usually redundant now that the core
   * loop already folds an `exited N: <tail>` summary into the `error` string,
   * but accepted for callers that carry it separately.
   */
  exitOutput?: string;
  timestamp?: string;
}

export const MAX_DIAGNOSTIC_MESSAGE_BYTES = 512;
const DIAGNOSTIC_PLATFORMS = new Set(["darwin", "linux", "win32", "aix", "freebsd", "openbsd", "sunos"]);
const DIAGNOSTIC_ARCHS = new Set(["x64", "arm64", "arm", "ia32", "s390", "mips", "ppc64"]);
const DIAGNOSTIC_RUNTIMES = new Set(["node", "bun", "deno"]);

/**
 * Classify arbitrary failure text into a FINITE, safe category — never the raw
 * text. Tool failures arrive as strings ("exited 1: …", "ENOENT …"), and
 * returning a bare "unknown" for them (the old behaviour) told the operator
 * nothing. These buckets name the failure MODE without transmitting any path,
 * host, payload or other engagement data. Returns null when nothing matches.
 */
function classifyFailureText(text: string): string | null {
  const t = text.toLowerCase();
  if (/exited?\s+-?\d+|exit code|non-?zero exit/.test(t)) return "nonzero-exit";
  if (/enoent|no such file|command not found|not found on path|cannot find (?:module|the )/.test(t)) return "not-found";
  if (/etimedout|timed out|\btimeout\b|deadline exceeded/.test(t)) return "timeout";
  if (/econnrefused|econnreset|epipe|network|fetch failed|socket hang up|getaddrinfo|dns|tls|certificate/.test(t)) return "network";
  if (/eacces|eperm|permission denied|forbidden|unauthor|401|403/.test(t)) return "permission";
  if (/rate.?limit|too many requests|\b429\b|quota|overloaded/.test(t)) return "rate-limit";
  if (/unexpected token|json|yaml|parse error|invalid json|malformed/.test(t)) return "parse";
  if (/out of memory|enomem|heap|maximum call stack/.test(t)) return "resource";
  if (/stream completed without final response|response stream failed|incomplete/.test(t)) return "stream-incomplete";
  return null;
}

function diagnosticError(error: unknown): string {
  try {
    // Named built-in error classes first — the class is already finite + safe.
    if (error instanceof TypeError) return "TypeError";
    if (error instanceof ReferenceError) return "ReferenceError";
    if (error instanceof SyntaxError) return "SyntaxError";
    if (error instanceof RangeError) return "RangeError";
    if (error instanceof URIError) return "URIError";
    if (error instanceof EvalError) return "EvalError";
    if (error instanceof Error) {
      // A plain Error: classify its message into a finite mode so a generic
      // `new Error("exited 1: …")` reports "Error:nonzero-exit", not just "Error".
      const mode = classifyFailureText(error.message ?? "");
      return mode ? `Error:${mode}` : "Error";
    }
    if (typeof error === "string") {
      // Tool failures are strings — classify the mode; an uncategorised one is
      // still a finite "tool-error", never the useless "unknown".
      return classifyFailureText(error) ?? "tool-error";
    }
  } catch { /* A hostile proxy must not break error reporting. */ }
  return "unknown";
}

/** Numeric release identity only; custom build labels may contain private data. */
function diagnosticVersion(raw: string): string {
  if (typeof raw !== "string" || raw.length > 128) return "unknown";
  return /^v?(\d{1,6}\.\d{1,6}\.\d{1,6})(?:[-+][a-zA-Z0-9.+-]+)?$/.exec(raw)?.[1] ?? "unknown";
}

/**
 * Finite diagnostics only. Arbitrary tool names, error text, build suffixes,
 * paths and environment values never enter the existing feedback wire body.
 * This builder performs no I/O and grants no permission to transmit.
 */
export function buildDiagnosticFeedback(info: DiagnosticInfo, env: NodeJS.ProcessEnv = process.env): FeedbackPayload {
  const kind = info.kind === "tool" ? "tool" : info.kind === "runtime" ? "runtime" : "unknown";
  const platform = DIAGNOSTIC_PLATFORMS.has(info.platform) ? info.platform : "unknown";
  const arch = DIAGNOSTIC_ARCHS.has(info.arch) ? info.arch : "unknown";
  const runtime = DIAGNOSTIC_RUNTIMES.has(info.runtime) ? info.runtime : "unknown";
  const runtimeVersion = diagnosticVersion(info.runtimeVersion);
  const version = diagnosticVersion(info.version);
  const timestamp = typeof info.timestamp === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(info.timestamp)
    && Number.isFinite(Date.parse(info.timestamp)) ? info.timestamp : new Date().toISOString();
  // The finite header: all interpolated values are finite labels or bounded
  // numeric versions, so this stays below MAX_DIAGNOSTIC_MESSAGE_BYTES.
  let message = `Diagnostic: ${kind} error — ${platform}/${arch} on ${runtime} ${runtimeVersion}\nVersion: ${version}\nError: ${diagnosticError(info.error)}`;
  // When — and ONLY when — the operator has consented to sharing commands/code
  // (analyticsLevel `commands` or `full`, surfaced to core+cli as the
  // 0SEC_ANALYTICS_LEVEL env var), append the REDACTED full failure detail:
  // the error type, its message, the stack frames and any captured output,
  // with credentials, API keys, tokens, private keys and emails scrubbed and
  // home-dir usernames anonymised. Without that consent the wire body is the
  // finite category exactly as before — byte-capped and leak-free — so the
  // default privacy contract (and its tests) is untouched.
  if (diagnosticDetailAllowed(env)) {
    const detail = redactDiagnosticDetail(buildDiagnosticDetailText(info));
    if (detail) message = capUtf8Bytes(`${message}\n\n${detail}`, MAX_DIAGNOSTIC_DETAIL_MESSAGE_BYTES);
  }
  return { message, timestamp, version };
}

/**
 * The larger wire cap for the consented, redacted detail path. Big enough for a
 * real stack trace, still bounded so a runaway error can never balloon the POST.
 */
export const MAX_DIAGNOSTIC_DETAIL_MESSAGE_BYTES = 8192;
/** Longest detail body assembled before redaction/capping. */
const MAX_DIAGNOSTIC_DETAIL_CHARS = 6000;

/**
 * True only when the operator has opted into sharing command/code-level detail
 * (analyticsLevel `commands` or `full`). Read from the env bridge the CLI sets
 * from the setting, so core and cli agree without a settings-store import. An
 * absent/`off`/`usage` value keeps diagnostics at the finite-category default.
 */
function diagnosticDetailAllowed(env: NodeJS.ProcessEnv): boolean {
  const level = (env["0SEC_ANALYTICS_LEVEL"] ?? "").trim().toLowerCase();
  return level === "commands" || level === "full";
}

/**
 * Assemble the FULL failure detail (pre-redaction): tool name, error type +
 * message, stack frames, and any separately-captured exit output. Bounded to
 * {@link MAX_DIAGNOSTIC_DETAIL_CHARS}. The caller redacts before it goes on any
 * wire; this function performs no I/O.
 */
function buildDiagnosticDetailText(info: DiagnosticInfo): string {
  const parts: string[] = [];
  if (info.toolName) parts.push(`Tool: ${info.toolName}`);
  const err = info.error;
  if (err instanceof Error) {
    parts.push(`${err.name}: ${err.message || "(no message)"}`);
    if (typeof err.stack === "string" && err.stack.trim()) parts.push(err.stack.trim());
  } else {
    const text = diagnosticErrorText(err);
    if (text) parts.push(text);
  }
  const exitOutput = typeof info.exitOutput === "string" ? info.exitOutput.trim() : "";
  if (exitOutput && !parts.some((p) => p.includes(exitOutput))) parts.push(exitOutput);
  let detail = parts.join("\n").trim();
  if (detail.length > MAX_DIAGNOSTIC_DETAIL_CHARS) detail = detail.slice(0, MAX_DIAGNOSTIC_DETAIL_CHARS - 1) + "…";
  return detail;
}

/** Credential/PII patterns applied as REPLACE (the hard redaction floor). */
const DETAIL_REDACTIONS: { re: RegExp; to: string }[] = [
  { re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, to: "‹redacted:private-key›" },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, to: "‹redacted:key›" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, to: "‹redacted:gh-token›" },
  { re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, to: "‹redacted:aws-key›" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, to: "‹redacted:gcp-key›" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, to: "‹redacted:slack-token›" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, to: "‹redacted:jwt›" },
  { re: /authorization\s*[:=]\s*(?:bearer|basic|token|digest)\s+\S+/gi, to: "authorization: ‹redacted›" },
  { re: /\b((?:pass(?:word|wd)?|api[_-]?key|secret|token|credentials?)\s*[:=]\s*)\S{6,}/gi, to: "$1‹redacted›" },
  // Connection strings: keep the scheme/host shape, drop the inline credentials.
  // MUST run before the email rule so `user:pass@host` is not mis-read as an
  // email (which would swallow the host too).
  { re: /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, to: "$1‹redacted›@" },
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: "‹redacted:email›" },
  // Home-dir usernames in file paths — keep the path shape, anonymise the user.
  { re: /(\/home\/)[^/\s]+/g, to: "$1‹user›" },
  { re: /(\/Users\/)[^/\s]+/g, to: "$1‹user›" },
  { re: /([A-Za-z]:\\Users\\)[^\\\s]+/g, to: "$1‹user›" },
];

/**
 * Redact the HARD-floor secrets and PII from the detail before it goes on the
 * wire: credentials, API keys, tokens, private keys, JWTs, auth headers, inline
 * connection-string passwords, emails and home-dir usernames. This is the
 * safety floor that always applies to the consented detail path — it does NOT
 * strip target hostnames, IPs or tool names, which the operator has opted to
 * share by enabling the commands/full tier. Never throws.
 */
export function redactDiagnosticDetail(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  try {
    let out = text;
    for (const { re, to } of DETAIL_REDACTIONS) out = out.replace(re, to);
    return out;
  } catch {
    // A pathological input must never leak raw: drop it entirely.
    return "";
  }
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function capUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes - 1) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

// ---------------------------------------------------------------------------
// Operator-facing local detail (never transmitted)
// ---------------------------------------------------------------------------
//
// The wire body above is deliberately coarse: it reports a finite error
// *category* and nothing else, because engagement data must not leave the
// boundary. But the operator sitting at the console needs the opposite — the
// REAL reason a tool failed, or they are back to reading "Error: unknown".
//
// These helpers resolve that tension: they produce the full, unredacted detail
// for the human's REVIEW only. They perform no I/O, and nothing here is ever
// fed to {@link serializePayload} / {@link buildSubmitPreview} — the wire
// payload is still built solely by {@link buildDiagnosticFeedback}, so the
// privacy guarantee (and its tests) are untouched.

/** Longest local detail we render; local-only, so generous but still bounded. */
export const MAX_LOCAL_DETAIL_CHARS = 4000;

/**
 * Header the UI should show above {@link DiagnosticReview.localDetail} so the
 * operator understands the detail stays on their machine.
 */
export const LOCAL_DETAIL_NOTICE = "Shown to you locally; not transmitted.";

/**
 * The REAL error text, for LOCAL display.
 *
 * Unlike {@link diagnosticError} — which maps to a finite category label for
 * the wire and (by design) returns "unknown" for a plain string — this returns
 * the actual message so the operator can read what failed. A thrown Error's
 * empty `.message` falls back to its `.name`; returns "" only when there is
 * genuinely no text to show. Never regex-classifies and never touches the wire.
 */
export function diagnosticErrorText(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (error instanceof Error) return (error.message || error.name || "Error").trim();
  if (error === null || error === undefined) return "";
  try {
    const text = String(error).trim();
    return text === "[object Object]" ? "" : text;
  } catch {
    // A hostile proxy must not break the review.
    return "";
  }
}

export interface DiagnosticReview {
  /**
   * The privacy-bounded payload that would go on the wire — byte-identical to
   * {@link buildDiagnosticFeedback}. Finite labels only; safe to transmit.
   */
  payload: FeedbackPayload;
  /**
   * The FULL failure detail for the operator's review ONLY. Carries the real
   * error message and any captured exit output. NEVER transmitted. Empty only
   * when there is genuinely no detail to show.
   */
  localDetail: string;
}

/**
 * Build both halves of a diagnostic report in one call: the coarse,
 * transmit-safe {@link FeedbackPayload} AND the full local-only detail the
 * operator reviews before deciding whether to send. This is what a review
 * surface should render so the operator sees the real reason instead of a bare
 * "Error: unknown". The `localDetail` must never be handed to the transport.
 */
export function buildDiagnosticReview(info: DiagnosticInfo): DiagnosticReview {
  const payload = buildDiagnosticFeedback(info);
  const message = diagnosticErrorText(info.error);
  const lines: string[] = [];
  if (info.toolName) lines.push(`Tool: ${info.toolName}`);
  // Show the real message when one exists; only fall back to an honest,
  // named line when there is truly nothing — never a bare "unknown".
  lines.push(message ? `Error: ${message}` : `Error: ${info.kind} failed without an error message`);
  const exitOutput = typeof info.exitOutput === "string" ? info.exitOutput.trim() : "";
  // The core loop already folds an `exited N: <tail>` summary into the error
  // string; append separately-carried output only when it is not already there.
  if (exitOutput && !message.includes(exitOutput)) lines.push(exitOutput);
  let localDetail = lines.join("\n");
  if (localDetail.length > MAX_LOCAL_DETAIL_CHARS) {
    localDetail = localDetail.slice(0, MAX_LOCAL_DETAIL_CHARS - 1) + "…";
  }
  return { payload, localDetail };
}

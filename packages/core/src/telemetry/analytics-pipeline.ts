/**
 * The single analytics CHOKE POINT.
 *
 * This module owns the ONLY code path in the engine that may transmit
 * analytics. Every record — regardless of source — must pass through the
 * private `enqueue` step, which unconditionally:
 *
 *   1. Gates on the resolved consent tier (`levelAtLeast`). Below the tier a
 *      record needs, it is dropped and nothing is transmitted or logged.
 *   2. Runs `redactContent` over EVERY string in the record (keys included),
 *      so a secret that reached a counter label or free-text field is scrubbed
 *      before it can leave the process.
 *   3. Attaches random install/session identifiers and finite runtime metadata.
 *      Authenticated delivery is attributable; the identifiers are not a
 *      guarantee of anonymity.
 *   4. Batches and transmits fire-and-forget to `/api/cli-analytics`.
 *
 * SAFETY CONTRACT:
 *   - No other module may POST analytics. If a second transmit path ever
 *     appears, the consent gate and the redaction boundary are defeated.
 *   - Telemetry must NEVER block or break an audit: every path is wrapped in
 *     try/catch, transmission is fire-and-forget with a short timeout, and a
 *     failure (offline, DNS, 500, no credentials) is a silent no-op.
 *   - USAGE tier: the bus sink derives aggregate COUNTERS (tool names, counts,
 *     error categories, durations, cost) from the event bus. It never reads raw
 *     content — the bus only carries a bounded preview and this sink
 *     deliberately ignores it.
 *   - COMMANDS tier: tool call records (command, args, output) and code snippets.
 *   - FULL tier: scope entries and findings.
 *
 * On a level downgrade, disallowed pending records are purged. Explicit off
 * unsubscribes the bus sink; environment opt-outs also gate accumulation.
 * Every POST re-checks each record's required tier against the live level.
 */

import { homeStateDir, VERSION } from "@0/shared"
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { eventBus, type EventSink, type EventType } from "../events/bus.js";
import { loadCloudCredentials } from "../cloud/credentials.js";
import {
  levelAtLeast,
  resolveAnalyticsLevel,
  type AnalyticsLevel,
} from "./analytics-level.js";
import { getInstallId, newSessionId } from "./install-id.js";
import { MAX_CONTENT_BYTES, redactContent, type RedactContext } from "./redaction.js";
import type {
  AnalyticsEnvelope,
  CodeRecord,
  CommandRecord,
  FindingRecord,
  FiniteArch,
  FinitePlatform,
  FiniteRuntime,
  ScopeRecord,
  UsageRecord,
} from "./schema.js";

/** Wire schema version for the analytics payload. */
export const ANALYTICS_SCHEMA_VERSION = 1;

/** Endpoint (relative to the resolved cloud host) that receives batches. */
export const ANALYTICS_ENDPOINT = "/api/cli-analytics";

/** Transparency log filename under `~/.0`. */
export const ANALYTICS_SENT_LOG_FILENAME = "analytics-sent.log";

/** Short transmit timeout (ms) — telemetry never blocks an audit. */
const TRANSMIT_TIMEOUT_MS = 4000;

/** Debounce (ms) before a dirty usage accumulator is snapshotted + enqueued. */
const USAGE_FLUSH_DEBOUNCE_MS = 2000;

/** Debounce (ms) before a non-empty batch is POSTed. */
const TRANSMIT_DEBOUNCE_MS = 500;

/**
 * Maximum records in a single POST body (receiver limit).
 * Encoded JSON body must also fit within {@link MAX_BODY_BYTES}.
 */
const MAX_RECORDS_PER_BATCH = 100;

/**
 * Maximum encoded POST body size in bytes (receiver limit).
 * Includes the `{"records":[…]}` wrapper.
 */
export const MAX_BODY_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Finite host labels (mirror feedback.ts / schema.ts allowlists)
// ---------------------------------------------------------------------------
//
// core must not import @0/cli, so the finite value sets from the CLI's
// diagnostic allowlists are re-declared here. Anything not in a set collapses
// to "unknown", so no free-form host string is ever transmitted. Keep in sync
// with DIAGNOSTIC_* in packages/cli/src/tui/feedback.ts and the Finite* unions
// in ./schema.ts.

const FINITE_PLATFORMS: ReadonlySet<string> = new Set<FinitePlatform>([
  "darwin", "linux", "win32", "aix", "freebsd", "openbsd", "sunos",
]);
const FINITE_ARCHS: ReadonlySet<string> = new Set<FiniteArch>([
  "x64", "arm64", "arm", "ia32", "s390", "mips", "ppc64",
]);
const FINITE_RUNTIMES: ReadonlySet<string> = new Set<FiniteRuntime>([
  "node", "bun", "deno",
]);

function finitePlatform(): FinitePlatform {
  const p = process.platform;
  return FINITE_PLATFORMS.has(p) ? (p as FinitePlatform) : "unknown";
}

function finiteArch(): FiniteArch {
  const a = process.arch;
  return FINITE_ARCHS.has(a) ? (a as FiniteArch) : "unknown";
}

function detectRuntime(): FiniteRuntime {
  try {
    const g = globalThis as Record<string, unknown>;
    if (typeof g["Bun"] !== "undefined") return "bun";
    if (typeof g["Deno"] !== "undefined") return "deno";
    if (typeof process !== "undefined" && process.versions?.node) return "node";
  } catch {
    /* fall through */
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Error-category classification (mirrors classifyFailureText in feedback.ts)
// ---------------------------------------------------------------------------
//
// Same finite failure-MODE buckets as the CLI's diagnostic classifier, so a
// tool error becomes a safe category label ("timeout", "network", …) and never
// leaks a path, host, or payload. Re-declared here because core cannot depend
// on @0/cli — keep in sync with feedback.ts.

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

// ---------------------------------------------------------------------------
// Record redaction (the choke-path scrubber)
// ---------------------------------------------------------------------------

const SENSITIVE_FIELD = /^(?:password|passwd|pwd|secret|client[_-]?secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|credentials?|x[-_].*(?:key|auth|token|secret))$/i;

const CONTENT_FIELDS = ["argsRedacted", "outputRedacted", "sourceRedacted"] as const;
const BODY_PREFIX = '{"records":[';
const BODY_SUFFIX = "]}";
const BODY_OVERHEAD_BYTES = BODY_PREFIX.length + BODY_SUFFIX.length;

/**
 * Recursively run {@link redactContent} over every string in a record —
 * VALUES and object KEYS alike (a counter label is a tool / category name and
 * could, in the MCP case, carry attacker-influenced text). Numbers and
 * booleans pass through untouched. Never throws: on any failure the field is
 * dropped rather than emitted raw.
 *
 * Content fields are redacted without truncation; enqueue checks their UTF-8
 * byte limits. Other strings retain the bounded metadata policy.
 */
export function redactRecordStrings<T>(value: T, context: RedactContext = {}): T {
  try {
    if (typeof value === "string") return redactContent(value, context) as unknown as T;
    if (Array.isArray(value)) {
      if (value.length === 2 && typeof value[0] === "string" && SENSITIVE_FIELD.test(value[0])) return [value[0], "<REDACTED-SECRET>"] as unknown as T;
      return value.map((v) => redactRecordStrings(v, context)) as unknown as T;
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = Object.create(null);
      const namedField = (value as Record<string, unknown>).name;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // Redact the key too; keep a stable fallback so a dropped key never
        // silently merges two distinct counters into "".
        const rk = redactContent(k, context) || "<redacted-key>";
        out[rk] = SENSITIVE_FIELD.test(k) || (k === "value" && typeof namedField === "string" && SENSITIVE_FIELD.test(namedField))
          ? "<REDACTED-SECRET>"
          : typeof v === "string" && CONTENT_FIELDS.includes(k as typeof CONTENT_FIELDS[number])
            ? redactContent(v, { ...context, maxChars: Number.POSITIVE_INFINITY })
            : redactRecordStrings(v, context);
      }
      return out as unknown as T;
    }
    return value;
  } catch {
    return undefined as T;
  }
}

/**
 * Coerce an arbitrary collector input into a single string suitable for a
 * `*Redacted` field. The result is still raw here — {@link enqueue} runs
 * {@link redactContent} over it before anything leaves the process. Never
 * throws: an unstringifiable value collapses to "".
 */
function toText(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Coerce a possibly-non-finite number to a safe finite value (default 0). */
function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Coerce a value to a non-empty label, defaulting to "unknown". */
function label(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

// ---------------------------------------------------------------------------
// Usage accumulator (bus-derived counters only)
// ---------------------------------------------------------------------------

interface UsageAccumulator {
  featureCounts: Record<string, number>;
  findingCounts: Record<string, number>;
  errorCategories: Record<string, number>;
  turnCount: number;
  durationMs: number;
  costUsd: number;
  hasCost: boolean;
}

function emptyAccumulator(): UsageAccumulator {
  return {
    featureCounts: {},
    findingCounts: {},
    errorCategories: {},
    turnCount: 0,
    durationMs: 0,
    costUsd: 0,
    hasCost: false,
  };
}

function bump(map: Record<string, number>, key: string): void {
  const k = typeof key === "string" && key.length > 0 ? key : "unknown";
  map[k] = (map[k] ?? 0) + 1;
}

export type FetchImpl = typeof fetch;

/** Options for constructing the pipeline (tests inject home dir + fetch). */
export interface AnalyticsPipelineOptions {
  homeDir?: string;
  fetchImpl?: FetchImpl;
}

/**
 * The analytics pipeline singleton. The choke point: `enqueue` is the only
 * code allowed to hand a payload toward transmission.
 */
class AnalyticsPipeline {
  private level: AnalyticsLevel = "off";
  private observedLevel: AnalyticsLevel = "off";
  private transmitting: Promise<void> | null = null;
  private homeDir: string | undefined;
  private fetchImpl: FetchImpl | undefined;

  private installId: string | null = null;
  private readonly sessionId = newSessionId();

  private acc: UsageAccumulator = emptyAccumulator();
  private accDirty = false;

  /**
   * Queued payload + the tier it was enqueued at. The tier is kept so on
   * downgrade we can purge records that are no longer permitted, and so
   * transmit can re-check each record against the live level.
   */
  private batch: Array<{ json: string; bytes: number; requiredTier: AnalyticsLevel }> = [];

  private usageFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private transmitTimer: ReturnType<typeof setTimeout> | null = null;

  private unsubscribe: (() => void) | null = null;

  /** The bus sink that derives usage COUNTERS. No raw content is read. */
  private readonly sink: EventSink = {
    emit: (type, payload) => this.onBusEvent(type, payload),
  };

  /** Configure home dir / fetch impl (tests). Safe to call before subscribe. */
  configure(opts: AnalyticsPipelineOptions): void {
    if (opts.homeDir !== undefined) this.homeDir = opts.homeDir;
    if (opts.fetchImpl !== undefined) this.fetchImpl = opts.fetchImpl;
  }

  /**
   * Update the cached consent tier live (e.g. a /settings change).
   *
   * Downgrading the level purges any queued records that are no longer
   * permitted. Switching to "off" also unsubscribes the bus sink and resets
   * the usage accumulator so events emitted while off are never queued.
   * Switching from "off" to a non-off level subscribes the sink with a fresh
   * accumulator.
   */
  setLevel(level: AnalyticsLevel): void {
    const wasOff = this.level === "off";

    // ── Purge queued records that exceed the new level ──────────────────
    if (!levelAtLeast(level, this.level)) {
      // Downgrade: drop records above the new tier.
      this.batch = this.batch.filter((entry) =>
        levelAtLeast(level, entry.requiredTier),
      );
    }

    this.level = level;
    this.effectiveLevel();

    if (level === "off") {
      // Unsubscribe sink so no usage is accumulated while off.
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.acc = emptyAccumulator();
      this.accDirty = false;
      this.batch = [];
    } else {
      if (wasOff) {
        // Coming back from off — start fresh, don't flush stale events.
        this.acc = emptyAccumulator();
        this.accDirty = false;
      }
      this.ensureSubscribed();
    }
  }

  /** Current tier after live environment restrictions. */
  getLevel(): AnalyticsLevel {
    return this.effectiveLevel();
  }

  /**
   * The effective consent tier: minimum of the stored (saved/configured) tier
   * and the environment-resolved tier. This ensures an explicit env override
   * (e.g. `ZERO_ANALYTICS_LEVEL=off` in the parent shell) can never be
   * bypassed by a cached "full" pipeline. Also re-checks opt-out env vars
   * at every call, so a late-set `ZERO_OFFLINE` still takes effect.
   */
  private effectiveLevel(): AnalyticsLevel {
    const envLevel = resolveAnalyticsLevel();
    const level = levelAtLeast(this.level, envLevel) ? envLevel : this.level;
    if (!levelAtLeast(level, this.observedLevel)) {
      this.batch = this.batch.filter((entry) => levelAtLeast(level, entry.requiredTier));
      if (level === "off") {
        this.acc = emptyAccumulator();
        this.accDirty = false;
      }
    }
    this.observedLevel = level;
    return level;
  }

  /** True iff the bus sink is currently subscribed. */
  isActive(): boolean {
    return this.unsubscribe !== null;
  }

  /**
   * Subscribe the usage sink to the event bus, idempotently. Callers should
   * prefer `maybeSubscribeAnalyticsPipeline()`, which resolves the tier first.
   */
  ensureSubscribed(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = eventBus.subscribe(this.sink);
  }

  // ── Bus-derived usage counters ────────────────────────────────────────

  private onBusEvent(type: EventType, payload: Record<string, unknown>): void {
    try {
      // Never accumulate usage while the effective level is below usage;
      // the sink stays subscribed so other consumers still receive events,
      // but our state stays clean.
      if (!levelAtLeast(this.effectiveLevel(), "usage")) return;

      switch (type) {
        case "tool_call_started": {
          const tool = typeof payload["tool"] === "string" ? (payload["tool"] as string) : "unknown";
          bump(this.acc.featureCounts, tool);
          this.markDirty();
          break;
        }
        case "tool_call_completed": {
          if (payload["status"] === "error") {
            const errText = typeof payload["error"] === "string" ? (payload["error"] as string) : "";
            const category = classifyFailureText(errText) ?? "tool-error";
            bump(this.acc.errorCategories, category);
            this.markDirty();
          }
          break;
        }
        case "finding_ingested": {
          const category = typeof payload["category"] === "string" && (payload["category"] as string).length > 0
            ? (payload["category"] as string)
            : typeof payload["severity"] === "string" && (payload["severity"] as string).length > 0
              ? (payload["severity"] as string)
              : "unknown";
          bump(this.acc.findingCounts, category);
          this.markDirty();
          break;
        }
        case "cost_update": {
          const cost = payload["cost_usd"];
          if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
            // cost_update carries a running session total — keep the latest.
            this.acc.costUsd = cost;
            this.acc.hasCost = true;
            this.markDirty();
          }
          break;
        }
        case "agent_turn_completed": {
          this.acc.turnCount += 1;
          const dur = payload["duration_ms"];
          if (typeof dur === "number" && Number.isFinite(dur) && dur >= 0) {
            this.acc.durationMs += dur;
          }
          this.markDirty();
          break;
        }
        default:
          // agent_turn_started and every other event carry no usage counter.
          break;
      }
    } catch {
      // A malformed payload must never abort a scan.
    }
  }

  private markDirty(): void {
    this.accDirty = true;
    if (this.usageFlushTimer) return;
    try {
      this.usageFlushTimer = setTimeout(() => {
        this.usageFlushTimer = null;
        this.snapshotUsage();
      }, USAGE_FLUSH_DEBOUNCE_MS);
      this.usageFlushTimer.unref?.();
    } catch {
      // Timer scheduling failure — snapshot lazily on the next flushNow().
    }
  }

  /** Build a UsageRecord from the current cumulative accumulator + enqueue. */
  private snapshotUsage(): void {
    if (!this.accDirty) return;
    this.accDirty = false;
    const record: UsageRecord = {
      kind: "usage",
      featureCounts: { ...this.acc.featureCounts },
      findingCounts: { ...this.acc.findingCounts },
      errorCategories: { ...this.acc.errorCategories },
      turnCount: this.acc.turnCount,
      durationMs: this.acc.durationMs,
      ...(this.acc.hasCost ? { costUsd: this.acc.costUsd } : {}),
    };
    this.enqueue(record as unknown as Record<string, unknown>, "usage");
  }

  // ── Direct collectors (commands / full tiers) ─────────────────────────
  //
  // Every collector below GATES AT THE CALL SITE FIRST: it checks
  // `levelAtLeast(this.level, requiredTier)` and returns before it assembles
  // the record, so the raw args / output / source / target / finding fields
  // are never even copied out of the caller — let alone redacted, enveloped,
  // or queued — below the consented tier. The subsequent `enqueue` gate is a
  // redundant second boundary. These records go DIRECT to the pipeline: they
  // are never placed on the shared event bus, so the bus payloads stay narrow.
  // Every method is no-throw and a no-op when the pipeline is "off".

  /**
   * "commands" tier: record one executed tool call. `args` / `output` are the
   * caller's raw values; they are stringified here and redacted in `enqueue`.
   */
  recordCommand(input: {
    tool: unknown;
    args: unknown;
    output: unknown;
    status: unknown;
    durationMs: unknown;
    turn: unknown;
  }): void {
    try {
      if (!levelAtLeast(this.effectiveLevel(), "commands")) return;
      const record: CommandRecord = {
        tool: label(input.tool),
        argsRedacted: toText(input.args),
        outputRedacted: toText(input.output),
        status: label(input.status),
        durationMs: finiteNumber(input.durationMs),
        turn: finiteNumber(input.turn),
      };
      this.enqueue(record as unknown as Record<string, unknown>, "commands");
    } catch {
      // Fail-soft: telemetry must never break the caller.
    }
  }

  /**
   * "commands" tier: record a model-authored code snippet. `source` is raw
   * here and redacted in `enqueue`.
   */
  recordCode(input: { lang: unknown; source: unknown; origin: unknown }): void {
    try {
      if (!levelAtLeast(this.effectiveLevel(), "commands")) return;
      const record: CodeRecord = {
        lang: label(input.lang),
        sourceRedacted: toText(input.source),
        origin: label(input.origin),
      };
      this.enqueue(record as unknown as Record<string, unknown>, "commands");
    } catch {
      // Fail-soft.
    }
  }

  /**
   * "full" tier: record an engagement scope / target entry. `target` is raw
   * here and redacted in `enqueue`.
   */
  recordScope(input: { target: unknown; kind: unknown }): void {
    try {
      if (!levelAtLeast(this.effectiveLevel(), "full")) return;
      const record: ScopeRecord = {
        targetRedacted: toText(input.target),
        kind: label(input.kind),
      };
      this.enqueue(record as unknown as Record<string, unknown>, "full");
    } catch {
      // Fail-soft.
    }
  }

  /**
   * "full" tier: record a finding. Every free-text field is raw here and
   * redacted in `enqueue`.
   */
  recordFinding(input: {
    severity: unknown;
    category: unknown;
    title: unknown;
    description: unknown;
    evidence: unknown;
    confidence: unknown;
  }): void {
    try {
      if (!levelAtLeast(this.effectiveLevel(), "full")) return;
      const record: FindingRecord = {
        severity: label(input.severity),
        category: label(input.category),
        titleRedacted: toText(input.title),
        descriptionRedacted: toText(input.description),
        evidenceRedacted: toText(input.evidence),
        confidence: finiteNumber(input.confidence),
      };
      this.enqueue(record as unknown as Record<string, unknown>, "full");
    } catch {
      // Fail-soft.
    }
  }

  // ── The choke point ───────────────────────────────────────────────────

  /** The only path to transmission: consent, redaction, byte limits, envelope. */
  private enqueue(record: Record<string, unknown>, requiredTier: AnalyticsLevel): void {
    try {
      const level = this.effectiveLevel();
      if (level === "off" || !levelAtLeast(level, requiredTier)) return;
      const redacted = redactRecordStrings(record);
      if (!redacted) return;
      for (const field of CONTENT_FIELDS) {
        const content = redacted[field];
        if (typeof content !== "string") continue;
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > MAX_CONTENT_BYTES) {
          this.reportOversize(field, bytes, MAX_CONTENT_BYTES);
          return;
        }
      }
      const json = JSON.stringify({ ...this.buildEnvelope(), ...redacted });
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes + BODY_OVERHEAD_BYTES > MAX_BODY_BYTES) {
        this.reportOversize("record", bytes + BODY_OVERHEAD_BYTES, MAX_BODY_BYTES);
        return;
      }
      this.batch.push({ json, bytes, requiredTier });
      this.scheduleTransmit();
    } catch {
      // Default-deny: malformed collector input never reaches the wire.
    }
  }

  private reportOversize(field: typeof CONTENT_FIELDS[number] | "record", bytes: number, maxBytes: number): void {
    const filename = "analytics-outcomes.log";
    try {
      const dir = homeStateDir(this.homeDir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(dir, filename),
        `${JSON.stringify({ ts: Date.now(), outcome: "oversize", field, bytes, maxBytes })}\n`,
        { mode: 0o600 });
    } catch {
      // A read-only home must not break the tool or hide the stderr outcome.
    }
    try {
      process.stderr.write(`[0sec analytics] Skipped oversized ${field}: ${bytes} UTF-8 bytes exceeds ${maxBytes}; not truncated or uploaded. Details: ${filename}.\n`);
    } catch {
      // Telemetry never breaks the caller.
    }
  }

  private buildEnvelope(): AnalyticsEnvelope {
    if (this.installId === null) {
      try {
        this.installId = getInstallId(this.homeDir ? { homeDir: this.homeDir } : {});
      } catch {
        this.installId = "unknown";
      }
    }
    return {
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      installId: this.installId,
      sessionId: this.sessionId,
      tier: this.effectiveLevel(),
      ts: Date.now(),
      cliVersion: typeof VERSION === "string" ? VERSION : "unknown",
      platform: finitePlatform(),
      arch: finiteArch(),
      runtime: detectRuntime(),
    };
  }

  private scheduleTransmit(): void {
    if (this.transmitTimer) return;
    try {
      this.transmitTimer = setTimeout(() => {
        this.transmitTimer = null;
        void this.transmit();
      }, TRANSMIT_DEBOUNCE_MS);
      this.transmitTimer.unref?.();
    } catch {
      // Scheduling failed — flushNow() can still drain the batch.
    }
  }

  /** Serialize drains so consent changes can purge every still-pending record. */
  private transmit(): Promise<void> {
    if (!this.transmitting) {
      this.transmitting = Promise.resolve().then(() => this.drain()).finally(() => {
        this.transmitting = null;
      });
    }
    return this.transmitting;
  }

  private async drain(): Promise<void> {
    this.effectiveLevel();
    if (this.batch.length === 0) return;
    let creds: { host: string; token: string };
    try {
      creds = loadCloudCredentials(this.homeDir ? { homeDir: this.homeDir } : {});
    } catch {
      this.batch = [];
      return;
    }
    while (this.batch.length > 0) {
      // Recheck before EACH POST. Unsent records remain in this.batch while
      // awaiting HTTP, so a downgrade purges them even if later re-enabled.
      const level = this.effectiveLevel();
      this.batch = this.batch.filter((entry) => levelAtLeast(level, entry.requiredTier));
      if (this.batch.length === 0) return;
      let bytes = BODY_OVERHEAD_BYTES;
      let count = 0;
      for (const entry of this.batch) {
        const nextBytes = bytes + entry.bytes + (count === 0 ? 0 : 1);
        if (count === MAX_RECORDS_PER_BATCH || nextBytes > MAX_BODY_BYTES) break;
        bytes = nextBytes;
        count++;
      }
      const chunk = this.batch.splice(0, count);
      const body = BODY_PREFIX + chunk.map((entry) => entry.json).join(",") + BODY_SUFFIX;
      for (const entry of chunk) this.appendTransparencyLog(entry.json);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRANSMIT_TIMEOUT_MS);
      timer.unref?.();
      try {
        const doFetch = this.fetchImpl ?? fetch;
        await doFetch(`${creds.host}${ANALYTICS_ENDPOINT}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": `0sec-cli/${typeof VERSION === "string" ? VERSION : "unknown"}`,
          },
          body,
          signal: controller.signal,
        });
      } catch {
        // Best-effort delivery, no retries or raw-content error reporting.
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private appendTransparencyLog(json: string): void {
    try {
      const dir = homeStateDir(this.homeDir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, ANALYTICS_SENT_LOG_FILENAME);
      appendFileSync(path, `${json}\n`, { mode: 0o600 });
    } catch {
      // Transparency logging is best-effort; never let it break transmission.
    }
  }

  // ── Test-only surface ─────────────────────────────────────────────────

  /**
   * Force any pending usage snapshot and batch transmit to run now, awaiting
   * the POST. For tests and for a deterministic flush at process exit.
   */
  async flushNow(): Promise<void> {
    if (this.usageFlushTimer) {
      try {
        clearTimeout(this.usageFlushTimer);
      } catch {
        /* ignore */
      }
      this.usageFlushTimer = null;
    }
    this.snapshotUsage();
    if (this.transmitTimer) {
      try {
        clearTimeout(this.transmitTimer);
      } catch {
        /* ignore */
      }
      this.transmitTimer = null;
    }
    await this.transmit();
  }

  /** Test-only: drive the choke path directly with an arbitrary record. */
  __enqueueForTests(record: Record<string, unknown>, requiredTier: AnalyticsLevel = "usage"): void {
    this.enqueue(record, requiredTier);
  }

  /** Test-only: reset all state to a fresh pipeline. */
  __resetForTests(): void {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {
        /* ignore */
      }
      this.unsubscribe = null;
    }
    if (this.usageFlushTimer) clearTimeout(this.usageFlushTimer);
    if (this.transmitTimer) clearTimeout(this.transmitTimer);
    this.usageFlushTimer = null;
    this.transmitTimer = null;
    this.level = "off";
    this.observedLevel = "off";
    this.homeDir = undefined;
    this.fetchImpl = undefined;
    this.installId = null;
    this.acc = emptyAccumulator();
    this.accDirty = false;
    this.batch = [];
  }
}

/** The process-wide analytics pipeline singleton. */
export const analyticsPipeline = new AnalyticsPipeline();

/**
 * Mirror of `maybeSubscribeCloudEventSink`: resolve the effective analytics
 * tier from the environment, cache it via {@link AnalyticsPipeline.setLevel},
 * and subscribe the usage sink to the event bus when non-off. The env is
 * re-read at transmit time so a late env change (e.g. `ZERO_ANALYTICS_LEVEL`
 * set before spawning a child) is still honoured. Idempotent and env-gated;
 * safe to call multiple times.
 */
export function maybeSubscribeAnalyticsPipeline(): void {
  const level = resolveAnalyticsLevel();
  analyticsPipeline.setLevel(level);
  if (level === "off") return;
  analyticsPipeline.ensureSubscribed();
}

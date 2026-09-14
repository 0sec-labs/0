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
 *   3. Attaches the anonymous envelope (install id, per-run session id, CLI
 *      version, finite platform / arch / runtime — never anything that
 *      identifies the operator).
 *   4. Batches and transmits fire-and-forget to `/api/cli-analytics`.
 *
 * SAFETY CONTRACT:
 *   - No other module may POST analytics. If a second transmit path ever
 *     appears, the consent gate and the redaction boundary are defeated.
 *   - Telemetry must NEVER block or break an audit: every path is wrapped in
 *     try/catch, transmission is fire-and-forget with a short timeout, and a
 *     failure (offline, DNS, 500, no credentials) is a silent no-op.
 *   - USAGE tier only for now: the bus sink derives aggregate COUNTERS
 *     (tool names, counts, error categories, durations, cost) from the event
 *     bus. It never reads raw content — the bus only carries a bounded preview
 *     and this sink deliberately ignores it. Command / code / target / finding
 *     collectors are a separate, reviewed wave and are NOT wired here.
 */

import { homeStateDir, VERSION } from "@0sec/shared";
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
import { redactContent } from "./redaction.js";
import type {
  AnalyticsEnvelope,
  FiniteArch,
  FinitePlatform,
  FiniteRuntime,
  UsageRecord,
} from "./schema.js";

/** Wire schema version for the analytics payload. */
export const ANALYTICS_SCHEMA_VERSION = 1;

/** Endpoint (relative to the resolved cloud host) that receives batches. */
export const ANALYTICS_ENDPOINT = "/api/cli-analytics";

/** Transparency log filename under `~/.0sec`. */
export const ANALYTICS_SENT_LOG_FILENAME = "analytics-sent.log";

/** Short transmit timeout (ms) — telemetry never blocks an audit. */
const TRANSMIT_TIMEOUT_MS = 4000;

/** Debounce (ms) before a dirty usage accumulator is snapshotted + enqueued. */
const USAGE_FLUSH_DEBOUNCE_MS = 2000;

/** Debounce (ms) before a non-empty batch is POSTed. */
const TRANSMIT_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Finite host labels (mirror feedback.ts / schema.ts allowlists)
// ---------------------------------------------------------------------------
//
// core must not import @0sec/cli, so the finite value sets from the CLI's
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
// on @0sec/cli — keep in sync with feedback.ts.

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

/**
 * Recursively run {@link redactContent} over every string in a record —
 * VALUES and object KEYS alike (a counter label is a tool / category name and
 * could, in the MCP case, carry attacker-influenced text). Numbers and
 * booleans pass through untouched. Never throws: on any failure the field is
 * dropped rather than emitted raw.
 */
export function redactRecordStrings<T>(value: T): T {
  try {
    if (typeof value === "string") return redactContent(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => redactRecordStrings(v)) as unknown as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // Redact the key too; keep a stable fallback so a dropped key never
        // silently merges two distinct counters into "".
        const rk = redactContent(k) || "<redacted-key>";
        out[rk] = redactRecordStrings(v);
      }
      return out as unknown as T;
    }
    return value;
  } catch {
    return value;
  }
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
  private homeDir: string | undefined;
  private fetchImpl: FetchImpl | undefined;

  private installId: string | null = null;
  private readonly sessionId = newSessionId();

  private acc: UsageAccumulator = emptyAccumulator();
  private accDirty = false;

  private batch: Array<Record<string, unknown>> = [];

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

  /** Update the cached consent tier live (e.g. a /settings change). */
  setLevel(level: AnalyticsLevel): void {
    this.level = level;
    // Turning analytics on after startup must begin listening; the enqueue
    // gate keeps an "off" state cheap so we never need to tear the sink down.
    if (level !== "off") this.ensureSubscribed();
  }

  /** Current cached tier. */
  getLevel(): AnalyticsLevel {
    return this.level;
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

  // ── The choke point ───────────────────────────────────────────────────

  /**
   * The ONLY path toward transmission. Gate → redact → envelope → batch →
   * transmit. Never throws; a below-tier record is silently dropped.
   */
  private enqueue(record: Record<string, unknown>, requiredTier: AnalyticsLevel): void {
    try {
      // (1) Consent gate. Below the required tier, transmit nothing.
      if (!levelAtLeast(this.level, requiredTier)) return;

      // (2) Redact EVERY string field (values + keys).
      const redacted = redactRecordStrings(record);

      // (3) Attach the anonymous envelope.
      const envelope = this.buildEnvelope();
      const payload: Record<string, unknown> = { ...envelope, ...redacted };

      // (4) Batch + schedule transmit.
      this.batch.push(payload);
      this.scheduleTransmit();
    } catch {
      // Default-deny, fail-soft: never let telemetry break the caller.
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
      tier: this.level,
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

  /**
   * POST the pending batch. Fire-and-forget: resolves the credential set
   * (silent no-op when the cloud is offline / unconfigured), writes the
   * post-redaction payloads to the transparency log, then POSTs with a short
   * timeout. Any failure is swallowed.
   */
  private async transmit(): Promise<void> {
    const batch = this.batch.splice(0);
    if (batch.length === 0) return;

    let creds: { host: string; token: string };
    try {
      creds = loadCloudCredentials(this.homeDir ? { homeDir: this.homeDir } : {});
    } catch {
      // Cloud offline / no credentials — silent no-op. Nothing transmitted,
      // so nothing is written to the transparency log.
      return;
    }

    // Transparency: record every payload we are about to transmit.
    for (const p of batch) this.appendTransparencyLog(p);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      timer = setTimeout(() => controller.abort(), TRANSMIT_TIMEOUT_MS);
      timer.unref?.();
    } catch {
      /* no timer — the fetch may hang slightly longer, still non-blocking */
    }

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
        body: JSON.stringify({ records: batch }),
        signal: controller.signal,
      });
    } catch {
      // Network error, non-2xx, abort — telemetry never breaks an audit.
    } finally {
      if (timer) {
        try {
          clearTimeout(timer);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private appendTransparencyLog(payload: Record<string, unknown>): void {
    try {
      const dir = homeStateDir(this.homeDir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, ANALYTICS_SENT_LOG_FILENAME);
      appendFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
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
 * tier from the environment and, when it is not "off", cache it and subscribe
 * the usage sink to the event bus. When "off", do nothing (no subscription,
 * no transmission). Idempotent and env-gated; safe to call multiple times.
 */
export function maybeSubscribeAnalyticsPipeline(): void {
  const level = resolveAnalyticsLevel();
  analyticsPipeline.setLevel(level);
  if (level === "off") return;
  analyticsPipeline.ensureSubscribed();
}

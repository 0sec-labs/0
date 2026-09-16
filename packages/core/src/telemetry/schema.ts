/**
 * Analytics payload TYPES only — no logic, no I/O.
 *
 * SAFETY CONTRACT: the envelope is structurally incapable of carrying operator
 * identity or engagement data. It MUST NEVER gain a field for email, account,
 * username, hostname, IP, MAC, cwd, file path, target URL, or any auth token /
 * credential. Anything that could carry such data must first pass through
 * `redactContent` (./redaction.js) and land in one of the `*Redacted` string
 * fields below. Adding an identity field here defeats the entire consent gate.
 *
 * The finite `platform` / `arch` / `runtime` value sets mirror the CLI's
 * diagnostic allowlists (packages/cli/src/tui/feedback.ts): custom or unknown
 * values collapse to "unknown" upstream so no free-form host string is ever
 * transmitted.
 */

import type { AnalyticsLevel } from "./analytics-level.js";

/** Finite OS platform labels; anything else collapses to "unknown". */
export type FinitePlatform =
  | "darwin"
  | "linux"
  | "win32"
  | "aix"
  | "freebsd"
  | "openbsd"
  | "sunos"
  | "unknown";

/** Finite CPU arch labels; anything else collapses to "unknown". */
export type FiniteArch =
  | "x64"
  | "arm64"
  | "arm"
  | "ia32"
  | "s390"
  | "mips"
  | "ppc64"
  | "unknown";

/** Finite JS runtime labels; anything else collapses to "unknown". */
export type FiniteRuntime = "node" | "bun" | "deno" | "unknown";

/**
 * Common envelope wrapping every analytics record.
 *
 * DO NOT ADD identity or engagement fields (email, account, username,
 * hostname, ip, mac, cwd, path, targetUrl, token, credentials, …). See the
 * file-level safety contract.
 */
export interface AnalyticsEnvelope {
  /** Payload schema version. */
  schemaVersion: number;
  /** Random install id, not derived from identity; authenticated requests remain attributable. */
  installId: string;
  /** Random per-run session id. */
  sessionId: string;
  /** Consent tier under which this envelope was produced. */
  tier: AnalyticsLevel;
  /** Emission time (epoch ms). */
  ts: number;
  /** CLI release version (numeric identity only). */
  cliVersion: string;
  /** Finite OS platform label. */
  platform: FinitePlatform;
  /** Finite CPU arch label. */
  arch: FiniteArch;
  /** Finite runtime label. */
  runtime: FiniteRuntime;
}

/** "usage" tier: aggregate counters only, no free text. */
export interface UsageRecord {
  kind: "usage";
  /** Feature name → invocation count. */
  featureCounts: Record<string, number>;
  /** Finding category → count. */
  findingCounts: Record<string, number>;
  /** Finite error category → count. */
  errorCategories: Record<string, number>;
  /** Number of agent turns in the run. */
  turnCount: number;
  /** Total run duration (ms). */
  durationMs: number;
  /** Optional model spend for the run (USD). */
  costUsd?: number;
}

/** "commands" tier: one executed tool call, args/output already redacted. */
export interface CommandRecord {
  /** Tool / command name. */
  tool: string;
  /** Redacted argument preview (via redactContent). */
  argsRedacted: string;
  /** Redacted output preview (via redactContent). */
  outputRedacted: string;
  /** Finite completion status. */
  status: string;
  /** Command duration (ms). */
  durationMs: number;
  /** Turn index this command ran in. */
  turn: number;
}

/** "full" tier: a code snippet, source already redacted. */
export interface CodeRecord {
  /** Detected language. */
  lang: string;
  /** Redacted source snippet (via redactContent). */
  sourceRedacted: string;
  /** Where the snippet came from (finite origin label). */
  origin: string;
}

/** "full" tier: an engagement scope entry, target already redacted. */
export interface ScopeRecord {
  /** Redacted target identifier (via redactContent). */
  targetRedacted: string;
  /** Scope entry kind. */
  kind: string;
}

/** "full" tier: a finding, all free-text fields already redacted. */
export interface FindingRecord {
  /** Severity label. */
  severity: string;
  /** Finding category. */
  category: string;
  /** Redacted title (via redactContent). */
  titleRedacted: string;
  /** Redacted description (via redactContent). */
  descriptionRedacted: string;
  /** Redacted evidence (via redactContent). */
  evidenceRedacted: string;
  /** Confidence score. */
  confidence: number;
}

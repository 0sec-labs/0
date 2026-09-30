// Scan-config resolution extracted from agentic-scanner.ts (S3 god-module
// cleanup): the per-ScanConfig caches for scope policy, engagement posture,
// enforcement tracker and rate limiter, plus the resolvers and report-attachers
// built on them. Pure relocation — these were private to agentic-scanner.ts and
// are imported back there; behaviour is unchanged.
import type { ScanConfig, ScanReport } from "@0/shared";
import { loadScope, ScopePolicy } from "../scope/scope.js";
import { RateLimiter, parseRateLimitFlag } from "../scope/rate-limit.js";
import { EnforcementTracker, PathPolicy } from "../scope/enforcement.js";
import {
  resolveAttribution,
  extractAttributionFromScopeJson,
} from "../scope/attribution.js";
import type { AttributionConfig } from "../scope/attribution.js";
import {
  resolveEngagementProfile,
  extractEngagementFromScopeJson,
  describeEngagementPosture,
  effectiveFallbackRps,
} from "../scope/engagement-profile.js";
import type { EngagementPosture } from "../scope/engagement-profile.js";

// ─── relocated regions appended below ───

// ── scope policy cache + resolvers (was agentic-scanner.ts) ──
/**
 * Per-scan cache of parsed scope policies (0#218 review). The first
 * helper that needs a policy parses the JSON file once; every subsequent
 * helper for the same `ScanConfig` reuses the same `ScopePolicy`
 * instance.
 *
 * Why a WeakMap instead of a plain `Map` keyed by path: callers can
 * construct multiple `ScanConfig`s pointing at the same scope file, and
 * we want each top-level `agenticScan()` call to see a consistent
 * snapshot — but we also don't want to leak parsed policies for the
 * lifetime of the process. Tying lifetime to the `ScanConfig` object
 * itself fixes both.
 *
 * Why this matters: without it, every stage helper called
 * `loadScope(config.scopeFile)` again, which is a TOCTOU window. If the
 * file changed mid-scan, later tool calls would run under a different
 * policy than the one that admitted `--target` at scan start.
 */
const scopePolicyCache = new WeakMap<ScanConfig, ScopePolicy>();

export function resolveScopeForConfig(config: ScanConfig): ScopePolicy | undefined {
  const cached = scopePolicyCache.get(config);
  if (cached) return cached;
  // http_audit mode synthesises an in-memory host-allowlist ScopePolicy from
  // the env-bridge `httpAuditAllowedHosts` rather than reading a scope file.
  // This is the host half of the enforcement; the path half lives on the
  // EnforcementTracker's PathPolicy.
  if (config.mode === "http_audit") {
    const hosts = config.httpAuditAllowedHosts ?? [];
    const policy = ScopePolicy.fromJson({ in_scope: hosts });
    scopePolicyCache.set(config, policy);
    return policy;
  }
  if (!config.scopeFile) return undefined;
  const policy = loadScope(config.scopeFile);
  scopePolicyCache.set(config, policy);
  return policy;
}

/**
 * Resolve the attribution config (0#216) from a ScanConfig. Called
 * inline at every helper-function call site that constructs an
 * `AgentConfig`/`NativeAgentConfig`. Reuses the cached `ScopePolicy`
 * via `resolveScopeForConfig` so the scope file isn't reparsed.
 * Returns `undefined` when no source contributed anything.
 */
export function buildAttributionForConfig(config: ScanConfig): AttributionConfig | undefined {
  const scope = resolveScopeForConfig(config);
  return resolveAttribution({
    scopeFileBlock: scope ? extractAttributionFromScopeJson(scope.raw) : undefined,
    env: process.env,
    cliHeaders: config.attributionHeaders,
    cliUaToken: config.attributionUaToken,
  });
}

// ── rate-limiter / engagement / enforcement caches (was agentic-scanner.ts) ──
/**
 * Per-scan rate-limiter cache (#214). The limiter is stateful — buckets
 * track per-host token availability and 429 cool-offs across the entire
 * scan — so we build one instance keyed on the ScanConfig object and
 * thread it into every agent loop and every stage that fetches.
 *
 * Default 5 rps when the operator did not pass `--rate-limit`. The
 * issue body is explicit on this: the primitive should default
 * conservative even without an explicit operator flag, so an
 * unconfigured `0 scan` can't accidentally hammer a target.
 */
const RATE_LIMITER_CACHE = new WeakMap<ScanConfig, RateLimiter>();
export function getOrCreateRateLimiter(config: ScanConfig): RateLimiter {
  let rl = RATE_LIMITER_CACHE.get(config);
  if (!rl) {
    // In http_audit mode the per-host rps comes from the env-bridge
    // (ZERO_TARGET_RATE_LIMIT_RPS, default 5) rather than the --rate-limit
    // flag; the flag form isn't part of the worker contract. Otherwise we
    // honour the parsed --rate-limit spec with the usual 5 rps default.
    const modeFallbackRps = config.mode === "http_audit"
      ? (config.httpAuditRateLimitRps ?? 5)
      : 5;
    // Engagement hardening: an active profile lowers the default rps and adds
    // full jitter so the request train stops being periodic. It can only ever
    // make the scan QUIETER — we take the min, never the profile's number when
    // the operator already configured something slower. An explicit
    // `--rate-limit` default still wins (parseRateLimitFlag only consumes the
    // fallback when the spec carries no default).
    const posture = resolveEngagementForConfig(config);
    const cfg = parseRateLimitFlag(
      config.rateLimit ?? "",
      effectiveFallbackRps(posture, modeFallbackRps),
    );
    if (posture.jitter) cfg.jitter = { baseMs: posture.jitter.baseMs };
    // Wire the throttle observer into the http_audit enforcement tracker so
    // every blocked acquire / 429 park bumps `rate_limited_count`. No-op for
    // every other mode (tracker is undefined).
    const enforcement = resolveEnforcementForConfig(config);
    rl = new RateLimiter(cfg, {
      onThrottle: enforcement ? () => enforcement.noteRateLimited() : undefined,
    });
    RATE_LIMITER_CACHE.set(config, rl);
  }
  return rl;
}

/**
 * Per-scan engagement-posture cache. The posture is pure config (no I/O beyond
 * the already-cached scope file) but it is read at several call sites — the
 * rate limiter, the web-recon pre-pass, every agent config, and the report —
 * so resolve it once per ScanConfig and hand the same object around.
 *
 * Returns the `standard` posture (unchanged engine behaviour) when nothing is
 * configured, so this is safe to call unconditionally.
 */
const ENGAGEMENT_CACHE = new WeakMap<ScanConfig, EngagementPosture>();
export function resolveEngagementForConfig(config: ScanConfig): EngagementPosture {
  const cached = ENGAGEMENT_CACHE.get(config);
  if (cached) return cached;
  const scope = resolveScopeForConfig(config);
  const posture = resolveEngagementProfile({
    scopeFileBlock: scope ? extractEngagementFromScopeJson(scope.raw) : undefined,
    env: process.env,
    cliProfile: config.engagementProfile,
    cliWafEvasion: config.wafEvasion,
  });
  ENGAGEMENT_CACHE.set(config, posture);
  return posture;
}

/**
 * Attach the engagement-posture audit record to a report. Only present when a
 * hardening profile was actually applied, so default scans emit byte-for-byte
 * identical reports. Mutates `report` in place; called on every report return
 * path so the evidence is always there when it applies.
 */
export function attachEngagementPosture(report: ScanReport, config: ScanConfig): void {
  const posture = resolveEngagementForConfig(config);
  if (!posture.active) return;
  report.engagementPosture = describeEngagementPosture(posture);
}

/**
 * Per-scan enforcement-tracker cache (http_audit only). Created lazily the
 * first time any helper needs it and reused for the whole scan so the
 * scope/rate counters and the kill-switch clock aggregate across discovery +
 * attack + verify stages. Returns undefined for every non-http_audit scan,
 * leaving the legacy behaviour untouched.
 *
 * The tracker owns the path-prefix allowlist (PathPolicy) and the auth mode;
 * the host allowlist is enforced separately via the ScopePolicy built in
 * `resolveScopeForConfig`.
 */
const ENFORCEMENT_CACHE = new WeakMap<ScanConfig, EnforcementTracker>();
export function resolveEnforcementForConfig(config: ScanConfig): EnforcementTracker | undefined {
  if (config.mode !== "http_audit") return undefined;
  const cached = ENFORCEMENT_CACHE.get(config);
  if (cached) return cached;
  const tracker = new EnforcementTracker({
    pathPolicy: new PathPolicy(config.httpAuditAllowedPaths ?? []),
    auth: config.auth,
    killAfterSec: config.httpAuditKillAfterSec ?? 1800,
  });
  ENFORCEMENT_CACHE.set(config, tracker);
  return tracker;
}

/**
 * Attach the frozen `enforcement_summary` block to a report when the scan ran
 * in http_audit mode. No-op for every other mode (tracker is undefined), so
 * non-http_audit reports are byte-for-byte unchanged. Mutates `report` in
 * place; called on every http_audit report return path (happy, kill-switch,
 * cost-ceiling) so the block is always present.
 */
export function attachEnforcementSummary(report: ScanReport, config: ScanConfig): void {
  const enforcement = resolveEnforcementForConfig(config);
  if (!enforcement) return;
  report.enforcementSummary = enforcement.summarize();
}

/** Store a resolved ScopePolicy for a config, for pre-scan helpers that parse
 *  scope before the first resolver call (keeps scopePolicyCache encapsulated). */
export function cacheScopePolicy(config: ScanConfig, policy: ScopePolicy): void {
  scopePolicyCache.set(config, policy);
}

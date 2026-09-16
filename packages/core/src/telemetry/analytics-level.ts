/**
 * Analytics consent tier resolution.
 *
 * The tier is read from `0SEC_ANALYTICS_LEVEL`, but any opt-out signal wins
 * unconditionally and forces "off". The opt-out env names mirror the CLI's
 * `FEEDBACK_OPT_OUT_ENV` (packages/cli/src/tui/feedback.ts): `0SEC_OFFLINE`
 * (the repo's pre-existing offline convention), `0SEC_NO_TELEMETRY` (the name
 * people reach for), and `DO_NOT_TRACK` (the cross-tool standard). That module
 * lives in `@0sec/cli`, which core must not depend on, so the names and the
 * "set and not explicitly falsy" semantics are re-declared here — keep them in
 * sync.
 */

/** Consent tiers, in increasing order of what may be transmitted. */
export type AnalyticsLevel = "off" | "usage" | "commands" | "full";

const LEVEL_ORDER: Record<AnalyticsLevel, number> = {
  off: 0,
  usage: 1,
  commands: 2,
  full: 3,
};

/** Env vars that hard-disable analytics regardless of `0SEC_ANALYTICS_LEVEL`. */
export const ANALYTICS_OPT_OUT_ENV = ["0SEC_OFFLINE", "0SEC_NO_TELEMETRY", "DO_NOT_TRACK"] as const;

/** The env var that selects the tier when nothing opts out. */
export const ANALYTICS_LEVEL_ENV = "0SEC_ANALYTICS_LEVEL";

/** True when `current` is at least `required` (off < usage < commands < full). */
export function levelAtLeast(current: AnalyticsLevel, required: AnalyticsLevel): boolean {
  return LEVEL_ORDER[current] >= LEVEL_ORDER[required];
}

/**
 * True when `value` reads as "on". Mirrors the CLI's opt-out semantics:
 * anything set and not explicitly falsy ("", "0", "false", "no") counts as an
 * opt-out. Failure directions are asymmetric here — a missed opt-out would let
 * client data cross a boundary someone explicitly tried to close — so this is
 * deliberately permissive.
 */
function isOptOutSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return false;
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
}

function isAnalyticsLevel(value: string): value is AnalyticsLevel {
  return value === "off" || value === "usage" || value === "commands" || value === "full";
}

/**
 * Resolve the effective analytics tier. Any opt-out env forces "off"; when
 * `0SEC_ANALYTICS_LEVEL` is unset the default is "full". An unknown/invalid
 * value still fails closed to "off".
 */
export function resolveAnalyticsLevel(env: NodeJS.ProcessEnv = process.env): AnalyticsLevel {
  for (const name of ANALYTICS_OPT_OUT_ENV) {
    if (isOptOutSet(env[name])) return "off";
  }
  const raw = env[ANALYTICS_LEVEL_ENV];
  if (typeof raw !== "string") return "full";
  const normalized = raw.trim().toLowerCase();
  return isAnalyticsLevel(normalized) ? normalized : "off";
}

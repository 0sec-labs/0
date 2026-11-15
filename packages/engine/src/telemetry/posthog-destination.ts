/**
 * Where (and whether) anonymous usage analytics may be sent directly to PostHog.
 *
 * Resolution, first match wins:
 *   1. Operator override `ZERO_ANALYTICS_POSTHOG_KEY` (+ optional
 *      `ZERO_ANALYTICS_POSTHOG_HOST`). An EMPTY key override disables the
 *      direct path outright, even in a release build.
 *   2. The release-embedded project key (`__ZERO_BUILT_IN_POSTHOG_KEY__`, set by
 *      scripts/bundle-cli.mjs / scripts/bun-compile.sh from the
 *      ZERO_RELEASE_POSTHOG_KEY secret) with the EU host.
 *   3. Nothing. Source builds and PR builds embed no key and send nothing.
 *
 * The host must be https, or http on a loopback address (local test servers).
 * Anything else resolves to "no destination": the direct path fails closed.
 *
 * This module only RESOLVES a destination. It grants no consent: the single
 * analytics choke point (analytics-pipeline.ts) still gates on the consent
 * tier and opt-outs before anything is queued, and is the only transmitter.
 */

declare const __ZERO_BUILT_IN_POSTHOG_KEY__: string | undefined;

export const POSTHOG_KEY_ENV = "ZERO_ANALYTICS_POSTHOG_KEY";
export const POSTHOG_HOST_ENV = "ZERO_ANALYTICS_POSTHOG_HOST";
/** PostHog EU ingestion host (project region: EU). */
export const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

const POSTHOG_KEY_PATTERN = /^phc_[A-Za-z0-9]{20,}$/;

export interface PostHogDestination {
  key: string;
  /** Origin only, no trailing slash. */
  host: string;
}

/** The embedded key, or undefined when this build was not provisioned. Never log it. */
export function getBuiltInPostHogKey(): string | undefined {
  if (typeof __ZERO_BUILT_IN_POSTHOG_KEY__ === "undefined") return undefined;
  const key = __ZERO_BUILT_IN_POSTHOG_KEY__?.trim();
  return key ? key : undefined;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** Normalize a host override to a bare origin, or null if it is not acceptable. */
export function normalizePostHogHost(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname))) return url.origin;
    return null;
  } catch {
    return null;
  }
}

export function resolvePostHogDestination(
  env: NodeJS.ProcessEnv = process.env,
  builtInKey: string | undefined = getBuiltInPostHogKey(),
): PostHogDestination | null {
  const keyOverride = env[POSTHOG_KEY_ENV];
  let key: string | undefined;
  if (keyOverride !== undefined) {
    key = keyOverride.trim();
    if (!key) return null;
  } else {
    key = builtInKey;
  }
  if (!key || !POSTHOG_KEY_PATTERN.test(key)) return null;
  const hostOverride = env[POSTHOG_HOST_ENV]?.trim();
  const host = hostOverride ? normalizePostHogHost(hostOverride) : DEFAULT_POSTHOG_HOST;
  return host ? { key, host } : null;
}

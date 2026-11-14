import { appendFileSync } from "node:fs";
import { diag } from "../../diagnostics/channel.js";
import { probeAzureRegion } from "./azure-region.js";
import { type ApiProvider, type WireApi } from "./provider-config.js";

/**
 * Tracks which endpoints we've already printed a startup banner for.
 *
 * Stashed on `globalThis` under a `Symbol.for` key so the guard survives
 * module re-evaluation. pnpm monorepos can occasionally resolve this
 * module from more than one path (source vs compiled, different dep
 * hoisting), which hands each importer its own module-local `Set` —
 * the banner then fires once per importer instead of once per process.
 * Keying on a shared global process-wide Set closes that hole.
 */
export const PROVIDER_BANNER_KEY = Symbol.for("0.core.loggedProviderStartup");
export type GlobalWithBannerGuard = typeof globalThis & { [PROVIDER_BANNER_KEY]?: Set<string> };
export const loggedProviderStartup: Set<string> = ((): Set<string> => {
  const g = globalThis as GlobalWithBannerGuard;
  if (!g[PROVIDER_BANNER_KEY]) g[PROVIDER_BANNER_KEY] = new Set<string>();
  return g[PROVIDER_BANNER_KEY];
})();

export function appendNativeTrace(record: Record<string, unknown>): void {
  const file = process.env["ZERO_TRACE_NATIVE_RESPONSES"];
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch {
    // best-effort only
  }
}

export function shouldLogProviderStartup(): boolean {
  return process.env["ZERO_SUPPRESS_PROVIDER_STARTUP_LOG"] !== "1";
}

// ── Transient-failure retry (429 rate-limit + transient 5xx) ────────────
//
// Burst dispatch (the nightly sweep fires hundreds of scans at once) makes
// the shared ChatGPT/Codex subscription return HTTP 429. Before this, the
// engine's FIRST LLM call bailed with `stopReason:"error"`, the agent loop
// produced zero tool calls + zero cost, and the scan was misfiled as
// "no work — sandbox terminated". We now back off and retry retryable HTTP
// statuses at the wire layer — the only place the `Retry-After` header is
// actually visible — so a rate-limited call WAITS and RETRIES instead of
// failing the whole scan. Caps are env-tunable so a burst can be widened
// without a redeploy.

/**
 * Emit a single-line startup banner summarising the resolved provider
 * config. For Azure, also probes and logs the physical region. Runs at
 * most once per (provider, baseUrl) tuple per process.
 *
 * Non-Azure providers are a no-op beyond the provider label — the region
 * only matters when the endpoint sits behind Azure's front door. This is
 * called lazily from the first request on an `LlmApiRuntime` instance to
 * avoid forcing a network probe at module import time.
 */
export async function logProviderStartup(
  provider: ApiProvider,
  providerLabel: string,
  baseUrl: string,
  model: string,
  wireApi: WireApi,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const key = `${provider}:${baseUrl}`;
  if (loggedProviderStartup.has(key)) return;
  loggedProviderStartup.add(key);
  if (!shouldLogProviderStartup()) return;

  if (provider !== "azure") {
    // Non-Azure: brief banner, no region probe.
    diag.info("provider_initialized", `${providerLabel} provider initialized`, {
      provider,
      endpoint: baseUrl,
      model,
    });
    return;
  }

  const region = await probeAzureRegion(baseUrl, apiKey, fetchImpl);

  diag.info("provider_initialized", "Azure OpenAI provider initialized", {
    provider,
    endpoint: baseUrl,
    model,
    region,
    // Distinguishes "the header said westeurope" from "the probe could not
    // tell us", which matters when someone is debugging a data-residency
    // requirement and `region=unknown` is not the same as `region` missing.
    region_source: region === "unknown" ? "probe-failed" : "x-ms-region",
    wire_api: wireApi,
  });
}

/** Reset the startup-banner guard. Test-only. */
export function __resetProviderStartupLogForTests(): void {
  loggedProviderStartup.clear();
}

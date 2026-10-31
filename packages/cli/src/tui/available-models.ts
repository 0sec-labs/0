import { getSiwcConnection } from "./chatgpt-plan-store.js";
import { LlmApiRuntime, type RuntimeConfig } from "@0/core";

export interface AvailableModel { id: string; provider: string; contextTokens?: number; source?: "catalog" }
export interface ModelDiscoveryResult { models: AvailableModel[]; diagnostics: Array<{ providerId: string; message: string }> }

const DISCOVERY_TIMEOUT_MS = 10_000;

/** Bound the waiter even when an auth refresh or transport ignores cancellation. */
async function boundedCatalog<T>(operation: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
  const deadline = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), DISCOVERY_TIMEOUT_MS);
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(new Error(deadline.signal.aborted ? "Model discovery timed out. Retry this connection." : "Model discovery cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      // A shared OAuth refresh may continue for another inference consumer;
      // its late result cannot extend this picker's deadline or add rows.
      Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Resolve each connection independently; preserve public Cline catalog provenance. */
export async function discoverConnectionModels(
  env: Readonly<Record<string, string | undefined>>,
  providerIds: readonly string[],
  signal?: AbortSignal,
): Promise<ModelDiscoveryResult> {
  const results = await Promise.all(providerIds.map(async providerId => {
    try {
      const models = await boundedCatalog(async discoverySignal => {
        const runtime = new LlmApiRuntime({ type: "api", timeout: DISCOVERY_TIMEOUT_MS,
          provider: providerId as RuntimeConfig["provider"], model: "probe",
          ...(providerId === "chatgpt-plan" ? { siwcConnection: getSiwcConnection(env.HOME) } : {}),
          env: { ...env, ZERO_SKIP_PROVIDER_BANNER: "1" } });
        return runtime.availableModelCatalog(discoverySignal);
      }, signal);
      return { models: models.map(model => ({ ...model, provider: providerId })), diagnostics: [] };
    } catch (error) {
      // Discovery implementations use fixed messages, but redact captured credentials defensively.
      let message = error instanceof Error ? error.message : "Model discovery failed.";
      for (const [name, value] of Object.entries(env)) {
        if (value && /KEY|TOKEN|SECRET|PASSWORD/i.test(name)) message = message.split(value).join("[redacted]");
      }
      return { models: [], diagnostics: [{ providerId, message: message.slice(0, 1_000) }] };
    }
  }));
  return { models: results.flatMap(result => result.models), diagnostics: results.flatMap(result => result.diagnostics) };
}

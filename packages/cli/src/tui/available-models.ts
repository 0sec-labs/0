import { LlmApiRuntime, type RuntimeConfig } from "@0/core";

export interface AvailableModel { id: string; provider: string; contextTokens?: number; source?: "catalog" }
export interface ModelDiscoveryResult { models: AvailableModel[]; diagnostics: Array<{ providerId: string; message: string }> }

/** Resolve each connection independently; preserve public Cline catalog provenance. */
export async function discoverConnectionModels(
  env: Readonly<Record<string, string | undefined>>,
  providerIds: readonly string[],
  signal?: AbortSignal,
): Promise<ModelDiscoveryResult> {
  const results = await Promise.all(providerIds.map(async providerId => {
    try {
      const runtime = new LlmApiRuntime({ type: "api", timeout: 10_000,
        provider: providerId as RuntimeConfig["provider"], model: "probe",
        env: { ...env, ZERO_SKIP_PROVIDER_BANNER: "1" } });
      const models = await runtime.availableModelCatalog(signal ?? AbortSignal.timeout(10_000));
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

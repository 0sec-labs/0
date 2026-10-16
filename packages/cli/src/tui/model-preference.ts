import { CodexCatalogRefreshError, createConsoleRuntime, type CodexCatalogModel, type LlmApiRuntime, type RuntimeConfig } from "@0/core";
import { getSettings, updateSetting } from "./settings-store.js";
import type { ModelPreference } from "./settings.js";

/** Restore only a choice applied to this exact connection; never infer model access from its name. */
export async function createPreferredConsoleRuntime(
  config: Partial<RuntimeConfig>,
  options: { inheritedConnectionIdentity?: string; onDiscoveryError?: (error: unknown) => void } = {},
): Promise<{ runtime: LlmApiRuntime; explicitChoice: boolean }> {
  const env = config.env ?? process.env;
  const envModel = env["ZERO_MODEL"]?.trim();
  const envProvider = env["ZERO_SELECTED_PROVIDER"]?.trim() || env["ZERO_PROVIDER"]?.trim() || env["ZERO_FORCE_PROVIDER"]?.trim();
  const inherited = options.inheritedConnectionIdentity !== undefined;
  // A provider pin chooses a connection; only an explicit model pins its selection.
  const explicitChoice = (!inherited && config.model !== undefined) || Boolean(envModel);
  if (inherited && (envModel || envProvider)) config = { ...config, model: undefined, provider: undefined };
  if (config.provider === undefined && envProvider) config = { ...config, provider: envProvider as RuntimeConfig["provider"] };
  let runtime: LlmApiRuntime | undefined;
  let retainedModel = false;

  if (inherited && !envModel && !envProvider) {
    runtime = createConsoleRuntime({ ...config, model: undefined });
    if (runtime.connectionIdentity() === options.inheritedConnectionIdentity) {
      runtime.reconfigure({ model: config.model });
      retainedModel = config.model !== undefined;
    }
  }
  if (!explicitChoice && !retainedModel) {
    const saved = getSettings().modelPreference;
    if (saved && (config.provider === undefined || config.provider === saved.providerId)) {
      try {
        const candidate = createConsoleRuntime({ ...config, model: saved.model, provider: saved.providerId as RuntimeConfig["provider"] });
        if (candidate.connectionIdentity() === saved.connectionIdentity) {
          runtime = candidate;
          retainedModel = true;
        }
      } catch {
        // A disconnected saved provider cannot redirect another account's runtime.
      }
    }
  }
  runtime ??= createConsoleRuntime(config);
  if (!explicitChoice && runtime.getConfigurationDiagnostics().provider === "chatgpt-codex") {
    let catalog: readonly CodexCatalogModel[] | undefined;
    try {
      catalog = await runtime.codexModelCatalog(AbortSignal.timeout(10_000));
    } catch (error) {
      options.onDiscoveryError?.(error);
      if (error instanceof CodexCatalogRefreshError) catalog = error.cachedModels;
      // With no applied choice or account catalog, the runtime's historical
      // hardcoded model is not evidence that this account can use it.
      else if (!retainedModel) throw error;
    }
    if (catalog) {
      if (!catalog.length) throw new Error("This ChatGPT subscription returned no available models.");
      const currentModel = runtime.resolvedModel();
      // The loader orders account rows by backend recommendation, not model-name guesses.
      if (!retainedModel || !catalog.some((model) => model.id === currentModel)) {
        runtime.reconfigure({ model: catalog[0]!.id });
      }
    }
  }
  return { runtime, explicitChoice };
}

/** Call only after an explicit choice was successfully applied, never while staging it. */
export function saveAppliedModelPreference(runtime: LlmApiRuntime): boolean {
  const connectionIdentity = runtime.connectionIdentity();
  if (!connectionIdentity) return false;
  const preference: ModelPreference = {
    providerId: runtime.getConfigurationDiagnostics().provider,
    model: runtime.resolvedModel(),
    connectionIdentity,
  };
  return updateSetting("modelPreference", preference, { scope: "global" });
}

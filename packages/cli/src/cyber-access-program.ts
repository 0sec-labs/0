import { LlmApiRuntime, validateCyberAccessProgram, type RuntimeConfig } from "@0/core";

/** Explicit provider/program intent must be validated before target preparation. */
export function assertAssessmentAccessProgram(value: unknown, runtime: unknown, provider?: unknown, selection: Pick<RuntimeConfig, "apiKey" | "model"> = {}): void {
  if (provider !== undefined && !["openai", "chatgpt-codex"].includes(String(provider))) throw new Error("Explicit provider must be openai or chatgpt-codex; no provider or account was switched.");
  if (provider !== undefined && runtime !== "api") throw new Error("Explicit --provider requires --runtime api.");
  if (provider === "chatgpt-codex" && selection.apiKey !== undefined) throw new Error("--provider chatgpt-codex uses the existing ChatGPT OAuth account, not --api-key. No authentication method was switched.");
  if (value === undefined) return;
  const cyberAccessProgram = validateCyberAccessProgram(value);
  if (runtime !== "api" || !["openai", "chatgpt-codex"].includes(String(provider))) throw new Error("--cyber-access-program requires explicit --runtime api --provider openai or --provider chatgpt-codex; no provider or account was switched.");
  // Constructor validation checks the resolved public OpenAI Responses route.
  // It neither calls a model nor tests entitlement; provider errors remain authoritative.
  const probe = new LlmApiRuntime({ ...selection, type: "api", provider: provider as "openai" | "chatgpt-codex", cyberAccessProgram, timeout: 30_000 });
  const diagnostics = probe.getConfigurationDiagnostics();
  if (!diagnostics.valid) throw new Error(diagnostics.fatalError ?? "A configured credential for the explicitly selected provider is required for access programs.");
}

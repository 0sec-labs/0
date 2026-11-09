import { LlmApiRuntime, validateCyberAccessProgram, type RuntimeConfig } from "@0/core";

/** Explicit provider/program intent must be validated before target preparation. */
export function assertAssessmentAccessProgram(value: unknown, runtime: unknown, provider?: unknown, selection: Pick<RuntimeConfig, "apiKey" | "model"> = {}): void {
  if (provider !== undefined && provider !== "openai") throw new Error("Only --provider openai is supported for explicit API selection; no other provider or ChatGPT account was selected.");
  if (provider !== undefined && runtime !== "api") throw new Error("--provider openai requires explicit --runtime api.");
  if (value === undefined) return;
  const cyberAccessProgram = validateCyberAccessProgram(value);
  if (runtime !== "api" || provider !== "openai") throw new Error("--cyber-access-program requires explicit --runtime api --provider openai. Direct ChatGPT subscription and managed Codex CLI selection are unsupported; no provider or account was switched.");
  // Constructor validation checks the resolved public OpenAI Responses route.
  // It neither calls a model nor tests entitlement; provider errors remain authoritative.
  const probe = new LlmApiRuntime({ ...selection, type: "api", provider: "openai", cyberAccessProgram, timeout: 30_000 });
  const diagnostics = probe.getConfigurationDiagnostics();
  if (!diagnostics.valid) throw new Error(diagnostics.fatalError ?? "An approved OpenAI API project key is required for explicit access programs.");
}

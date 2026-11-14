import type { RuntimeMode } from "../shared/index.js";
import type { RuntimeType } from "../runtime/types.js";
import { LlmApiRuntime } from "../runtime/llm-api.js";
import type { ApiRuntimeDiagnostics } from "../runtime/llm-api.js";

/**
 * `--runtime codex` is a special case: it can resolve through either the
 * local `codex` CLI binary (subscription path, source-analysis only) OR
 * through the direct ChatGPT Codex provider when one of
 * `ZERO_CHATGPT_ACCESS_TOKEN` / `ZERO_CHATGPT_OAUTH_REFRESH_TOKEN` is
 * set. In the latter mode `LlmApiRuntime` reports `provider:
 * "chatgpt-codex"`, and the pipeline must route the codex request through
 * the API runtime instead of bailing with "Requested runtime 'codex' is
 * not available." This mirrors the routing already in `agentic-scanner.ts`
 * (the web/url scan path); without it, kernel reviews + npm/pypi/cargo
 * audits with `--runtime codex` were skipped on machines where the
 * operator had configured subscription auth but not installed the codex
 * CLI binary. See #402.
 */
export function hasDirectChatGptCodexProvider(
  diagnostics: ApiRuntimeDiagnostics,
): boolean {
  return diagnostics.valid && diagnostics.provider === "chatgpt-codex";
}

export function selectVerificationRuntime(
  preferredRuntime: RuntimeMode | undefined,
  hasApiKey: boolean,
  availableRuntimes: Set<RuntimeType>,
  apiDiagnostics: ApiRuntimeDiagnostics,
): RuntimeMode | null {
  if (preferredRuntime === "api") {
    return hasApiKey ? "api" : null;
  }

  if (preferredRuntime && preferredRuntime !== "auto") {
    if (availableRuntimes.has(preferredRuntime)) return preferredRuntime;
    // Explicit `--runtime codex` with the direct ChatGPT Codex provider
    // configured (ZERO_CHATGPT_*_TOKEN env). Route verification through
    // the API runtime — agent-runner.ts will pick up the same env vars
    // and run the native tool_use loop against chatgpt.com.
    if (preferredRuntime === "codex" && hasDirectChatGptCodexProvider(apiDiagnostics)) {
      return "codex";
    }
    return null;
  }

  if (hasApiKey) {
    return "api";
  }

  if (availableRuntimes.size > 0) {
    return "auto";
  }

  return null;
}

export function hasRequestedAnalysisRuntime(
  preferredRuntime: RuntimeMode | undefined,
  hasApiKey: boolean,
  availableRuntimes: Set<RuntimeType>,
  apiDiagnostics: ApiRuntimeDiagnostics,
): boolean {
  if (preferredRuntime === "api") {
    return hasApiKey;
  }

  if (preferredRuntime && preferredRuntime !== "auto") {
    if (availableRuntimes.has(preferredRuntime)) return true;
    // Direct ChatGPT Codex provider unlocks `--runtime codex` even when
    // the codex CLI binary is absent. See `hasDirectChatGptCodexProvider`.
    if (preferredRuntime === "codex" && hasDirectChatGptCodexProvider(apiDiagnostics)) {
      return true;
    }
    return false;
  }

  return hasApiKey || availableRuntimes.size > 0;
}

export function assertApiRuntimeSelection(
  preferredRuntime: RuntimeMode | undefined,
  diagnostics: ApiRuntimeDiagnostics,
): void {
  if (preferredRuntime === "api" && diagnostics.reason === "invalid_config") {
    throw new Error(diagnostics.fatalError ?? `${diagnostics.providerLabel} runtime is not available.`);
  }

  if ((preferredRuntime === "auto" || preferredRuntime === undefined) && diagnostics.reason === "invalid_config") {
    throw new Error(diagnostics.fatalError ?? `${diagnostics.providerLabel} runtime is misconfigured.`);
  }
}

export type {
  Runtime,
  RuntimeConfig,
  CyberAccessProgram,
  AccessProgramMetadata,
  RuntimeContext,
  RuntimeResult,
  RuntimeType,
  NativeRuntime,
  NativeMessage,
  NativeContentBlock,
  NativeToolDef,
  NativeRuntimeResult,
  NativeOutputCapCheckpoint,
} from "./types.js";
export { LlmApiRuntime, QuotaExhaustedError, OperatorAbortError, parseUsageLimitReached } from "./llm-api.js";
export type { UsageLimitDetails } from "./llm-api.js";
export { ProcessRuntime } from "./process.js";
export { CliNativeRuntime } from "./cli-native.js";
export { PiAiRuntime, isPiRuntimeSelected } from "./pi/index.js";
export { createNativeApiRuntime, runtimeFromPrivateWorkerBinding, ApiRuntime, isApiRuntime, runtimeMode, selectRuntimeKind } from "./native-api.js";
export { LegacyRuntimeAdapter } from "./api-runtime.js";
export type { RuntimeKind, RuntimeMode, ConsoleRuntime } from "./native-api.js";
export { OllamaRuntime } from "./ollama.js";
export type { OllamaRuntimeOptions } from "./ollama.js";
export {
  RUNTIME_REGISTRY,
  pickRuntimeForStage,
  detectAvailableRuntimes,
  getRuntimeInfo,
} from "./registry.js";

import type { RuntimeConfig, Runtime } from "./types.js";
import { ProcessRuntime } from "./process.js";
import { OllamaRuntime } from "./ollama.js";
import { createNativeApiRuntime } from "./native-api.js";

export function createRuntime(config: RuntimeConfig): Runtime {
  switch (config.type) {
    case "api":
      // The factory picks pi-ai or the legacy adapter; both implement Runtime and NativeRuntime.
      return createNativeApiRuntime(config);
    case "claude":
    case "codex":
    case "gemini":
      return new ProcessRuntime(config);
    case "ollama":
      // Local Gemma-4-style model via Ollama's /api/chat. Model is required
      // here and defaults — if absent — to the env var or a documented value
      // so a bare `--runtime ollama` still gives a usable error.
      return new OllamaRuntime({
        model: config.model ?? process.env["ZERO_OLLAMA_MODEL"] ?? "gemma4:27b",
        timeout: config.timeout,
        host: process.env.OLLAMA_HOST,
      });
  }
}

export { captureSiwcConnection, listSiwcModels } from "./siwc-connection.js";
export type { SiwcConnection, SiwcModel } from "./siwc-connection.js";

export { validateCyberAccessProgram } from "./cyber-access-program.js";

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
export {
  RUNTIME_REGISTRY,
  pickRuntimeForStage,
  detectAvailableRuntimes,
  getRuntimeInfo,
} from "./registry.js";

import type { RuntimeConfig, Runtime } from "./types.js";
import { removedRuntimeMessage } from "../shared/removed-runtimes.js";
import { ProcessRuntime } from "./process.js";
import { createNativeApiRuntime } from "./native-api.js";

export function createRuntime(config: RuntimeConfig): Runtime {
  switch (config.type) {
    case "api":
      // The factory picks pi-ai or the legacy adapter; both implement Runtime and NativeRuntime.
      return createNativeApiRuntime(config);
    case "claude":
    case "codex":
      return new ProcessRuntime(config);
    default:
      // `RuntimeType` no longer names these, but a raw `--runtime` string or a stored config can.
      throw new Error(removedRuntimeMessage(String(config.type)));
  }
}

export { captureSiwcConnection, listSiwcModels } from "./siwc-connection.js";
export type { SiwcConnection, SiwcModel } from "./siwc-connection.js";

export { validateCyberAccessProgram } from "./cyber-access-program.js";

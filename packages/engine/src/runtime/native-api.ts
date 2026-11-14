import type { RuntimeConfig } from "./types.js";
import { ApiRuntime, isApiRuntime, runtimeMode, selectRuntimeKind } from "./api-runtime.js";
import type { PrivateWorkerRuntimeBinding } from "./llm-api/runtime.js";

export { ApiRuntime, isApiRuntime, runtimeMode, selectRuntimeKind };
export type { RuntimeKind, RuntimeMode, ConsoleRuntime } from "./api-runtime.js";

/**
 * THE entry point for every API-key/OAuth runtime in the product. The factory
 * (not the call site) decides the implementation:
 *
 *   ZERO_RUNTIME unset / `auto`  pi-ai where it serves the route, else the legacy adapter
 *   ZERO_RUNTIME=legacy          always the legacy adapter (escape hatch)
 *   ZERO_RUNTIME=pi-ai           pi-ai wherever it can serve (legacy-only routes still go legacy)
 *
 * `config.env.ZERO_RUNTIME` overrides the process env. Constructing
 * `LlmApiRuntime` / `PiAiRuntime` anywhere else is blocked by
 * `scripts/check-architecture.mjs`.
 */
export function createNativeApiRuntime(config: RuntimeConfig): ApiRuntime {
  return new ApiRuntime(config);
}

/** Rehydrate a worker-side runtime from a trusted private-pipe binding (kind recorded in the binding). */
export function runtimeFromPrivateWorkerBinding(binding: PrivateWorkerRuntimeBinding): ApiRuntime {
  return ApiRuntime.fromPrivateWorkerBinding(binding);
}

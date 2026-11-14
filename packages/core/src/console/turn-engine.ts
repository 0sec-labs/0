/**
 * Unified interactive chat console — engine-side turn driver.
 *
 * This is the conversational front-end for the 0 engine described in the
 * 0 "operator cockpit" direction: one surface where an operator talks to the
 * engine and it can invoke every tool in the registry (recon, web pentest,
 * source-scan, variant-hunt, verify, patch-gen) in one place.
 *
 * It deliberately REUSES the engine's real components rather than re-building
 * them:
 *   - the real tool registry + dispatcher (`getToolsForRole` + `ToolExecutor`
 *     from `agent/tools.ts`),
 *   - the real LLM runtime (`LlmApiRuntime.executeNative` from
 *     `runtime/llm-api.ts`, the same native tool_use client the autonomous
 *     `runNativeAgentLoop` drives).
 *
 * What it adds is the thin turn-orchestration glue that `runNativeAgentLoop`
 * intentionally does NOT expose: a chat turn that runs the model + its tool
 * calls to a natural stop and then HANDS CONTROL BACK to the operator, keeping
 * the conversation history across operator turns. `runNativeAgentLoop` is a
 * one-shot autonomous scan (it terminates the whole run when the model calls
 * `done`), so its terminal semantics don't fit a "respond, then wait for me"
 * console. The inner turn cycle here mirrors that loop's cycle (executeNative →
 * dispatch tool_use via ToolExecutor → append tool_result → repeat) so the two
 * stay behaviourally aligned. See `console/repl.ts` for the CLI consumer.
 *
 * The session now supports in-memory, operator-approved scope expansion and
 * per-tool approval for the interactive surface. It never writes a scope file;
 * normal autonomous scan enforcement remains outside this console-specific
 * layer.
 */

/**
 * Emitted once each time the console loop compacts its conversation history at a
 * turn boundary (context-window management, mirroring the autonomous scan loop's
 * `context_compacted` event). Stream B renders this and back-fills `tokensAfter`
 * from the next planner usage sample. This EXACT shape is a contract with the
 * renderer — do not reshape it.
 */

export type { ConsoleCompactionEvent, ConsoleRenderCallbacks, ConsoleUsageReport, ConsoleAutonomyMode, ConsoleScopeRequest, ConsoleScopeResolution, ConsoleLocalScopeRequest, ConsoleLocalScopeResolution, ConsoleStopReason, ConsoleTurnBudget, ConsoleTurnOutcome, ConsoleSendOptions, ConsoleSessionConfig, ConsoleEngagementSelection, ConsoleSourceLesson, ConsoleSourceContext, ConsoleSession } from "./turn-engine/types.js";
export { DEFAULT_MAX_TOOL_ITERATIONS, buildConsoleSystemPrompt, createConsoleRuntime, describeCaughtError } from "./turn-engine/prompt-and-runtime.js";
export { getWorkflowLifecycleTools } from "./turn-engine/console-tools.js";
export type { ConsoleConversationHistory } from "./turn-engine/console-tools.js";
export { isDangerousLocalRoot } from "./turn-engine/tool-targets.js";
export { createConsoleSession } from "./turn-engine/session.js";

/**
 * Manual smoke for the opt-in pi-ai runtime. Needs a real API key; makes two
 * tiny requests (text, then a forced tool call) and one pre-aborted call.
 *
 *   ANTHROPIC_API_KEY=... pnpm --filter @0/engine exec tsx scripts/smoke-pi-ai.ts
 *   OPENAI_API_KEY=... ZERO_MODEL=gpt-5-mini pnpm --filter @0/engine exec tsx scripts/smoke-pi-ai.ts
 *   GEMINI_API_KEY=... ZERO_PROVIDER=google pnpm --filter @0/engine exec tsx scripts/smoke-pi-ai.ts
 *
 * ZERO_SMOKE_MAX_TOKENS=32 caps output tokens per request.
 * Exits non-zero when a check fails.
 */
import { PiAiRuntime } from "../src/runtime/pi/index.js";
import type { NativeMessage, NativeToolDef } from "../src/runtime/types.js";

const provider = process.env["ZERO_PROVIDER"] as ConstructorParameters<typeof PiAiRuntime>[0]["provider"];
const maxTokens = Number.parseInt(process.env["ZERO_SMOKE_MAX_TOKENS"] ?? "", 10);
const runtime = new PiAiRuntime(
  { type: "api", timeout: 60_000, ...(provider ? { provider } : {}) },
  Number.isFinite(maxTokens) && maxTokens > 0 ? { requestOptions: { maxTokens } } : {},
);
if (!(await runtime.isAvailable())) {
  const probe = await runtime.executeNative("", [{ role: "user", content: [{ type: "text", text: "x" }] }], []);
  console.error(`pi-ai runtime unavailable: ${probe.error}`);
  process.exit(2);
}
console.log(`provider=${runtime.resolvedProvider()} model=${runtime.resolvedModel()}`);

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const user = (text: string): NativeMessage => ({ role: "user", content: [{ type: "text", text }] });
const echo: NativeToolDef = { name: "echo", description: "Echo text back", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };

let streamed = "";
const text = await runtime.executeNative("Be terse.", [user("Reply with exactly: pong")], [], { onDelta: (s, t) => { if (s === "assistant_response") streamed += t; } });
check("text turn", text.stopReason === "end_turn" && JSON.stringify(text.content).toLowerCase().includes("pong"), text);
check("streamed deltas match", streamed.length > 0, streamed);
check("usage reported", (text.usage?.inputTokens ?? 0) > 0 && (text.usage?.outputTokens ?? 0) > 0, text.usage);

const history: NativeMessage[] = [user("Call the echo tool with text 'hi'. Do not answer in prose.")];
const call = await runtime.executeNative("Use tools when asked.", history, [echo]);
const use = call.content.find((b) => b.type === "tool_use");
check("tool call", call.stopReason === "tool_use" && use?.type === "tool_use" && use.name === "echo", call);
if (use?.type === "tool_use") {
  history.push({ role: "assistant", content: call.content, ...(call.providerRaw ? { providerRaw: call.providerRaw } : {}) });
  history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "hi" }] });
  const follow = await runtime.executeNative("Use tools when asked.", history, [echo]);
  check("tool result accepted, round-trip continues", follow.stopReason !== "error", follow);
}

const controller = new AbortController();
controller.abort();
const cancelled = await runtime.executeNative("", [user("never sent")], [], undefined, controller.signal);
check("pre-aborted => cancelled, no request", cancelled.cancelled === true && cancelled.durationMs < 50, cancelled);

console.log(`pi cost estimate (USD): ${runtime.totalRequestCostUsd().toFixed(6)}`);
process.exit(failed === 0 ? 0 : 1);

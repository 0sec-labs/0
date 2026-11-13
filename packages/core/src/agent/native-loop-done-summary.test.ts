import { chmodSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { osecDB } from "@0/db";
import { getToolsForRole } from "./tools.js";
import { setWorkspaceHarnessTrust } from "../plugins/harness-trust.js";
import { runNativeAgentLoop } from "./native-loop.js";
import type { NativeRuntime, NativeRuntimeResult, NativeContentBlock } from "../runtime/types.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "0-done-summary-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
  vi.stubEnv("ZERO_NO_TELEMETRY", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  const unlock = (directory: string): void => {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) unlock(join(directory, entry.name));
  };
  unlock(home); rmSync(home, { recursive: true, force: true });
});
const observation = "Validated two controls; sharing settings remain untested because the read scope is unavailable.";
const text = (value: string): NativeRuntimeResult => ({ content: [{ type: "text", text: value }], stopReason: "end_turn", durationMs: 0 });
const finish = (summary?: string, prose?: string): NativeRuntimeResult => ({ content: [
  ...(prose === undefined ? [] : [{ type: "text", text: prose } as NativeContentBlock]),
  { type: "tool_use", id: "finish", name: "done", input: summary === undefined ? {} : { summary } },
], stopReason: "tool_use", durationMs: 0 });
async function run(responses: NativeRuntimeResult[], resume?: { db: osecDB; scanId: string; sessionId: string }) {
  const runtime: NativeRuntime = { type: "api", isAvailable: async () => true,
    executeNative: async () => { const response = responses.shift(); if (!response) throw new Error("Unexpected extra model invocation"); return response; },
  };
  return runNativeAgentLoop({ config: { role: "discovery", systemPrompt: "Report observations accurately.", tools: [],
    target: "https://example.test", maxTurns: 4, scanId: resume?.scanId ?? randomUUID(), sessionId: resume?.sessionId, codebaseLearning: false }, runtime, db: resume?.db ?? null });
}
it.each([undefined, "", "   ", "Task completed", "Task completed.", "TASK COMPLETED!"])
("retains prior observations when done supplies only a generic completion: %j", async summary => {
  const state = await run([text(observation), finish(summary)]);
  expect(state.done).toBe(true);
  expect(state.summary).toBe(observation);
  expect(state.errorExit).toBeUndefined();
});
it("retains prose accompanying done in the same response", async () => {
  expect((await run([finish(undefined, observation)])).summary).toBe(observation);
});
it("prefers the latest assistant observations across a continuation", async () => {
  expect((await run([text("Initial inspection remains incomplete."), text(observation), finish()])).summary).toBe(observation);
});
it("keeps an explicit informative final summary", async () => {
  expect((await run([text(observation), finish("Final result: two checks verified; remaining coverage blocked.")])).summary)
    .toBe("Final result: two checks verified; remaining coverage blocked.");
});
it("does not invent observations when done is the only output", async () => {
  expect((await run([finish()])).summary).toBe("Task completed");
});

it("does not promote old paused-session prose when this invocation has no observation", async () => {
  const db = new osecDB(join(home, "session.db"));
  const scanId = db.createScan({ target: "https://example.test", depth: "default", format: "json" });
  const sessionId = randomUUID();
  db.saveSession({ id: sessionId, scanId, agentRole: "discovery", turnCount: 1,
    messages: [{ role: "assistant", content: [{ type: "text", text: "Prior inspection, not a new observation." }] }], toolContext: {}, status: "paused" });
  try {
    expect((await run([finish()], { db, scanId, sessionId })).summary).toBe("Task completed");
  } finally { db.close(); }
});
it.each([undefined, "Task completed", "Final result from the driver."])
("preserves accepted current-turn prose through the actual executable driver done path: %j", async summary => {
  const args = summary === undefined ? {} : { summary };
  const generation = { label: "done-summary", providers: [{ id: "driver", services: ["agent.driver"], source: {
    kind: "trusted", entry: "main.mjs", files: { "main.mjs": `export function activate() { return { async driver(request, execution) {
      const result = await execution.invokeModel(request);
      await execution.invokeTool('done',${JSON.stringify(args)});
      return result;
    } }; }` },
  } }] };
  let calls = 0;
  const runtime: NativeRuntime = { type: "api", isAvailable: async () => true, executeNative: async () => {
    calls++;
    if (calls > 2) throw new Error("Unexpected extra invocation");
    return { content: calls === 1 ? [
      { type: "text", text: "Initial inspection is incomplete." },
      { type: "tool_use", id: "install", name: "self_extend", input: { action: "harness_submit", generation } },
    ] : [{ type: "text", text: observation }], stopReason: calls === 1 ? "tool_use" : "end_turn", durationMs: 0,
      usage: { inputTokens: 10, outputTokens: 2 } };
  } };
  setWorkspaceHarnessTrust(home, true);
  const state = await runNativeAgentLoop({ config: { role: "discovery", systemPrompt: "Synthetic driver fixture", tools: getToolsForRole("discovery"),
    target: "https://example.test", maxTurns: 3, scanId: randomUUID(), workspaceRoot: home, autonomyMode: "yolo", codebaseLearning: false,
    allowModelSelfExtension: true, executablePlugins: { backend: "docker", root: join(home, "plugins") }, executableEvolutionProfiles: {} }, runtime, db: null });
  expect(calls).toBe(2);
  expect(state.done).toBe(true);
  expect(state.errorExit).toBeUndefined();
  expect(state.summary).toBe(summary?.startsWith("Final") ? summary : observation);
});
it("never promotes streamed reasoning to completion observations", async () => {
  const runtime: NativeRuntime = { type: "api", isAvailable: async () => true,
    executeNative: async (_system, _messages, _tools, callbacks) => {
      callbacks?.onThinking?.("Private reasoning is not a reported observation.");
      return finish();
    },
  };
  const state = await runNativeAgentLoop({ config: { role: "discovery", systemPrompt: "Synthetic fixture", tools: [],
    target: "https://example.test", maxTurns: 1, scanId: randomUUID(), codebaseLearning: false }, runtime, db: null });
  expect(state.summary).toBe("Task completed");
});

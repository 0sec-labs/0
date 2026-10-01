import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LearningStore, learningProjectId } from "@0/db";
import { HuntMemoryStore } from "../memory/index.js";
import { runNativeAgentLoop, type NativeAgentConfig } from "./native-loop.js";
import type { NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";

describe("native source learning mirror", () => {
  let root: string;
  let learning: LearningStore;
  let memory: HuntMemoryStore;
  beforeEach(() => {
    vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "0");
    root = realpathSync(mkdtempSync(join(tmpdir(), "0-native-learning-")));
    writeFileSync(join(root, "module.ts"), "export const route = '/health';\n");
    learning = new LearningStore(":memory:");
    memory = new HuntMemoryStore({ path: join(root, "notes.jsonl") });
  });
  afterEach(() => {
    learning.close();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const runtime = (result?: NativeRuntimeResult): NativeRuntime => ({
    type: "api", isAvailable: async () => true,
    executeNative: async () => result ?? ({ content: [{ type: "text", text: "Review complete" }], stopReason: "end_turn", durationMs: 0 }),
  });
  const config = (root: string, extra: Partial<NativeAgentConfig> = {}): NativeAgentConfig => ({
    role: "review", codebaseLearning: true, scopePath: root, target: root,
    systemPrompt: "Review source", tools: [], maxTurns: 1, scanId: "source-mirror", ...extra,
  });

  it("mirrors an accepted source note with canonical identity and retains execution separately", async () => {
    await runNativeAgentLoop({ config: config(root), db: null, learningStore: learning, huntMemoryStore: memory,
      runtime: runtime({ content: [{ type: "tool_use", id: "learn", name: "remember_codebase", input: {
        title: "Health routing", summary: "Health route is declared in module.ts.", paths: ["module.ts"],
        root: "/outside", digests: ["forged"],
      } }], stopReason: "tool_use", durationMs: 0 }) });
    const projectId = learningProjectId(root);
    const knowledge = learning.listKnowledge({ projectId });
    expect(knowledge).toHaveLength(1);
    expect(knowledge[0]?.sourceLinks).toEqual([{ path: "module.ts", hash: memory.recallCodebase(root)[0]?.codebase?.files[0]?.digest }]);
    expect(learning.listCandidates({ projectId })).toEqual([]);
    const events = learning.listEvents({ projectId });
    expect(events.find(event => event.kind === "source-context")?.evidenceStrength).toBe("hypothesis");
    expect(events.find(event => event.kind === "source-agent-terminal")?.evidenceStrength).toBe("operational");
    expect(events.some(event => JSON.stringify(event).includes("forged"))).toBe(false);
    // The caller owns its injected store after the agent exits.
    expect(learning.listKnowledge({ projectId })).toHaveLength(1);
  });

  it.each(["verify", "disabled", "invalid"] as const)("keeps %s source notes out of the ledger", async mode => {
    if (mode === "disabled") vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
    const args = mode === "invalid" ? ["../outside.ts"] : ["module.ts"];
    await runNativeAgentLoop({ config: config(root, { role: mode === "verify" ? "verify" : "review" }),
      db: null, learningStore: learning, huntMemoryStore: memory,
      runtime: runtime({ content: [{ type: "tool_use", id: "learn", name: "remember_codebase", input: {
        title: "Routing", summary: "This source note should never be retained.", paths: args,
      } }], stopReason: "tool_use", durationMs: 0 }) });
    expect(learning.listKnowledge()).toEqual([]);
    expect(learning.listCandidates()).toEqual([]);
    expect(learning.listEvents().filter(event => event.kind === "source-context")).toEqual([]);
  });

  it("rechecks source evidence on later recall and does not mirror changed files", async () => {
    memory.rememberCodebase({ root, paths: ["module.ts"], title: "Routing", summary: "Health route is declared in module.ts.", source: "test" });
    await runNativeAgentLoop({ config: config(root), db: null, learningStore: learning, huntMemoryStore: memory, runtime: runtime() });
    expect(learning.listKnowledge()).toHaveLength(1);
    writeFileSync(join(root, "module.ts"), "export const route = '/status';\n");
    await runNativeAgentLoop({ config: config(root, { scanId: "source-changed" }), db: null, learningStore: learning, huntMemoryStore: memory, runtime: runtime() });
    expect(learning.listEvents().filter(event => event.kind === "source-context")).toHaveLength(1);
    expect(learning.listKnowledge()[0]?.status).toBe("stale");
  });
});

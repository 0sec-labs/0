import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LearningStore, learningProjectId } from "@0/db";
import { HuntMemoryStore } from "../memory/hunt-memory.js";
import { createConsoleSession } from "./turn-engine.js";
import type { NativeMessage, NativeRuntime, NativeRuntimeResult, NativeToolDef } from "../runtime/types.js";

vi.mock("../plugins/enablement.js", async (importOriginal) => ({
  ...await importOriginal<object>(),
  readEnablement: () => ({ schema: 1, project: process.cwd(), enabled: { scope: { version: "1.0.0", capabilities: [], enabledAt: 1 } } }),
}));
const done = (): NativeRuntimeResult => ({ content: [{ type: "text", text: "Review complete" }], stopReason: "end_turn", durationMs: 0 });
const tool = (name: string, input: Record<string, unknown>): NativeRuntimeResult => ({ content: [{ type: "tool_use", id: name, name, input }], stopReason: "tool_use", durationMs: 0 });
class Runtime implements NativeRuntime {
  readonly type = "api" as const;
  calls: Array<{ messages: NativeMessage[]; tools: NativeToolDef[] }> = [];
  constructor(private script: NativeRuntimeResult[]) {}
  async isAvailable() { return true; }
  async executeNative(_system: string, messages: NativeMessage[], tools: NativeToolDef[]) {
    this.calls.push({ messages: structuredClone(messages), tools });
    return this.script.shift() ?? done();
  }
}

describe("console source lessons", () => {
  let root: string;
  let memory: HuntMemoryStore;
  let learning: LearningStore;
  beforeEach(() => {
    vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "0");
    root = realpathSync(mkdtempSync(join(tmpdir(), "zero-console-lessons-")));
    writeFileSync(join(root, "routes.ts"), "export const tenantCheck = 'ownership';\n");
    memory = new HuntMemoryStore({ path: join(root, "memory.jsonl") });
    learning = new LearningStore(":memory:");
  });
  afterEach(() => { learning.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const inspect = (root: string) => tool("read_file", { path: join(root, "routes.ts") });
  const save = () => tool("remember_codebase", { title: "Tenant checks", summary: "Investigate ownership checks in routes.ts before testing tenant access.", paths: ["routes.ts"] });
  const session = (runtime: Runtime, extra: Record<string, unknown> = {}) => createConsoleSession({
    runtime, workspaceRoot: root, autonomyMode: "yolo", allowSelfExtension: false,
    codebaseLearning: true, huntMemoryStore: memory, learningStore: learning, ...extra,
  });

  it("saves a meaningful source lesson and supplies it in a later relevant chat without persisting hints into its history", async () => {
    const first = session(new Runtime([inspect(root), save(), done()]));
    await first.send("Review tenant isolation");
    await first.cleanup();
    expect(memory.recallCodebase(root)).toHaveLength(1);
    expect(learning.listKnowledge({ projectId: learningProjectId(root) })).toHaveLength(1);
    const runtime = new Runtime([inspect(root), done()]);
    const second = session(runtime);
    await second.send("Review the same source again");
    expect(JSON.stringify(runtime.calls[0]?.messages)).not.toContain("Prior source lessons");
    expect(JSON.stringify(runtime.calls[1]?.messages)).toContain("Investigate ownership checks");
    expect(JSON.stringify(second.exportCheckpoint().messages)).not.toContain("Prior source lessons");
    await second.cleanup();
    expect(learning.listKnowledge()).toHaveLength(1); // injected store remains caller-owned
  });

  it("excludes source lessons after file changes and marks their retained evidence stale", async () => {
    const first = session(new Runtime([inspect(root), save(), done()]));
    await first.send("Inspect"); await first.cleanup();
    writeFileSync(join(root, "routes.ts"), "export const tenantCheck = 'changed';\n");
    const runtime = new Runtime([inspect(root), done()]);
    const next = session(runtime);
    await next.send("Inspect changed source"); await next.cleanup();
    expect(JSON.stringify(runtime.calls)).not.toContain("Investigate ownership checks");
    expect(learning.listKnowledge()[0]?.status).toBe("stale");
  });

  it("respects disabled retained notes on later recall", async () => {
    const first = session(new Runtime([inspect(root), save(), done()]));
    await first.send("Inspect"); await first.cleanup();
    learning.setKnowledgeStatus(learning.listKnowledge()[0]!.id, "disabled");
    const runtime = new Runtime([inspect(root), done()]);
    const next = session(runtime);
    await next.send("Inspect"); await next.cleanup();
    expect(JSON.stringify(runtime.calls)).not.toContain("Investigate ownership checks");
    expect(learning.listKnowledge()[0]?.status).toBe("disabled");
  });

  it("does not reuse another project's lesson or learn from a plain completed chat", async () => {
    memory.rememberCodebase({ root, paths: ["routes.ts"], title: "Ownership", summary: "Investigate ownership checks", source: "test" });
    const other = join(root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "routes.ts"), "export const tenantCheck = 'ownership';\n");
    const runtime = new Runtime([inspect(other), done()]);
    const current = session(runtime, { workspaceRoot: other });
    await current.send("Inspect another project"); await current.cleanup();
    expect(JSON.stringify(runtime.calls)).not.toContain("Investigate ownership checks");
    expect(learning.listKnowledge()).toEqual([]);
    const casual = session(new Runtime([done()]));
    await casual.send("Hello"); await casual.cleanup();
    expect(memory.all()).toHaveLength(1);
    expect(learning.listKnowledge()).toEqual([]);
  });

  it("refreshes transient host hints before every planner request without storing them", async () => {
    const hint = { title: "Tenant checks", summary: "Use the ownership fixture before tenant access tests.", sourceLinks: [{ path: "routes.ts", hash: "sha256:" + "a".repeat(64) }] };
    let calls = 0;
    const provider = vi.fn(async (_root: string) => ++calls === 1 ? [hint] : []);
    const runtime = new Runtime([inspect(root), inspect(root), done()]);
    const current = session(runtime, { sourceLessonHints: provider });
    await current.send("Investigate");
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[0]?.[0]).toBe(root);
    expect(JSON.stringify(runtime.calls[1]?.messages)).toContain(hint.summary);
    expect(JSON.stringify(runtime.calls[2]?.messages)).not.toContain(hint.summary);
    expect(memory.all()).toEqual([]);
    expect(JSON.stringify(current.exportCheckpoint().messages)).not.toContain(hint.summary);
    await current.cleanup();
  });
  it("does not add or dispatch the save-lesson tool through an explicit empty tool restriction", async () => {
    const runtime = new Runtime([save(), done()]);
    const current = session(runtime, { tools: [] });
    await current.send("Inspect"); await current.cleanup();
    expect(runtime.calls[0]?.tools.some(tool => tool.name === "remember_codebase")).toBe(false);
    expect(memory.all()).toEqual([]);
  });

  it.each(["verify", "disabled", "opt-out", "unscoped", "traversal"])("does not retain source lessons when %s", async mode => {
    if (mode === "disabled") vi.stubEnv("ZERO_DISABLE_HUNT_MEMORY", "1");
    const runtime = new Runtime([...(mode === "unscoped" ? [] : [inspect(root)]),
      mode === "traversal" ? tool("remember_codebase", { title: "Unsafe", summary: "No", paths: ["../outside"] }) : save(), done()]);
    const current = session(runtime, mode === "verify" ? { role: "verify" } : mode === "opt-out" ? { codebaseLearning: false } : {});
    await current.send("Inspect"); await current.cleanup();
    expect(memory.recallCodebase(root)).toEqual([]);
    expect(learning.listKnowledge()).toEqual([]);
    if (mode === "verify" || mode === "disabled" || mode === "opt-out") expect(runtime.calls[0]?.tools.some(t => t.name === "remember_codebase")).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LearningStore, learningProjectId } from "@0/db";
import { HuntMemoryStore } from "../memory/hunt-memory.js";
import { LearningService } from "../learning-service.js";
import { setWorkspaceHarnessTrust } from "../plugins/harness-trust.js";
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

  it("recalls an older eligible lesson when recent lessons are disabled", async () => {
    for (let index = 0; index < 7; index++) memory.rememberCodebase({
      root, paths: ["routes.ts"], title: `Lesson ${index}`, summary: `Source lesson ${index}`, source: "test",
    });
    new LearningService(learning).importCodebaseNotes(learningProjectId(root), root, memory, 16);
    for (const entry of learning.listKnowledge()) {
      if (entry.summary !== "Source lesson 0") learning.setKnowledgeStatus(entry.id, "disabled");
    }
    const runtime = new Runtime([inspect(root), done()]);
    const current = session(runtime);
    try {
      await current.send("Inspect the source");
      const recalled = JSON.stringify(runtime.calls[1]?.messages);
      expect(recalled).toContain("Source lesson 0");
      for (let index = 1; index < 7; index++) expect(recalled).not.toContain(`Source lesson ${index}`);
    } finally { await current.cleanup(); }
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
  it("publishes only the last actual planner's source lessons and clears them after source changes", async () => {
    const note = memory.rememberCodebase({ root, paths: ["routes.ts"], title: "Ownership", summary: "Inspect tenant ownership", source: "test" });
    const runtime = new Runtime([done(), done()]);
    const current = session(runtime);
    await current.ready;
    current.configureWorkspace(root);
    try {
      expect(current.sourceContext).toEqual({ status: "not_requested", lessons: [] });
      await current.send("Review ownership");
      const expected = [{ title: note.title, summary: note.summary, sourceLinks: note.codebase!.files.map(file => ({ path: file.path, hash: file.digest })) }];
      expect(current.sourceContext).toEqual({ status: "supplied", lessons: expected });
      const injected = runtime.calls[0]!.messages[0]!.content[0]!;
      expect(injected.type).toBe("text");
      if (injected.type === "text") expect(JSON.parse(injected.text.slice(injected.text.indexOf("\n") + 1))).toEqual(expected);
      current.sourceContext!.lessons.splice(0); // callers cannot mutate telemetry
      expect(current.sourceContext!.lessons).toEqual(expected);
      expect(JSON.stringify(current.exportCheckpoint())).not.toContain("Prior source lessons");
      current.clearConversation();
      expect(current.sourceContext).toEqual({ status: "not_requested", lessons: [] });
      writeFileSync(join(root, "routes.ts"), "export const changed = true;\n");
      await current.send("Review updated source");
      expect(current.sourceContext).toEqual({ status: "none", lessons: [] });
      expect(JSON.stringify(runtime.calls[1]!.messages)).not.toContain("Inspect tenant ownership");
    } finally { await current.cleanup(); }
  });

  it("retrieves source lessons once per direct planner boundary", async () => {
    const recall = vi.spyOn(LearningService.prototype, "recallCodebaseNotes");
    const runtime = new Runtime([inspect(root), done()]);
    const current = session(runtime);
    await current.ready;
    current.configureWorkspace(root);
    try {
      await current.send("Inspect source");
      expect(runtime.calls).toHaveLength(2);
      expect(recall).toHaveBeenCalledTimes(2);
    } finally { recall.mockRestore(); await current.cleanup(); }
  });

  it("does not publish source previews when estimates stop a request before the planner", async () => {
    memory.rememberCodebase({ root, paths: ["routes.ts"], title: "Ownership", summary: "Inspect tenant ownership", source: "test" });
    const runtime = new Runtime([done()]);
    const current = session(runtime, { maxTurnTokens: 1 });
    await current.ready;
    current.configureWorkspace(root);
    try {
      await current.send("Review source");
      expect(runtime.calls).toEqual([]);
      expect(current.sourceContext).toEqual({ status: "not_requested", lessons: [] });
    } finally { await current.cleanup(); }
  });

  it("omits whole oversized hints and reports exactly the complete notes actually sent", async () => {
    const short = { title: "Useful source", summary: "Check tenant ownership", sourceLinks: [{ path: "routes.ts", hash: "sha256:" + "a".repeat(64) }] };
    const oversized = { ...short, title: "Too large", summary: "x".repeat(12001) };
    const runtime = new Runtime([done()]);
    const current = session(runtime, { sourceLessonHints: async () => [oversized, short] });
    await current.ready;
    current.configureWorkspace(root);
    try {
      await current.send("Review source");
      expect(current.sourceContext).toEqual({ status: "supplied", lessons: [short] });
      const injected = runtime.calls[0]!.messages[0]!.content[0]!;
      expect(injected.type).toBe("text");
      if (injected.type === "text") {
        const json = injected.text.slice(injected.text.indexOf("\n") + 1);
        expect(json.length).toBeLessThanOrEqual(12000);
        expect(JSON.parse(json)).toEqual([short]);
      }
      expect(JSON.stringify(current.exportCheckpoint())).not.toContain(short.summary);
    } finally { await current.cleanup(); }
  });

  it.each(["forwarded", "omitted", "no-model"])("records actual driver model context when source hints are %s", async mode => {
    memory.rememberCodebase({ root, paths: ["routes.ts"], title: "Ownership", summary: "Inspect tenant ownership", source: "test" });
    const runtime = new Runtime([done()]);
    const current = session(runtime, { allowModelSelfExtension: true, refineObjective: false });
    await current.ready;
    current.configureWorkspace(root);
    try {
      setWorkspaceHarnessTrust(root, true);
      await current.harness!.control({ action: "submit", generation: { label: "source-context", providers: [{
        id: "driver", services: ["agent.driver"], source: { kind: "trusted", entry: "main.mjs", files: {
          "main.mjs": `export function activate() { return { async driver(request, execution) {
            ${mode === "forwarded" ? "await execution.invokeModel(request);" : mode === "omitted" ? "await execution.invokeModel({...request,messages:[{role:'user',content:[{type:'text',text:'Review source'}]}]});" : ""}
            return {content:[{type:'text',text:'Done'}],stopReason:'end_turn',durationMs:0};
          } }; }`,
        } },
      }] } });
      await current.send("Review source");
      expect(runtime.calls).toHaveLength(mode === "no-model" ? 0 : 1);
      expect(current.sourceContext?.status).toBe(mode === "forwarded" ? "supplied" : mode === "omitted" ? "none" : "not_requested");
      expect(current.sourceContext?.lessons).toHaveLength(mode === "forwarded" ? 1 : 0);
    } finally { await current.cleanup(); }
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

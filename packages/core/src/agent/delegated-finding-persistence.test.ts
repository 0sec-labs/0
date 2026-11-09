import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { osecDB } from "@0/db";
import type { Finding } from "@0/shared";
import type { NativeRuntime, NativeRuntimeResult } from "../runtime/types.js";
import { ToolExecutor, TOOL_DEFINITIONS } from "./tools.js";
import type { ToolContext } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });
function fixture(overrides: Partial<ToolContext> = {}) {
  const home = mkdtempSync(join(tmpdir(), "0-delegated-findings-"));
  const db = new osecDB(join(home, "selected.db"));
  db.createScan({ target: "https://fixture.test", depth: "default", format: "json" }, "root");
  const context = { target: "https://fixture.test", scanId: "root", role: "attack", consoleSession: true,
    findings: [], attackResults: [], targetInfo: {}, autonomyMode: "yolo",
    delegationTools: [TOOL_DEFINITIONS.save_finding, TOOL_DEFINITIONS.spawn_agent, TOOL_DEFINITIONS.done],
    agentMessaging: { selfId: "Main", selfRole: "parent", siblingChannelEnabled: true, operatorChannelEnabled: false, projectPath: home, homeDir: home }, ...overrides,
  } as ToolContext;
  let sequence = 0;
  const factory = async (): Promise<NativeRuntime> => {
    const nested = sequence++ === 0;
    const calls = [
      { name: "save_finding", input: { title: nested ? "Child finding" : "Grandchild finding", severity: "high", category: "xss", description: "Synthetic evidence", evidence_request: "GET /fixture", evidence_response: "<script>synthetic</script>" } },
      ...(nested ? [{ name: "spawn_agent", input: { task: "Inspect nested evidence", wait: false } }] : []),
      { name: "done", input: { summary: "Synthetic review complete" } },
    ];
    return { type: "api", isAvailable: async () => true, forkForSubagent: factory,
      executeNative: async (): Promise<NativeRuntimeResult> => {
        const call = calls.shift();
        if (!call) throw new Error("Unexpected model call");
        return { content: [{ type: "tool_use", id: `call-${calls.length}`, ...call }], stopReason: "tool_use", durationMs: 0 };
      },
    };
  };
  const tools = new ToolExecutor(context, db, undefined, factory);
  cleanups.push(async () => { await tools.cleanup(); db.close(); rmSync(home, { recursive: true, force: true }); });
  return { tools, db, home, context };
}
it("persists background child and nested findings through the selected root store", async () => {
  const { tools, db, home } = fixture();
  const result = await tools.execute({ name: "spawn_agent", arguments: { task: "Inspect evidence" } });
  expect(result.success).toBe(true);
  await vi.waitFor(() => expect(db.getFindings("root").map(row => row.title).sort()).toEqual(["Child finding", "Grandchild finding"]), { timeout: 5000 });
  expect(db.listScans()).toHaveLength(1);
  const reader = new osecDB(join(home, "selected.db"), { readOnly: true });
  try { expect(reader.getFindings("root")).toHaveLength(2); } finally { reader.close(); }
});
it("deduplicates worker publication and rejects publication after subtree cancellation", async () => {
  const { tools, db } = fixture();
  let publish!: (finding: Finding) => void;
  vi.spyOn(tools as any, "loadSubagentDeps").mockResolvedValue({ runNativeAgentLoop: async (options: any) => {
    publish = options.config.persistDelegatedFinding;
    return { findings: [], turnCount: 1, summary: "Finished", done: true };
  } });
  const result = await tools.execute({ name: "spawn_agent", arguments: { task: "Inspect evidence" } });
  await vi.waitFor(() => expect(publish).toBeTypeOf("function"));
  const finding: Finding = { id: "same-finding", templateId: "fixture", title: "Deduplicated", description: "Synthetic", severity: "high", category: "xss", status: "discovered", timestamp: 1, evidence: { request: "request", response: "response" } };
  const writer = vi.spyOn(db, "saveFinding");
  publish(finding); publish(finding);
  expect(writer).toHaveBeenCalledTimes(1);
  db.saveFinding("root", { ...finding, status: "verified", confidence: .99 });
  publish(finding);
  expect(db.getFinding(finding.id)).toMatchObject({ status: "verified", confidence: .99 });
  await tools.stopPersistentAgent((result.output as { agent_id: string }).agent_id);
  expect(() => publish({ ...finding, id: "late" })).toThrow();
  expect(db.getFinding("late")).toBeUndefined();
});

it("preserves explicitly disabled persistence through nested delegation", async () => {
  const { tools, db, context } = fixture({ persistFindings: false });
  expect((await tools.execute({ name: "spawn_agent", arguments: { task: "Inspect without publishing" } })).success).toBe(true);
  await vi.waitFor(() => expect(context.findings).toHaveLength(2), { timeout: 5000 });
  expect(db.getFindings("root")).toEqual([]);
});

it("keeps non-console delegation in memory until the scan pipeline persists it", async () => {
  const { tools, db, context } = fixture({ consoleSession: false });
  expect((await tools.execute({ name: "spawn_agent", arguments: { task: "Inspect scan evidence", wait: true } })).success).toBe(true);
  await vi.waitFor(() => expect(context.findings).toHaveLength(2), { timeout: 5000 });
  expect(db.getFindings("root")).toEqual([]);
  for (const finding of context.findings) db.saveFinding("root", { ...finding, status: "verified" });
  expect(db.getFindings("root").map(row => row.status)).toEqual(["verified", "verified"]);
});
it("returns a save failure without retaining an unsaved duplicate, allowing retry", async () => {
  const { tools, db, context } = fixture();
  let publish!: (finding: Finding) => void;
  vi.spyOn(tools as any, "loadSubagentDeps").mockResolvedValue({ runNativeAgentLoop: async (options: any) => {
    publish = options.config.persistDelegatedFinding;
    return { findings: [], turnCount: 1, summary: "Finished", done: true };
  } });
  await tools.execute({ name: "spawn_agent", arguments: { task: "Inspect evidence" } });
  await vi.waitFor(() => expect(publish).toBeTypeOf("function"));
  const childContext = { ...context, scanId: "child", findings: [], persistFindings: true, persistDelegatedFinding: publish };
  const child = new ToolExecutor(childContext);
  try {
    vi.spyOn(db, "saveFinding").mockImplementationOnce(() => { throw new Error("Synthetic database write failure"); });
    const call = { name: "save_finding", arguments: { title: "Retry finding", severity: "high", category: "xss", evidence_request: "GET /fixture", evidence_response: "Synthetic evidence" } };
    expect(await child.execute(call)).toMatchObject({ success: false, error: "Synthetic database write failure" });
    expect(childContext.findings).toEqual([]);
    expect(db.getFindings("root")).toEqual([]);
    expect(await child.execute(call)).toMatchObject({ success: true, output: { message: "Finding saved" } });
    expect(db.getFindings("root")).toHaveLength(1);
  } finally { await child.cleanup(); }
});

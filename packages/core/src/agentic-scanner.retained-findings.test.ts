import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { osecDB } from "@0/db";
import { agenticScan } from "./agentic-scanner.js";
import type { NativeRuntime } from "./runtime/types.js";

const homes: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
it.each([true, false])("retains saved discovery evidence after attack failure (save=%s)", async save => {
  const home = mkdtempSync(join(tmpdir(), "0-retained-discovery-")); homes.push(home);
  const dbPath = join(home, "selected.db");
  const scopeFile = join(home, "scope.json");
  writeFileSync(scopeFile, JSON.stringify({ in_scope: ["127.0.0.1"] }));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden in synthetic retention test")));
  const calls: string[] = [];
  const runtime = (role = "discovery"): NativeRuntime => {
    let turn = 0;
    return { type: "api", isAvailable: async () => true,
      forkForSubagent: async (_timeout, selection) => runtime(selection?.role ?? "discovery"),
      executeNative: async () => {
        calls.push(role);
        if (role !== "discovery") return { content: [], stopReason: "error", durationMs: 0,
          usage: { inputTokens: 1, outputTokens: 0 }, error: "Injected terminal provider failure" };
        if (save && turn++ === 0) return { content: [{ type: "tool_use", id: "save-fixture", name: "save_finding", input: {
          title: "Synthetic retained discovery finding", severity: "low", category: "information-disclosure",
          description: "Persistence fixture only; no target assessment or vulnerability verification.",
          evidence_request: "Synthetic request", evidence_response: "Synthetic response",
        } }], stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 1, outputTokens: 1 } };
        return { content: [{ type: "tool_use", id: "done-fixture", name: "done", input: { summary: "Synthetic discovery complete" } }],
          stopReason: "tool_use", durationMs: 0, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
  };
  const report = await agenticScan({ config: {
    target: "http://127.0.0.1:43100", mode: "web", depth: "quick", format: "json", runtime: "api",
    scopeFile, singleModel: true, timeout: 30000,
  }, dbPath, nativeRuntime: runtime() });
  expect(calls).toContain("attack");
  expect(report).toMatchObject({ executionSuccessful: false, exitReason: "failed", error: "Injected terminal provider failure" });
  const db = new osecDB(dbPath, { readOnly: true });
  try {
    const scans = db.listScans(1);
    expect(scans).toHaveLength(1);
    expect(scans[0].status).toBe("failed");
    const retained = db.getFindings(scans[0].id);
    expect(retained).toHaveLength(save ? 1 : 0);
    expect(report.findings.map(finding => finding.id)).toEqual(retained.map(finding => finding.id));
    expect(report.summary).toMatchObject({ totalFindings: save ? 1 : 0, low: save ? 1 : 0 });
    if (save) {
      expect(report.findings[0]).toMatchObject({ status: "discovered", evidence: { request: "Synthetic request", response: "Synthetic response" } });
      expect(retained[0].status).toBe("discovered");
      const receipts = (report.trace ?? []).flatMap(message => message.content).filter(block => block.type === "tool_result");
      expect(JSON.stringify(receipts)).toContain("Finding saved");
    }
  } finally { db.close(); }
});

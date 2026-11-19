import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCAN_MODEL, resolveScanTarget, runScan, type ScanDeps } from "../scan.js";

const dirs: string[] = [];
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "scan-test-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); process.exitCode = undefined; });

const finishedSnapshot = (extra: Record<string, unknown> = {}) => ({
  session: { id: "t1", status: "ready", ...extra },
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.12 },
  messages: [
    { role: "assistant", content: [{ type: "text", text: "Covered app.js." }] },
  ],
});

const storedFinding = { id: "f1", templateId: "manual", title: "eval of query", description: "d", severity: "critical", category: "code-injection", status: "discovered", timestamp: 1, evidence: { request: "r", response: "s" }, reviewAnnotation: { path: "app.js", startLine: 1 } };
const storedReport = (findings: unknown[] = [storedFinding]) => ({ target: "", scanDepth: "default", startedAt: "", completedAt: "", durationMs: 0, summary: { totalAttacks: 0, totalFindings: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings, warnings: [] });

function fakes(snapshot: unknown, findings: unknown[] = [storedFinding]) {
  const requests: Array<[string, string, unknown]> = [];
  const out: Array<Uint8Array | string> = [];
  const err: string[] = [];
  const client = { request: vi.fn(async (method: string, path: string, body?: unknown) => { requests.push([method, path, body]); return method === "GET" ? { snapshot } : { session: { id: "t1" } }; }), dispose: vi.fn() };
  const deps: ScanDeps = {
    open: async () => client as never, out: bytes => out.push(bytes), err: text => err.push(text), sleep: async () => {}, now: () => new Date("2026-01-01T00:00:00Z"),
    writeBytes: vi.fn(), loadReport: vi.fn(() => storedReport(findings) as never), clone: vi.fn(async () => ({ dir: "/tmp/cloned", dispose: vi.fn() })),
  };
  return { deps, client, requests, out, err };
}
const options = (extra: Record<string, unknown> = {}) => ({ budget: "5", format: "json", timeout: "60", skill: "scan", ...extra }) as never;

describe("resolveScanTarget", () => {
  it("accepts a folder", async () => {
    const dir = folder();
    expect((await resolveScanTarget(dir, { clone: vi.fn() })).folder).toBe(dir);
  });
  it("clones a git URL", async () => {
    const clone = vi.fn(async () => ({ dir: "/tmp/x", dispose: () => {} }));
    const target = await resolveScanTarget("https://github.com/a/b", { clone });
    expect(clone).toHaveBeenCalledWith("https://github.com/a/b");
    expect(target.folder).toBe("/tmp/x");
  });
  it("does not guess what a package name or prefix means", async () => {
    for (const name of ["npm:lodash", "lodash"]) await expect(resolveScanTarget(name, { clone: vi.fn() })).rejects.toThrow(/not a folder/);
  });
  it("rejects a name that is not a folder", async () => {
    await expect(resolveScanTarget("lodash", { clone: vi.fn() })).rejects.toThrow(/not a folder/);
  });
});

describe("runScan", () => {
  it("starts a thread with the skill and budget, then prints the JSON report", async () => {
    const { deps, requests, out } = fakes(finishedSnapshot());
    await runScan(folder(), options(), deps);
    const create = requests.find(([method, path]) => method === "POST" && path === "/api/console/sessions")!;
    expect(create[2]).toMatchObject({ costCeilingUsd: 5 });
    expect(create[2]).not.toHaveProperty("verifySkill");
    expect(requests.find(([method, path]) => method === "POST" && path.endsWith("/messages"))![2]).toMatchObject({ text: expect.stringContaining("`scan` skill") });
    expect(requests.some(([method, path]) => method === "PATCH" && path.endsWith("/configuration"))).toBe(true);
    const report = JSON.parse(String(out[0]));
    expect(report).toMatchObject({ schemaVersion: 1, threadId: "t1", status: "complete", summary: "Covered app.js.", counts: { total: 1, critical: 1 } });
    expect(process.exitCode).toBeUndefined();
  });

  it("uses the default model unless --model is given", async () => {
    for (const [extra, expected] of [[{}, DEFAULT_SCAN_MODEL], [{ model: "other-model" }, "other-model"]] as const) {
      const { deps, requests } = fakes(finishedSnapshot());
      await runScan(folder(), options(extra), deps);
      expect(requests.find(([method, path]) => method === "POST" && path === "/api/console/sessions")![2]).toMatchObject({ runtime: { model: expected } });
    }
  });

  it("deletes the thread and hints at --model when setup fails", async () => {
    const { deps, client, err } = fakes(finishedSnapshot());
    client.request.mockImplementation(async (method: string, path: string) => {
      if (method === "PATCH") throw new Error("The selected model is not available to this account.");
      return method === "GET" ? { snapshot: finishedSnapshot() } : { session: { id: "t1" } };
    });
    await runScan(folder(), options(), deps);
    expect(client.request).toHaveBeenCalledWith("POST", "/api/console/sessions/t1/delete", {});
    expect(err.join("\n")).toMatch(/Pick another with --model/);
    expect(err.join("\n")).not.toMatch(/was created/);
    expect(process.exitCode).toBe(1);
  });

  it("reads findings from the store by thread id, not from the transcript", async () => {
    const { deps } = fakes(finishedSnapshot());
    await runScan(folder(), options(), deps);
    expect(deps.loadReport).toHaveBeenCalledWith("t1");
  });

  it("reports a clean scan with no findings", async () => {
    const { deps, out } = fakes(finishedSnapshot(), []);
    await runScan(folder(), options({ failOn: "low" }), deps);
    expect(JSON.parse(String(out[0]))).toMatchObject({ status: "complete", counts: { total: 0 } });
    expect(process.exitCode).toBeUndefined();
  });

  it("exits 1 when a finding reaches --fail-on", async () => {
    const { deps } = fakes(finishedSnapshot());
    await runScan(folder(), options({ failOn: "high" }), deps);
    expect(process.exitCode).toBe(1);
  });

  it("exits 3 and marks the report partial when the budget ran out", async () => {
    const { deps, out } = fakes(finishedSnapshot({ costCeilingExceeded: true, costCeilingUsd: 5 }));
    await runScan(folder(), options(), deps);
    expect(JSON.parse(String(out[0])).status).toBe("budget_exhausted");
    expect(process.exitCode).toBe(3);
  });

  it("cancels a thread that outlives --timeout and still reports what it stored, exit 3", async () => {
    const { deps, requests, out } = fakes({ session: { id: "t1", status: "working" }, usage: {}, messages: [] });
    await runScan(folder(), options({ timeout: "0.001" }), deps);
    expect(requests.some(([method, path]) => method === "POST" && path.endsWith("/cancel"))).toBe(true);
    expect(JSON.parse(String(out[0]))).toMatchObject({ status: "timed_out", counts: { total: 1 } });
    expect(process.exitCode).toBe(3);
  });

  it("writes to a file with -o", async () => {
    const { deps, out } = fakes(finishedSnapshot());
    await runScan(folder(), options({ output: "/tmp/report.json" }), deps);
    expect(deps.writeBytes).toHaveBeenCalledWith("/tmp/report.json", expect.any(Uint8Array));
    expect(out).toEqual([]);
  });

  it("rejects bad options before opening a thread", async () => {
    for (const bad of [{ budget: "0" }, { budget: "abc" }, { format: "xml" }, { failOn: "urgent" }, { timeout: "-1" }, { skill: "../x" }, { format: "pdf" }]) {
      const { deps, client } = fakes(finishedSnapshot());
      await runScan(folder(), options(bad), deps);
      expect(client.request, JSON.stringify(bad)).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;
    }
  });

  it("removes a cloned folder when it is done", async () => {
    const { deps } = fakes(finishedSnapshot());
    const dispose = vi.fn();
    deps.clone = vi.fn(async () => ({ dir: folder(), dispose }));
    await runScan("https://github.com/a/b", options(), deps);
    expect(dispose).toHaveBeenCalled();
  });
});

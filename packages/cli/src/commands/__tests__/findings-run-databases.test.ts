import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { osecDB } from "@0/engine/storage";
import type { Finding } from "@0/engine/shared";

let paths: string[] = [];
vi.mock("../../finding-focus.js", async importOriginal => ({ ...(await importOriginal<typeof import("../../finding-focus.js")>()), findingDatabasePaths: () => paths }));
const { runFindingsExport } = await import("../findings-export.js");

let directory: string;
const finding = (id: string, severity: string): Finding => ({ id, templateId: "source", title: `Finding ${id}`, description: "Issue", severity, category: "xss", status: "confirmed", timestamp: 1800000000000,
  evidence: { request: "src/a.ts:4", response: "evidence", analysis: "Reproduced" } } as Finding);
function seed(name: string, scan: string, id: string, severity: string): string {
  const path = join(directory, name);
  const db = new osecDB(path);
  try { db.createScan({ target: "repo", depth: "deep", format: "json" }, scan); db.saveFinding(scan, finding(id, severity)); db.completeScan(scan, { target: "repo" } as never); } finally { db.close(); }
  return path;
}
beforeEach(() => { process.exitCode = 0; directory = mkdtempSync(join(tmpdir(), "0-cli-run-dbs-")); paths = [seed("a.db", "scan-a", "aaa11111", "high"), seed("b.db", "scan-b", "bbb22222", "low")]; });
afterEach(() => { process.exitCode = 0; rmSync(directory, { recursive: true, force: true }); });

function deps() {
  const stdout: Uint8Array[] = []; const err: string[] = [];
  return { stdout, err, deps: { out: () => {}, err: (t: string) => err.push(t), writeBytes: () => {}, writeStdout: (b: Uint8Array) => { stdout.push(b); } } };
}

describe("findings in per-run databases", () => {
  it("exports every finding from every run database when no IDs are given", async () => {
    const h = deps();
    await runFindingsExport([], { format: "json" }, h.deps);
    expect(process.exitCode).toBe(0);
    const text = Buffer.concat(h.stdout).toString("utf8");
    expect(text).toContain("Finding aaa11111");
    expect(text).toContain("Finding bbb22222");
  });
  it("finds an ID by prefix in whichever run database holds it, and narrows by filter", async () => {
    const h = deps();
    await runFindingsExport(["bbb2"], { format: "md" }, h.deps);
    expect(process.exitCode).toBe(0);
    expect(Buffer.concat(h.stdout).toString("utf8")).toContain("Finding bbb22222");
    const high = deps();
    await runFindingsExport([], { format: "md", severity: "high" }, high.deps);
    const text = Buffer.concat(high.stdout).toString("utf8");
    expect(text).toContain("Finding aaa11111");
    expect(text).not.toContain("Finding bbb22222");
  });
  it("still reports a missing ID", async () => {
    const h = deps();
    await runFindingsExport(["zzz"], { format: "json" }, h.deps);
    expect(process.exitCode).toBe(1);
  });
});

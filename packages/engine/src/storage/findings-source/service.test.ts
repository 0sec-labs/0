import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding } from "../../shared/index.js";
import { homeStateDir } from "../../shared/index.js";
import { osecDB } from "../database.js";
import { FindingsService } from "./service.js";

let home: string;
const finding = (id: string, severity: string, extra: Partial<Finding> = {}): Finding => ({ id, templateId: "t", title: `Finding ${id}`, description: "Issue", severity, category: "xss", status: "confirmed",
  timestamp: 1800000000000, evidence: { request: "src/a.ts:4", response: "evidence", analysis: "ok" }, ...extra } as Finding);
function seed(path: string, scan: string, target: string, findings: Finding[], summary: Record<string, unknown> = {}): string {
  mkdirSync(dirname(path), { recursive: true });
  const db = new osecDB(path);
  try { db.createScan({ target, depth: "deep", format: "json" }, scan); for (const f of findings) db.saveFinding(scan, f); db.completeScan(scan, summary as never); } finally { db.close(); }
  return path;
}
const runPath = (id: string) => join(homeStateDir(home), "runs", id, "state.db");
const service = (options = {}) => new FindingsService({ homeDir: home, sharedDbPath: join(home, "shared.db"), ...options });

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "0-findings-source-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("FindingsService", () => {
  it("merges the shared database and run databases and de-duplicates by fingerprint", async () => {
    seed(join(home, "shared.db"), "console-1", "repo", [finding("s1", "low", { fingerprint: "fp-same", timestamp: 1800000000000 }), finding("s2", "medium", { fingerprint: "fp-shared-only" })]);
    seed(runPath("run-a"), "run-a", "https://a.example", [finding("a1", "high", { fingerprint: "fp-same", timestamp: 1800000005000 })]);
    seed(runPath("run-b"), "run-b", "https://b.example", [finding("b1", "critical", { fingerprint: "fp-b" })]);
    const merged = await service().list();
    expect(merged.families.map(f => f.key).sort()).toEqual(["fp-b", "fp-same", "fp-shared-only"]);
    const same = merged.families.find(f => f.key === "fp-same")!;
    expect(same.count).toBe(2);
    expect(same.scanCount).toBe(2);
    expect(same.latest.id).toBe("a1");
    expect(same.owners.map(o => o.kind).sort()).toEqual(["run", "shared"]);
    expect(merged.families[0]!.key).toBe("fp-b");
    expect(merged.scans.map(s => s.id).sort()).toEqual(["console-1", "run-a", "run-b"]);
  });

  it("describes where each finding came from", async () => {
    seed(join(home, "shared.db"), "console-9", "repo", [finding("t1", "low", { fingerprint: "fp-t" })]);
    seed(runPath("run-a"), "run-a", "https://a.example", [finding("a1", "high", { fingerprint: "fp-a" })]);
    seed(runPath("run-g"), "run-g", "repo", [finding("g1", "high", { fingerprint: "fp-g" })], { agent: "Reviewer" });
    const byKey = new Map((await service().list()).families.map(f => [f.key, f.provenance]));
    expect(byKey.get("fp-t")).toMatchObject({ kind: "thread" });
    expect(byKey.get("fp-a")).toMatchObject({ kind: "scan", target: "https://a.example", scanId: "run-a" });
    expect(byKey.get("fp-g")).toMatchObject({ kind: "agent", agent: "Reviewer" });
  });

  it("writes triage and workflow to every database that holds the family and nowhere else", async () => {
    const shared = seed(join(home, "shared.db"), "console-1", "repo", [finding("s1", "low", { fingerprint: "fp-same" })]);
    const a = seed(runPath("run-a"), "run-a", "x", [finding("a1", "high", { fingerprint: "fp-same" })]);
    const b = seed(runPath("run-b"), "run-b", "y", [finding("b1", "high", { fingerprint: "fp-other" })]);
    const svc = service();
    expect(await svc.writeFamily("fp-same", db => { db.updateFindingTriageByFingerprint("fp-same", "accepted", "ok"); db.updateFindingWorkflowByFingerprint("fp-same", "done", "me"); })).toBe(2);
    const read = (path: string, id: string) => { const db = new osecDB(path); try { return db.getFinding(id); } finally { db.close(); } };
    expect(read(shared, "s1")).toMatchObject({ triageStatus: "accepted", workflowStatus: "done" });
    expect(read(a, "a1")).toMatchObject({ triageStatus: "accepted", workflowAssignee: "me" });
    expect(read(b, "b1")).toMatchObject({ triageStatus: "new" });
    const family = (await svc.list()).families.find(f => f.key === "fp-same")!;
    expect(family.latest.triageStatus).toBe("accepted");
  });

  it("locates a finding or scan in the database that owns it", async () => {
    seed(join(home, "shared.db"), "console-1", "repo", [finding("s1", "low")]);
    const a = seed(runPath("run-a"), "run-a", "x", [finding("a1", "high")]);
    const svc = service();
    expect((await svc.sourceOfFinding("a1"))?.id).toBe(a);
    expect((await svc.sourceOfScan("run-a"))?.id).toBe(a);
    expect(await svc.sourceOfFinding("missing")).toBeUndefined();
  });

  it("caps the number of run databases, newest first", async () => {
    for (const [i, id] of ["old", "mid", "new"].entries()) {
      const path = seed(runPath(id), id, id, [finding(`${id}1`, "high", { fingerprint: `fp-${id}` })]);
      utimesSync(path, new Date(1_700_000_000_000 + i * 1000), new Date(1_700_000_000_000 + i * 1000));
    }
    const merged = await service({ maxDatabases: 2 }).list();
    expect(merged.families.map(f => f.key).sort()).toEqual(["fp-mid", "fp-new"]);
    expect(merged.skippedRuns).toBe(1);
    expect((await service({ maxTotalBytes: 1 }).list()).skippedRuns).toBe(3);
  });

  it("re-reads only databases whose file changed", async () => {
    const a = seed(runPath("run-a"), "run-a", "x", [finding("a1", "high", { fingerprint: "fp-a" })]);
    const svc = service();
    expect((await svc.list()).families).toHaveLength(1);
    const db = new osecDB(a);
    try { db.saveFinding("run-a", finding("a2", "low", { fingerprint: "fp-a2" })); } finally { db.close(); }
    utimesSync(a, new Date(), new Date(Date.now() + 5000));
    expect((await svc.list()).families).toHaveLength(2);
  });

  it("skips an unreadable run database instead of failing the list", async () => {
    mkdirSync(dirname(runPath("broken")), { recursive: true });
    await import("node:fs").then(fs => fs.writeFileSync(runPath("broken"), "not a database"));
    seed(runPath("run-a"), "run-a", "x", [finding("a1", "high")]);
    expect((await service().list()).families).toHaveLength(1);
  });
});

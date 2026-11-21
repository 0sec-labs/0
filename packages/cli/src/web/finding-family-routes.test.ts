import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { osecDB } from "@0/engine/storage";
import type { Finding } from "@0/engine/shared";
import { handleApiRequest } from "./dashboard-api.js";
import { closeSharedDbs } from "./shared-db.js";
import { invalidateReadCache } from "./read-cache.js";
import { closeAuditLog, listAudit } from "@0/engine/storage";
import { configureAudit } from "./audit.js";

const TOKEN = "t".repeat(32);
let home: string; let previousHome: string | undefined; let previousDb: string | undefined;
let server: Server; let base = "";
const finding = (id: string, severity: string, extra: Partial<Finding> = {}): Finding => ({ id, templateId: "t", title: `Finding ${id}`, description: "Issue", severity, category: "xss", status: "confirmed",
  timestamp: 1800000000000, evidence: { request: "src/a.ts:4", response: "evidence", analysis: "ok" }, ...extra } as Finding);
function seed(path: string, scan: string, target: string, findings: Finding[]): string {
  mkdirSync(dirname(path), { recursive: true });
  const db = new osecDB(path);
  try { db.createScan({ target, depth: "deep", format: "json" }, scan); for (const f of findings) db.saveFinding(scan, f); db.completeScan(scan, {} as never); } finally { db.close(); }
  return path;
}
const runDb = (id: string) => join(home, ".0", "runs", id, "state.db");
const call = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", "x-0-control-token": TOKEN } });
const row = (path: string, id: string) => { const db = new osecDB(path); try { return db.getFinding(id); } finally { db.close(); } };

beforeAll(async () => {
  server = createServer((req, res) => { void handleApiRequest(req, res, new URL(req.url ?? "/", "http://x").pathname, undefined, TOKEN).then(handled => { if (!handled) { res.statusCode = 404; res.end("{}"); } }); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  previousHome = process.env.HOME; previousDb = process.env["ZERO_DB_PATH"];
  home = mkdtempSync(join(tmpdir(), "0-findings-routes-")); process.env.HOME = home; process.env["ZERO_DB_PATH"] = join(home, ".0", "0.db");
  invalidateReadCache();
});
afterEach(() => {
  closeSharedDbs(); process.env.HOME = previousHome; if (previousDb === undefined) delete process.env["ZERO_DB_PATH"]; else process.env["ZERO_DB_PATH"] = previousDb; rmSync(home, { recursive: true, force: true });
});

describe("findings API over scan run databases", () => {
  it("lists findings from scan runs and the shared database in one dashboard", async () => {
    const shared = seed(join(home, ".0", "0.db"), "console-1", "repo", [finding("s1", "low", { fingerprint: "fp-shared" })]);
    seed(runDb("run-a"), "run-a", "https://a.example", [finding("a1", "high", { fingerprint: "fp-a" })]);
    const body = await (await call("/api/dashboard")).json() as { groups: Array<{ fingerprint: string; provenance: { kind: string } }>; scans: Array<{ id: string }> };
    expect(body.groups.map(g => g.fingerprint).sort()).toEqual(["fp-a", "fp-shared"]);
    expect(body.groups.find(g => g.fingerprint === "fp-a")!.provenance).toMatchObject({ kind: "scan", target: "https://a.example" });
    expect(body.groups.find(g => g.fingerprint === "fp-shared")!.provenance).toMatchObject({ kind: "thread" });
    expect(body.scans.map(s => s.id).sort()).toEqual(["console-1", "run-a"]);
    expect(row(shared, "s1")).toBeTruthy();
  });

  it("writes a board move and a review decision to the run database that owns the finding", async () => {
    const shared = seed(join(home, ".0", "0.db"), "console-1", "repo", [finding("s1", "low", { fingerprint: "fp-shared" })]);
    const run = seed(runDb("run-a"), "run-a", "https://a.example", [finding("a1", "high", { fingerprint: "fp-a" })]);
    expect((await call("/api/finding-family/fp-a/workflow", { method: "POST", body: JSON.stringify({ workflowStatus: "done", workflowAssignee: "me" }) })).status).toBe(200);
    expect(row(run, "a1")).toMatchObject({ workflowStatus: "done", workflowAssignee: "me" });
    expect(row(shared, "s1")).not.toMatchObject({ workflowStatus: "done" });
    expect((await call("/api/finding-family/fp-a/triage", { method: "POST", body: JSON.stringify({ triageStatus: "suppressed", triageNote: "known" }) })).status).toBe(200);
    expect(row(run, "a1")).toMatchObject({ triageStatus: "suppressed", triageNote: "known" });
    const dashboard = await (await call("/api/dashboard")).json() as { groups: Array<{ fingerprint: string; latest: { triageStatus: string; workflowStatus: string } }> };
    expect(dashboard.groups.find(g => g.fingerprint === "fp-a")!.latest).toMatchObject({ triageStatus: "suppressed" });
  });

  it("keeps the board rules for merged findings", async () => {
    seed(runDb("run-a"), "run-a", "x", [finding("a1", "high", { fingerprint: "fp-a" })]);
    expect((await call("/api/finding-family/fp-a/workflow", { method: "POST", body: JSON.stringify({ workflowStatus: "human_review" }) })).status).toBe(400);
    expect((await call("/api/finding-family/fp-missing/workflow", { method: "POST", body: JSON.stringify({ workflowStatus: "todo" }) })).status).toBe(404);
  });

  it("shows one finding's detail with its source, and a scan's own findings", async () => {
    seed(runDb("run-a"), "run-a", "https://a.example", [finding("a1", "high", { fingerprint: "fp-a" })]);
    const detail = await (await call("/api/finding-family/fp-a")).json() as { latest: { id: string }; provenance: { kind: string; scanId: string }; rows: unknown[] };
    expect(detail.latest.id).toBe("a1");
    expect(detail.provenance).toMatchObject({ kind: "scan", scanId: "run-a" });
    const scan = await (await call("/api/scans/run-a/findings")).json() as { findings: Array<{ id: string }> };
    expect(scan.findings.map(f => f.id)).toEqual(["a1"]);
  });

  it("attributes a triage decision to the authenticated team member, not a shared identity", async () => {
    seed(runDb("run-a"), "run-a", "https://a.example", [finding("a1", "high", { fingerprint: "fp-a" })]);
    const auditPath = join(home, "audit.db"); configureAudit(auditPath);
    try {
      const member = createServer((req, res) => { void handleApiRequest(req, res, new URL(req.url ?? "/", "http://x").pathname, undefined, TOKEN, undefined, undefined, { engineRequest: false, teamEnabled: true, displayName: "Ada Reviewer", userId: "ada" }).then(() => undefined); });
      await new Promise<void>(done => member.listen(0, "127.0.0.1", done));
      const url = `http://127.0.0.1:${(member.address() as { port: number }).port}`;
      const response = await fetch(`${url}/api/finding-family/fp-a/triage`, { method: "POST", headers: { "content-type": "application/json", "x-0-control-token": TOKEN }, body: JSON.stringify({ triageStatus: "suppressed" }) });
      expect(response.status).toBe(200);
      member.close();
      const [event] = listAudit({}, { dbPath: auditPath }).events;
      expect(event).toMatchObject({ actor: "operator Ada Reviewer (browser)", action: "finding.triage", subject: "fp-a", detail: { decision: "suppressed", id: "ada" } });
    } finally { configureAudit(null); closeAuditLog(); }
  });
});

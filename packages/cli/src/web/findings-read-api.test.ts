import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { osecDB } from "@0/db";
import type { Finding } from "@0/shared";
import { FindingsReadApi, handleFindingsReadRequest } from "./findings-read-api.js";
let directory: string, dbPath: string, api: FindingsReadApi;
function finding(id: string, timestamp = 100, severity: Finding["severity"] = "high"): Finding { return { id, templateId: "fixture", title: id, description: "Retained finding", severity, category: "path-traversal", status: "discovered", timestamp, evidence: { request: "GET /account", response: "Retained response" } }; }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "0-findings-read-")); dbPath = join(directory, "findings.db");
  const db = new osecDB(dbPath);
  try {
    db.createScan({ target: "workspace-repo", depth: "quick", format: "json" }, "scan-a");
    db.createScan({ target: "other-target", depth: "quick", format: "json" }, "scan-b");
    for (const id of ["a", "b", "c"]) db.saveFinding("scan-a", finding(id));
    db.saveFinding("scan-b", finding("older", 99, "low"));
    db.saveFinding("scan-a", { ...finding("suppressed", 101), triageStatus: "suppressed" });
  } finally { db.close(); }
  api = new FindingsReadApi({ workspaceId: "workspace-a", dbPath });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
it("paginates tied timestamps deterministically without repeating rows and preserves evidence provenance", () => {
  const first = api.list(new URLSearchParams({ limit: "2" }));
  expect(first.findings.map(item => item.finding.id)).toEqual(["c", "b"]);
  expect(first.page).toMatchObject({ limit: 2, hasMore: true });
  expect(first.findings[0]).toMatchObject({ scanId: "scan-a", target: "workspace-repo", finding: { evidence: { response: "Retained response" } } });
  const second = api.list(new URLSearchParams({ limit: "2", cursor: first.page.nextCursor! }));
  expect(second.findings.map(item => item.finding.id)).toEqual(["a", "older"]);
  expect(second.page).toEqual({ limit: 2, hasMore: false, nextCursor: null });
});
it("binds cursors to workspace, database and filters, validates limits and exact query parameters", () => {
  const first = api.list(new URLSearchParams({ limit: "1", scanId: "scan-a" }));
  expect(() => api.list(new URLSearchParams({ cursor: first.page.nextCursor!, scanId: "scan-b" }))).toThrow("Cursor does not match");
  expect(() => new FindingsReadApi({ workspaceId: "another", dbPath }).list(new URLSearchParams({ cursor: first.page.nextCursor!, scanId: "scan-a" }))).toThrow("Cursor does not match");
  expect(() => new FindingsReadApi({ workspaceId: "workspace-a", dbPath: join(directory, "another-engine.db") }).list(new URLSearchParams({ cursor: first.page.nextCursor!, scanId: "scan-a" }))).toThrow("Cursor does not match");
  expect(() => api.list(new URLSearchParams({ cursor: "broken" }))).toThrow("Cursor");
  expect(() => api.list(new URLSearchParams({ limit: "101" }))).toThrow("limit");
  expect(() => api.list(new URLSearchParams("limit=1&limit=2"))).toThrow("Repeated");
  expect(() => api.list(new URLSearchParams({ token: "secret" }))).toThrow("Use limit");
  expect(api.list(new URLSearchParams({ includeSuppressed: "true", severity: "high" })).findings.map(item => item.finding.id)).toEqual(["suppressed", "c", "b", "a"]);
});
it("looks up exact finding IDs in one engine and exports only selected retained evidence", () => {
  expect(api.detail("a")).toMatchObject({ workspaceId: "workspace-a", scanId: "scan-a", finding: { id: "a" } });
  expect(() => api.detail("missing")).toThrow("Finding not found");
  const selected = api.export(new URLSearchParams("id=a&id=older"));
  expect(selected.coverage).toBe("selected-retained-findings");
  expect(selected.report.findings.map(item => item.id)).toEqual(["a", "older"]);
  expect(selected.report.warnings?.[0]?.message).toContain("not a complete assessment");
  expect(() => api.export(new URLSearchParams("id=a&id=a"))).toThrow("distinct");
  expect(() => api.export(new URLSearchParams("id=missing"))).toThrow("not found");
  expect(() => api.export(new URLSearchParams("id=a&token=secret"))).toThrow("repeated id");
});
it("admits only GET/HEAD contract routes and rejects mutations and non-finding routes", () => {
  const url = new URL("http://localhost/api/v1/findings?limit=1");
  expect(handleFindingsReadRequest({ method: "HEAD" }, url, api)?.status).toBe(200);
  expect(() => handleFindingsReadRequest({ method: "POST" }, url, api)).toThrow("read-only");
  expect(handleFindingsReadRequest({ method: "GET" }, new URL("http://localhost/api/dashboard"), api)).toBeUndefined();
  expect(() => handleFindingsReadRequest({ method: "GET" }, new URL("http://localhost/api/v1/findings/a?token=secret"), api)).toThrow("does not accept");
});

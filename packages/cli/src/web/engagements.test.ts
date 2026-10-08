import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { osecDB } from "@0/db";
import type { Finding } from "@0/shared";
import { EngagementStore, assembleEngagementReport } from "./engagements.js";

let directory: string;
let workspace: string;
let dbPath: string;
let store: EngagementStore;
function finding(id: string, fingerprint?: string, status: Finding["status"] = "discovered"): Finding {
  return { id, templateId: "test", title: id, description: "Retained finding", severity: "high", category: "path-traversal", status, timestamp: 1800000000000, ...(fingerprint ? { fingerprint } : {}), evidence: { request: "src/a.ts:1", response: "Retained evidence" } };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "0-engagements-")); workspace = join(directory, "workspace"); mkdirSync(workspace);
  dbPath = join(directory, "engine.db");
  const db = new osecDB(dbPath);
  try {
    db.createScan({ target: "repo-a", depth: "quick", format: "json" }, "scan-a");
    db.createScan({ target: "repo-b", depth: "quick", format: "json" }, "scan-b");
    db.createScan({ target: "unselected", depth: "quick", format: "json" }, "scan-other");
    db.saveFinding("scan-a", finding("a", "shared", "verified"));
    db.saveFinding("scan-b", finding("b", "shared", "false-positive"));
    db.saveFinding("scan-b", finding("c", "distinct", "verified"));
    db.saveFinding("scan-other", finding("excluded", "other", "verified"));
  } finally { db.close(); }
  store = new EngagementStore({ workspace, stateDir: directory, dbPath });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("operator-local engagements", () => {
  it("attributes server identity and rejects stale edits without losing the first save", () => {
    const alice = { userId: "alice", displayName: "Alice" };
    const bob = { userId: "bob", displayName: "Bob" };
    const initial = store.create({ name: "Shared report" }, alice);
    const other = new EngagementStore({ workspace, stateDir: directory, dbPath });
    expect(initial).toMatchObject({ revision: 1, createdBy: alice, updatedBy: alice });
    const saved = other.update(initial.id, { notes: "Reviewed evidence", expectedRevision: initial.revision }, bob);
    expect(saved).toMatchObject({ revision: 2, createdBy: alice, updatedBy: bob });
    expect(() => store.update(initial.id, { notes: "Stale notes", expectedRevision: 1 }, alice)).toThrow("Report changed");
    expect(store.get(initial.id)).toEqual(saved);
    expect(() => store.update(initial.id, { notes: "Unversioned edit" }, alice)).toThrow("latest report");
    expect(store.report(initial.id).engagement.updatedBy).toEqual(bob);
  });
  it("never accepts identity metadata from request bodies and migrates legacy revisions", () => {
    const actor = { userId: "server-user", displayName: "Server user" };
    expect(() => store.create({ name: "Forged", createdBy: actor })).toThrow();
    const initial = store.create({ name: "Legacy" });
    expect(() => store.update(initial.id, { expectedRevision: 1, updatedBy: actor })).toThrow();
    const path = join(directory, "engagements", readdirSync(join(directory, "engagements"))[0]!);
    const state = JSON.parse(readFileSync(path, "utf8")); delete state.engagements[0].revision;
    writeFileSync(path, JSON.stringify(state));
    expect(store.get(initial.id).revision).toBe(1);
    expect(store.update(initial.id, { notes: "Local compatible" }).revision).toBe(2);
    expect(store.get(initial.id).updatedBy).toBeUndefined();
  });
  it("does not write through another process lock", () => {
    const initial = store.create({ name: "Shared" });
    const path = join(directory, "engagements", readdirSync(join(directory, "engagements"))[0]!);
    writeFileSync(`${path}.lock`, String(process.pid), { mode: 0o600 });
    expect(() => store.update(initial.id, { name: "Overwrite", expectedRevision: initial.revision })).toThrow("Another report edit");
    expect(store.get(initial.id)).toEqual(initial);
    expect(readdirSync(join(directory, "engagements"))).not.toContain(`${path.split("/").at(-1)}.lock.recovery`);
  });
  it("persists named records privately and updates only allowed fields", () => {
    expect(store.list()).toEqual([]);
    const row = store.create({ name: " Review ", description: "Scope", scanIds: ["scan-a"], notes: "Internal note" });
    expect(row.name).toBe("Review");
    expect(row.id).toMatch(/^[a-f0-9-]{36}$/);
    const reopened = new EngagementStore({ workspace, stateDir: directory, dbPath });
    expect(reopened.get(row.id)).toEqual(row);
    expect(reopened.update(row.id, { name: "Renamed", scanIds: ["scan-b"] })).toMatchObject({ id: row.id, name: "Renamed", createdAt: row.createdAt, scanIds: ["scan-b"] });
    expect(() => reopened.update(row.id, { id: "forged" })).toThrow();
    const path = join(directory, "engagements", readdirSync(join(directory, "engagements"))[0]!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(directory, "engagements"))).toHaveLength(1);
  });
  it("isolates canonical workspaces while allowing a symlink alias of the same workspace", () => {
    const row = store.create({ name: "Private" });
    const other = join(directory, "other"); mkdirSync(other);
    const otherStore = new EngagementStore({ workspace: other, stateDir: directory, dbPath });
    expect(otherStore.list()).toEqual([]);
    expect(() => otherStore.get(row.id)).toThrow("not found in this workspace");
    const alias = join(directory, "alias"); symlinkSync(workspace, alias);
    expect(new EngagementStore({ workspace: alias, stateDir: directory, dbPath }).get(row.id)).toEqual(row);
  });
  it("rejects missing scans, duplicate selections, invalid and overlong inputs", () => {
    expect(() => store.create({ name: "" })).toThrow();
    expect(() => store.create({ name: "A", scanIds: ["missing"] })).toThrow("Selected scan was not found");
    expect(() => store.create({ name: "A", scanIds: ["scan-a", "scan-a"] })).toThrow("unique");
    expect(() => store.create({ name: "A", notes: "x".repeat(16001) })).toThrow();
    expect(() => store.create({ name: "A", workspace: "/elsewhere" })).toThrow();
    const row = store.create({ name: "A", scanIds: ["scan-a"] });
    expect(() => store.update(row.id, { scanIds: ["missing"] })).toThrow();
    expect(store.get(row.id).scanIds).toEqual(["scan-a"]);
  });
  it("rejects corrupted storage instead of silently replacing it", () => {
    store.create({ name: "A" });
    const path = join(directory, "engagements", readdirSync(join(directory, "engagements"))[0]!);
    const state = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...state, workspace: "/foreign" }));
    expect(() => store.list()).toThrow("Invalid engagement storage");
    writeFileSync(path, "{broken");
    expect(() => store.create({ name: "B" })).toThrow("Invalid engagement storage");
  });
  it("assembles selected evidence with fingerprint provenance and conservative review counts", () => {
    const row = store.create({ name: "Assessment", scanIds: ["scan-b", "scan-a"] });
    const report = store.report(row.id);
    expect(report.coverage.scanIds).toEqual(["scan-b", "scan-a"]);
    expect(report.scans.map(scan => scan.target)).toEqual(["repo-b", "repo-a"]);
    expect(report.summary).toEqual({ scanCount: 2, findingCount: 3, uniqueFindingCount: 2, verified: 1, rejected: 0, unreviewed: 1 });
    const shared = report.findingGroups.find(group => group.fingerprint === "shared")!;
    expect(shared.occurrences.map(item => item.scanId)).toEqual(["scan-b", "scan-a"]);
    expect(shared.occurrences[0]!.finding.evidence.response).toBe("Retained evidence");
    expect(JSON.stringify(report)).not.toContain("excluded");
    expect(report.scans.every(scan => scan.exitReason === "partial")).toBe(true);
    expect(report.summary).not.toHaveProperty("costUsd");
  });
  it("supports empty collections without inventing assessment coverage", () => {
    const row = store.create({ name: "Draft" });
    expect(store.report(row.id).summary).toEqual({ scanCount: 0, findingCount: 0, uniqueFindingCount: 0, verified: 0, rejected: 0, unreviewed: 0 });
    expect(() => assembleEngagementReport(row, [{ scan: { id: "foreign", target: "foreign", status: "completed", startedAt: "", completedAt: null, durationMs: null }, report: {} as never }])).toThrow("exactly");
    expect(() => assembleEngagementReport({ ...row, scanIds: ["missing"] }, [])).toThrow("exactly");
  });
  it("preserves retained failure metadata alongside findings without inventing successful execution", () => {
    const db = new osecDB(dbPath);
    try { db.failScan("scan-a", "Provider connection failed"); }
    finally { db.close(); }
    const row = store.create({ name: "Partial review", scanIds: ["scan-a"] });
    const report = store.report(row.id);
    expect(report.scans[0]).toMatchObject({ status: "failed", executionSuccessful: false, exitReason: "partial", error: "Provider connection failed" });
    expect(report.summary.findingCount).toBe(1);
    expect(report.findingGroups[0]?.occurrences[0]?.finding.evidence.response).toBe("Retained evidence");
    expect(JSON.parse(JSON.stringify(report)).scans[0].error).toBe("Provider connection failed");
  });
  it("does not infer verification from confirmation", () => {
    const db = new osecDB(dbPath);
    try {
      db.saveFinding("scan-a", finding("unreviewed", undefined, "confirmed"));
      db.saveFinding("scan-b", finding("rejected", undefined, "false-positive"));
    } finally { db.close(); }
    const row = store.create({ name: "Review", scanIds: ["scan-a", "scan-b"] });
    const report = store.report(row.id);
    expect(report.summary).toMatchObject({ findingCount: 5, uniqueFindingCount: 4, verified: 1, rejected: 1, unreviewed: 2 });
    expect(report.findingGroups.find(group => group.occurrences.some(item => item.findingId === "unreviewed"))?.reviewStatus).toBe("unreviewed");
    expect(report.findingGroups.find(group => group.occurrences.some(item => item.findingId === "rejected"))?.reviewStatus).toBe("rejected");
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProjectReviewChecks, parseReviewCheckResults, reviewChecksFilePath, snapshotProjectReviewChecks, updateProjectReviewChecks, type ReviewCheck } from "./review-checks.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string { const root = mkdtempSync(join(tmpdir(), "zero-review-checks-")); roots.push(root); return root; }
const checks: ReviewCheck[] = [
  { id: "tenant", name: "Tenant isolation", prompt: "Check tenant isolation", revision: 1 },
  { id: "auth", name: "Authorization", prompt: "Check authorization", revision: 1 },
];
const rows = [
  { id: "tenant", status: "issue", reason: "Query omits the authenticated tenant.", fix: "Bind the tenant in the query predicate." },
  { id: "auth", status: "unknown", reason: "Deployment authentication configuration is unavailable.", fix: "" },
];

describe("local review check approval and revision boundaries", () => {
  it("does not run drafts, does not silently approve active edits, and refuses stale revisions", () => {
    const project = directory();
    const home = directory();
    const draft = updateProjectReviewChecks(project, { action: "propose", name: "Isolation", prompt: "---\nCheck isolation" }, home).checks[0]!;
    expect(snapshotProjectReviewChecks(project, home)).toEqual([]);
    updateProjectReviewChecks(project, { action: "enable", id: draft.id, approved: true, expectedRevision: 1 }, home);
    expect(snapshotProjectReviewChecks(project, home)[0]?.prompt).toBe("---\nCheck isolation");
    expect(() => updateProjectReviewChecks(project, { action: "set", id: draft.id, prompt: "Check both tenant and role" }, home)).toThrow();
    expect(snapshotProjectReviewChecks(project, home)[0]?.revision).toBe(1);
    updateProjectReviewChecks(project, { action: "set", id: draft.id, prompt: "Check both tenant and role", approved: true, expectedRevision: 1 }, home);
    expect(() => updateProjectReviewChecks(project, { action: "set", id: draft.id, prompt: "Stale update", approved: true, expectedRevision: 1 }, home)).toThrow();
    expect(snapshotProjectReviewChecks(project, home)[0]).toMatchObject({ prompt: "Check both tenant and role", revision: 2 });
    updateProjectReviewChecks(project, { action: "disable", id: draft.id }, home);
    expect(snapshotProjectReviewChecks(project, home)).toEqual([]);
    expect(listProjectReviewChecks(project, home).checks[0]).toMatchObject({ revision: 2, enabled: false });
    updateProjectReviewChecks(project, { action: "remove", id: draft.id }, home);
    expect(listProjectReviewChecks(project, home).checks).toEqual([]);
  });

  it("rejects over-budget enabling without losing other approvals, and never hides a corrupt store", () => {
    const project = directory();
    const home = directory();
    for (let i = 0; i < 8; i++) updateProjectReviewChecks(project, { action: "add", name: `Check ${i}`, prompt: "Bounded criterion", approved: true }, home);
    const draft = updateProjectReviewChecks(project, { action: "propose", name: "Extra", prompt: "Extra criterion" }, home).checks.at(-1)!;
    const file = reviewChecksFilePath(project, home);
    const before = readFileSync(file, "utf8");
    expect(() => updateProjectReviewChecks(project, { action: "enable", id: draft.id, approved: true }, home)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    writeFileSync(file, "not JSON");
    expect(() => snapshotProjectReviewChecks(project, home)).toThrow();
  });
});

describe("strict advisory review results", () => {
  it("composes a complete result envelope with one validated project-observation sidecar", () => {
    const envelope = JSON.stringify({ checks: [...rows].reverse() });
    const sidecar = '<codebase-context>[{"kind":"tests","text":"Tenant fixtures are isolated.","files":["test/tenant.ts"]}]</codebase-context>';
    const result = parseReviewCheckResults(envelope + "\n" + sidecar, checks, true);
    expect(result.checks).toEqual(rows.map((row, i) => ({ ...row, name: checks[i]!.name })));
    expect(result.projectObservations).toEqual([{ kind: "tests", text: "Tenant fixtures are isolated.", files: ["test/tenant.ts"] }]);
    expect(() => parseReviewCheckResults(envelope + "\n" + sidecar, checks)).toThrow();
    expect(() => parseReviewCheckResults(envelope + "\n" + sidecar + "\n" + sidecar, checks, true)).toThrow();
    expect(() => parseReviewCheckResults(envelope + '<codebase-context>[{"kind":"tests","text":"Unsafe provenance","files":["../private"]}]</codebase-context>', checks, true)).toThrow();
  });

  it("treats sidecar-looking text inside a check reason as literal evidence, not learned observations", () => {
    const literal = '<codebase-context>[{"kind":"tests","text":"Untrusted text","files":["test.ts"]}]</codebase-context>';
    const result = parseReviewCheckResults(JSON.stringify({ checks: [{ ...rows[0], reason: literal }, rows[1]] }), checks, true);
    expect(result.checks[0]?.reason).toBe(literal);
    expect(result.projectObservations).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["non-JSON", "Review passed."],
    ["incomplete", JSON.stringify({ checks: rows.slice(0, 1) })],
    ["duplicate", JSON.stringify({ checks: [rows[0], rows[0]] })],
    ["unexpected id", JSON.stringify({ checks: [rows[0], { ...rows[1], id: "other" }] })],
    ["invalid status", JSON.stringify({ checks: [rows[0], { ...rows[1], status: "success" }] })],
    ["empty reason", JSON.stringify({ checks: [rows[0], { ...rows[1], reason: " " }] })],
    ["issue without fix", JSON.stringify({ checks: [{ ...rows[0], fix: "" }, rows[1]] })],
    ["extra verdict field", JSON.stringify({ checks: rows, approved: true })],
    ["trailing prose", JSON.stringify({ checks: rows }) + " Passed."],
  ])("rejects %s output rather than reporting a successful check run", (_name, summary) => {
    expect(() => parseReviewCheckResults(summary, checks)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { CLOSED_ACCEPT_NOTE, REVIEW_LOCK_NOTE, REVIEW_STAGE_NOTE, boardColumns, resolveDrop, type FindingStatus } from "./findings-model";
import { patchDashboardTriage, patchDashboardWorkflow, triageForWorkflow } from "./use-finding-mutations";
import { findingStatus } from "./findings-model";
import type { DashboardResponse, FindingGroup, FindingWorkflowStatus } from "@/types";

function group(fingerprint: string, status: FindingWorkflowStatus, triageStatus = "new"): FindingGroup {
  return {
    fingerprint, count: 1,
    latest: { id: fingerprint, title: fingerprint, severity: "high", status: "discovered", triageStatus, workflowStatus: status, timestamp: 1 },
    workflow: { status, persistedStatus: status, recommendedStatus: status, phase: status, assignee: null, updatedAt: "2026-01-01T00:00:00.000Z" },
  } as unknown as FindingGroup;
}
const dashboard = (...groups: FindingGroup[]) => ({ groups }) as unknown as DashboardResponse;

describe("board drop rules", () => {
  it("moves between people-settable columns", () => {
    for (const target of ["backlog", "todo", "in_progress", "blocked", "done", "cancelled"] as const) {
      expect(resolveDrop(target === "todo" ? "backlog" : "todo", target)).toEqual({ ok: true, kind: "workflow", status: target });
    }
  });
  it("treats Accepted as a review decision, not a status write", () => {
    expect(resolveDrop("in_progress", "accepted")).toEqual({ ok: true, kind: "triage", status: "accepted" });
    expect(resolveDrop("human_review", "accepted")).toMatchObject({ ok: true, kind: "triage" });
    expect(resolveDrop("done", "accepted")).toEqual({ ok: false, reason: CLOSED_ACCEPT_NOTE });
  });
  it("refuses engine-owned review stages with a reason", () => {
    expect(resolveDrop("todo", "agent_review")).toEqual({ ok: false, reason: REVIEW_STAGE_NOTE });
    expect(resolveDrop("todo", "human_review")).toEqual({ ok: false, reason: REVIEW_STAGE_NOTE });
  });
  it("lets a finding that needs review only be closed", () => {
    expect(resolveDrop("human_review", "todo")).toEqual({ ok: false, reason: REVIEW_LOCK_NOTE });
    expect(resolveDrop("human_review", "done")).toMatchObject({ ok: true });
    expect(resolveDrop("human_review", "cancelled")).toMatchObject({ ok: true });
  });
  it("ignores a drop on the same column silently", () => {
    expect(resolveDrop("todo", "todo")).toEqual({ ok: false, reason: null });
  });
  it("keeps every board column a drop target so refusals can be shown", () => {
    const targets: FindingStatus[] = boardColumns([], "severity", "desc").map(column => column.status);
    expect(targets).toContain("human_review");
    expect(targets).toContain("accepted");
  });
});

describe("optimistic board moves", () => {
  it("moves a dismissed card out of Cancelled and an accepted card out of Accepted at once", () => {
    const next = patchDashboardWorkflow(dashboard(group("a", "backlog", "suppressed"), group("b", "backlog", "accepted")), { fingerprint: "a", workflowStatus: "todo", workflowAssignee: "", optimisticStatus: "todo" });
    expect(findingStatus(next.groups[0]!)).toBe("todo");
    const second = patchDashboardWorkflow(next, { fingerprint: "b", workflowStatus: "in_progress", workflowAssignee: "", optimisticStatus: "in_progress" });
    expect(findingStatus(second.groups[1]!)).toBe("in_progress");
  });
  it("mirrors the API's triage side effects", () => {
    expect(triageForWorkflow("done")).toBe("accepted");
    expect(triageForWorkflow("cancelled")).toBe("suppressed");
    expect(triageForWorkflow("blocked")).toBe("new");
    const done = patchDashboardWorkflow(dashboard(group("a", "todo")), { fingerprint: "a", workflowStatus: "done", workflowAssignee: "" });
    expect(findingStatus(done.groups[0]!)).toBe("done");
  });
  it("shows an accepted risk in Accepted straight away, and leaves other cards alone", () => {
    const before = dashboard(group("a", "todo"), group("b", "todo"));
    const after = patchDashboardTriage(before, { fingerprint: "a", triageStatus: "accepted", triageNote: "" });
    expect(findingStatus(after.groups[0]!)).toBe("accepted");
    expect(after.groups[1]).toBe(before.groups[1]);
    expect(findingStatus(before.groups[0]!)).toBe("todo");
  });
});

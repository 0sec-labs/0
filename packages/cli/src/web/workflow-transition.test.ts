import { describe, expect, it } from "vitest";
import { workflowTransitionRejection } from "./dashboard-api.js";

describe("finding workflow transitions over the API", () => {
  it("accepts every people-settable status", () => {
    for (const status of ["backlog", "todo", "in_progress", "blocked", "done", "cancelled"]) expect(workflowTransitionRejection(status, "backlog")).toBeNull();
  });
  it("rejects unknown, missing and engine-owned statuses instead of storing backlog", () => {
    expect(workflowTransitionRejection("nonsense", "todo")).toMatchObject({ status: 400 });
    expect(workflowTransitionRejection(undefined, "todo")).toMatchObject({ status: 400 });
    expect(workflowTransitionRejection("accepted", "todo")).toMatchObject({ status: 400 });
    expect(workflowTransitionRejection("human_review", "todo")?.error).toMatch(/set by 0/);
    expect(workflowTransitionRejection("agent_review", "todo")?.status).toBe(400);
  });
  it("lets a finding waiting for review only be closed", () => {
    expect(workflowTransitionRejection("todo", "human_review")).toMatchObject({ status: 409 });
    expect(workflowTransitionRejection("in_progress", "human_review")).toMatchObject({ status: 409 });
    expect(workflowTransitionRejection("done", "human_review")).toBeNull();
    expect(workflowTransitionRejection("cancelled", "human_review")).toBeNull();
  });
});

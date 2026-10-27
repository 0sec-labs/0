import { expect, test, vi } from "vitest";
import type { SecurityWorkflowNode } from "@0/shared";
vi.mock("@/components/ui/choice-card", () => ({ ChoiceCard: () => null }));
vi.mock("@/lib/utils", () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(" ") }));
import { workflowSequence, workflowStepDetails } from "../../../dashboard/src/components/workflow-graph";
const node = (id: string, type: SecurityWorkflowNode["type"] = "audit"): SecurityWorkflowNode => ({ id, type, label: id, enabled: true });

test("orders the vertical sequence by dependencies while keeping branch siblings stable", () => {
  const definition = { nodes: [node("report", "report"), node("b"), node("start", "trigger"), node("a")], edges: [{ source: "start", target: "a" }, { source: "start", target: "b" }, { source: "a", target: "report" }, { source: "b", target: "report" }] };
  expect(workflowSequence(definition).map(step => step.id)).toEqual(["start", "b", "a", "report"]);
});
test("retains disconnected/disabled nodes and safely bounds cyclic saved definitions", () => {
  const disabled = { ...node("disabled"), enabled: false };
  const definition = { nodes: [node("a"), disabled, node("b")], edges: [{ source: "a", target: "b" }, { source: "b", target: "a" }, { source: "missing", target: "disabled" }] };
  expect(workflowSequence(definition).map(step => step.id)).toEqual(["disabled", "a", "b"]);
  expect(workflowSequence(definition)[0]?.enabled).toBe(false);
});
test("shows saved budget, exact sub-minute time and explicit no-tool restrictions", () => {
  const details = workflowStepDetails({ ...node("review"), plan: { goal: "known-vulnerabilities", depth: "deep", runCount: 2, executionMode: "parallel", timeCapMs: 1500, costCapUsd: 3 }, execution: { instructions: "Review authentication", allowedAgentTools: [] } });
  expect(details).toEqual(["known vulnerabilities · deep · 2 parallel runs", "Limits: 1.5 sec · $3", "Tools: no agent tool calls"]);
});
test("does not invent schedule cadence or apply permission absent from the saved definition", () => {
  expect(workflowStepDetails(node("trigger", "trigger"))).toEqual(["Starts manually; schedules are managed in Triggers."]);
  expect(workflowStepDetails({ ...node("fix", "fix"), fix: { mode: "apply" } })).toContain("Apply changes; separate permission is required.");
  expect(workflowStepDetails(node("fix", "fix"))).toContain("Prepare a fix candidate only.");
  expect(workflowStepDetails(node("audit"))).toContain("Tools: default set");
});

import { expect, test } from "vitest";
import type { RunRecord } from "@0/shared";
import { filterRuns, selectRun } from "../../../dashboard/src/lib/runs";

const workflow: RunRecord = { id: "workflow:w1", kind: "workflow", title: "Review API", target: "https://api.test", status: "running", createdAt: "2026-01-01", updatedAt: "2026-01-01", conversation: { sessionId: "chat-1" }, native: { workflowExecutionId: "w1", workflowId: "definition-1", scanIds: ["scan-a", "scan-b"] } };
const standalone: RunRecord = { ...workflow, id: "scan:standalone", kind: "scan", title: "Binary review", target: "/target.bin", conversation: null, native: { scanIds: ["standalone"] } };

test("canonical and legacy scan links resolve the owning run without treating conversations as runs", () => {
  const runs = [workflow, standalone];
  expect(selectRun(runs, "workflow:w1")).toBe(workflow);
  expect(selectRun(runs, "scan-b")).toBe(workflow);
  expect(selectRun(runs, "standalone")).toBe(standalone);
  expect(selectRun(runs, "chat-1")).toBeUndefined();
  expect(selectRun(runs, "missing", workflow.id)).toBeUndefined();
  expect(selectRun(runs, undefined, standalone.id)).toBe(standalone);
});

test("run search combines target, kind and status without changing retained records", () => {
  const runs = [workflow, standalone];
  expect(filterRuns(runs, " API RUNNING workflow ")).toEqual([workflow]);
  expect(filterRuns(runs, "binary completed")).toEqual([]);
  expect(filterRuns(runs, "")).toEqual(runs);
  expect(runs).toEqual([workflow, standalone]);
});

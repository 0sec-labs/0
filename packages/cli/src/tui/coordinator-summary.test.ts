import { describe, expect, it } from "vitest";
import type { SubagentLifecyclePayload, TodosEventPayload } from "@0sec/core";
import { buildCoordinatorSummary, COORDINATOR_SUMMARY_ROWS } from "./coordinator-summary.js";

const plan = (overrides: Partial<TodosEventPayload> = {}): TodosEventPayload => ({
  scan_id: "root",
  todos: [
    { id: "a", content: "Find the pages", status: "completed" },
    { id: "b", content: "Check private data", status: "in_progress" },
    { id: "c", content: "Write the report", status: "pending" },
  ],
  done: 1,
  total: 3,
  line: "Todos · 1/3",
  revision: 1,
  ...overrides,
});

const child = (overrides: Partial<SubagentLifecyclePayload> = {}): SubagentLifecyclePayload => ({
  agent_id: "lead-a",
  parent_scan_id: "root",
  name: "QuietLead",
  status: "running",
  task: "Check who can see private data.",
  max_turns: 8,
  ...overrides,
});


describe("buildCoordinatorSummary", () => {
  it("uses root TODOs for counts and direct lifecycle records for plain-language rows", () => {
    const summary = buildCoordinatorSummary({
      rootPlan: plan(),
      rootScanId: "root",
      objective: "Checking your app",
      directChildren: [
        child(),
        child({ agent_id: "nested", parent_scan_id: "lead-a", task: "Nested noisy work" }),
        child({ agent_id: "done", status: "completed", summary: "Found the pages and checked sign-in." }),
      ],
    });

    expect(summary.completed).toBe(1);
    expect(summary.total).toBe(3);
    expect(summary.remaining).toBe(2);
    expect(summary.lines[0]).toBe("Overall: Checking your app");
    expect(summary.lines[1]).toContain("1 of 3 main tasks done");
    expect(summary.lines[2]).toContain("Found the pages and checked sign-in");
    expect(summary.lines[3]).toContain("Check who can see private data");
    expect(summary.lines.join(" ")).not.toContain("Nested noisy work");
    expect(summary.rows).toBe(COORDINATOR_SUMMARY_ROWS);
  });

  it("keeps failed direct leads unresolved and names the operator action", () => {
    const summary = buildCoordinatorSummary({
      rootPlan: plan(),
      rootScanId: "root",
      directChildren: [child({ status: "failed", error: "Could not check private data." })],
    });

    expect(summary.state).toBe("needs-attention");
    expect(summary.completed).toBe(1);
    expect(summary.lines[5]).toContain("Could not check private data");
  });

  it("makes both missing-input fallbacks explicit", () => {
    const noPlan = buildCoordinatorSummary();
    expect(noPlan.state).toBe("planning");
    expect(noPlan.lines[1]).toContain("count is not known");
    expect(noPlan.lines[2]).toContain("plan is not available");

    const noChild = buildCoordinatorSummary({ rootPlan: plan(), rootScanId: "root" });
    expect(noChild.hasDirectChildren).toBe(false);
    expect(noChild.lines[3]).toContain("No direct main-task lead is reporting");
  });

  it("deduplicates repeated lifecycle records by child id", () => {
    const summary = buildCoordinatorSummary({
      rootPlan: plan(),
      rootScanId: "root",
      directChildren: [
        child({ status: "running", task: "Old report" }),
        child({ status: "completed", summary: "Finished the check." }),
      ],
    });

    expect(summary.lines[3]).toContain("No direct main-task lead is active");
    expect(summary.lines[2]).toContain("Finished the check");
  });
});

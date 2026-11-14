import { expect, test } from "vitest";
import type { SecurityWorkflow } from "@0/engine/shared";
import { SECURITY_WORKFLOW_TEMPLATES } from "@0/engine/dist/shared/security-workflow-templates.js";
import { parseSecurityWorkflowInput } from "@0/engine/dist/shared/security-workflows.js";
import {
  automationFromPrompt, automationRows, blankAutomationInput, duplicateName, filterAutomationRows, filterTemplates, formatDuration, relativeAge, relativeUntil,
  scheduleSummaryLabel, sortAutomationRows, triggerSummaryLabel, validateAutomationDraft, type ExecutionSummary, type ScheduleSummary,
} from "../src/components/automations/automation-model";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const definition = (id: string, name: string, updatedAt = "2026-03-01T00:00:00Z"): SecurityWorkflow => ({ ...blankAutomationInput({ name, target: `/repo/${id}` }), id, revision: 1, createdAt: updatedAt, updatedAt });
const schedule = (over: Partial<ScheduleSummary> = {}): ScheduleSummary => ({ id: "t1", workflowId: "a", workflowRevision: 1, enabled: true, cadence: "daily", startAt: "2026-03-10T09:00:00Z", nextFireAt: "2026-03-11T09:00:00Z", timezone: "UTC", ...over });
const execution = (id: string, workflowId: string, createdAt: string, status: ExecutionSummary["status"] = "completed", updatedAt = createdAt): ExecutionSummary => ({ id, workflowId, status, createdAt, updatedAt });

test("schedule summaries read like Capy: cadence, wall-clock time and zone", () => {
  expect(scheduleSummaryLabel(schedule())).toBe("Daily 09:00 UTC");
  expect(scheduleSummaryLabel(schedule({ cadence: "weekly" }))).toBe("Weekly Tue 09:00 UTC");
  expect(scheduleSummaryLabel(schedule({ cadence: "hourly", startAt: "2026-03-10T09:30:00Z" }))).toBe("Hourly at :30");
  expect(scheduleSummaryLabel(schedule({ timezone: "America/New_York" }))).toBe("Daily 05:00 America/New_York");
  expect(scheduleSummaryLabel(schedule({ startAt: "nope", nextFireAt: "nope" }))).toBe("Daily");
});

test("trigger summary distinguishes manual, active, paused and many schedules", () => {
  expect(triggerSummaryLabel([])).toBe("Manual");
  expect(triggerSummaryLabel([schedule()])).toBe("Daily 09:00 UTC");
  expect(triggerSummaryLabel([schedule({ enabled: false })])).toBe("Daily 09:00 UTC (paused)");
  expect(triggerSummaryLabel([schedule(), schedule({ id: "t2", cadence: "hourly" })])).toBe("2 schedules");
  expect(triggerSummaryLabel([schedule({ enabled: false }), schedule({ id: "t2", cadence: "hourly", startAt: "2026-03-10T09:15:00Z" })])).toBe("Hourly at :15");
});

test("relative time helpers", () => {
  expect(relativeAge(undefined, NOW)).toBe("Never");
  expect(relativeAge("2026-03-10T11:59:40Z", NOW)).toBe("just now");
  expect(relativeAge("2026-03-10T11:15:00Z", NOW)).toBe("45m ago");
  expect(relativeAge("2026-03-10T05:00:00Z", NOW)).toBe("7h ago");
  expect(relativeAge("2026-03-07T12:00:00Z", NOW)).toBe("3d ago");
  expect(relativeUntil("2026-03-10T12:00:30Z", NOW)).toBe("soon");
  expect(relativeUntil("2026-03-10T15:00:00Z", NOW)).toBe("in 3h");
  expect(relativeUntil("2026-03-15T12:00:00Z", NOW)).toBe("in 5d");
  expect(formatDuration(null)).toBe("-");
  expect(formatDuration(42_000)).toBe("42s");
  expect(formatDuration(185_000)).toBe("3m 05s");
  expect(formatDuration(3_900_000)).toBe("1h 05m");
});

test("rows combine definitions, schedules and the latest run; sort puts recently run first", () => {
  const rows = automationRows(
    [definition("a", "Weekly review"), definition("b", "Manual only", "2026-03-05T00:00:00Z"), definition("c", "Ran lately")],
    [schedule(), schedule({ id: "t9", workflowId: "b", enabled: false })],
    [execution("e1", "a", "2026-03-09T09:00:00Z"), execution("e2", "a", "2026-03-10T09:00:00Z", "failed"), execution("e3", "c", "2026-03-10T10:00:00Z")],
  );
  const a = rows.find(row => row.id === "a")!;
  expect(a).toMatchObject({ enabled: true, scheduled: true, lastStatus: "failed", lastRunAt: "2026-03-10T09:00:00Z", nextFireAt: "2026-03-11T09:00:00Z", steps: 1, trigger: "Daily 09:00 UTC" });
  expect(rows.find(row => row.id === "b")).toMatchObject({ enabled: false, scheduled: true, trigger: "Daily 09:00 UTC (paused)" });
  expect(sortAutomationRows(rows).map(row => row.id)).toEqual(["c", "a", "b"]);
  expect(filterAutomationRows(rows, "  MANUAL only ")).toHaveLength(1);
  expect(filterAutomationRows(rows, "repo/a daily")).toHaveLength(1);
  expect(filterAutomationRows(rows, "")).toHaveLength(3);
});

test("blank and prompt-prefilled drafts are valid workflow definitions", () => {
  expect(parseSecurityWorkflowInput(blankAutomationInput()).name).toBe("Untitled automation");
  const { name, instructions } = automationFromPrompt("Review every new pull request for auth bugs. Comment on risky ones.\nSecond line.");
  expect(name).toBe("Review every new pull request for auth bugs");
  expect(instructions).toContain("Second line.");
  expect(parseSecurityWorkflowInput(blankAutomationInput({ name, instructions })).instructions).toBe(instructions.trim());
  expect(automationFromPrompt("x".repeat(100)).name).toHaveLength(60);
  expect(automationFromPrompt("   ").name).toBe("Untitled automation");
});

test("templates are searchable by name, description and category", () => {
  expect(filterTemplates(SECURITY_WORKFLOW_TEMPLATES, "")).toHaveLength(SECURITY_WORKFLOW_TEMPLATES.length);
  expect(filterTemplates(SECURITY_WORKFLOW_TEMPLATES, "whitebox").map(item => item.id)).toContain("repository-review");
  expect(filterTemplates(SECURITY_WORKFLOW_TEMPLATES, "zzzz")).toEqual([]);
});

test("duplicate names do not stack suffixes", () => {
  expect(duplicateName("Nightly")).toBe("Nightly copy");
  expect(duplicateName("Nightly copy")).toBe("Nightly copy");
});

test("an empty or blank name is rejected inline", () => {
  expect(validateAutomationDraft({ name: "  " })).toEqual({ name: "Name is required" });
  expect(validateAutomationDraft({ name: "Nightly" })).toEqual({});
});

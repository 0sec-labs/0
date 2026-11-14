import { expect, test } from "vitest";
import type { ConsoleWorker } from "@0/engine/shared";
import { agentRows, agentsSummary, agentTone, browserItems, captureMatchesView, externalUrl, formatCostUsd, selectBrowserKey, shortAge, taskLine, workerCostUsd, workerSubtitle } from "../src/console/panel/views/agents-model";

const worker = (patch: Partial<ConsoleWorker> & { id: string }): ConsoleWorker => ({ parentId: "chat", name: patch.id, status: "completed", task: "", transcript: [], ...patch });

test("tones and cancellation", () => {
  expect(agentTone(worker({ id: "a", status: "failed", error: "Turn cancelled by operator" }))).toBe("stopped");
  expect(agentTone(worker({ id: "a", status: "failed", error: "boom" }))).toBe("failed");
  expect(agentTone(worker({ id: "a", status: "parked" }))).toBe("waiting");
});

test("taskLine takes the first line and clips", () => {
  expect(taskLine("\n## Scan   the API\nmore")).toBe("Scan the API");
  expect(taskLine("x".repeat(300), 10)).toHaveLength(10);
});

test("cost only when numeric", () => {
  expect(workerCostUsd(worker({ id: "a" }))).toBeUndefined();
  expect(workerCostUsd(worker({ id: "a", telemetry: { costUsd: "1" } }))).toBeUndefined();
  expect(workerCostUsd(worker({ id: "a", telemetry: { costUsd: 0.5 } }))).toBe(0.5);
  expect(formatCostUsd(0.001)).toBe("<$0.01");
  expect(formatCostUsd(1.234)).toBe("$1.23");
});

test("rows put live work first and keep order otherwise", () => {
  const rows = agentRows([worker({ id: "done" }), worker({ id: "run", status: "running", task: "t" }), worker({ id: "done2" })], 0);
  expect(rows.map(row => row.id)).toEqual(["run", "done", "done2"]);
  expect(rows[0]!.stoppable).toBe(true);
  expect(agentsSummary([worker({ id: "a", status: "running" }), worker({ id: "b" })]).text).toBe("1 running, 1 done");
});

test("age and subtitle", () => {
  expect(shortAge(undefined, 10)).toBeUndefined();
  expect(shortAge(0, 5 * 60_000)).toBe("5m");
  expect(shortAge(0, 2 * 86_400_000)).toBe("2d");
  expect(workerSubtitle(worker({ id: "a", status: "running" }))).toBe("Thinking…");
});

test("browser dedupe and selection", () => {
  const view = { id: "v", pageId: "p", url: "https://a.test", producerId: "chat" };
  expect(captureMatchesView({ pageId: "p", owner: "x" }, view, [])).toBe(true);
  expect(captureMatchesView({ url: "https://a.test", owner: "Main chat" }, view, [])).toBe(true);
  const result = browserItems([view], [{ id: "c1", url: "https://a.test", owner: "Main chat" }, { id: "c2", url: "https://b.test", owner: "Main chat" }], [], new Set(["view:zzz"]));
  expect(result.live).toHaveLength(1);
  expect(result.captures.map(c => c.id)).toEqual(["c2"]);
  expect(browserItems([view], [], [], new Set(["view:v"])).live).toHaveLength(0);
  expect(selectBrowserKey(["a", "b"], "z")).toBe("a");
  expect(selectBrowserKey(["a", "b"], "b")).toBe("b");
  expect(externalUrl("javascript:alert(1)")).toBeUndefined();
  expect(externalUrl("https://u:p@a.test")).toBeUndefined();
  expect(externalUrl("https://a.test/x")).toBe("https://a.test/x");
});

import { eventBus } from "@0/core";
import { afterEach, expect, test, vi } from "vitest";
import type * as SessionModule from "../../../src/console-session.js";
import { launch, type TuiHandle } from "../index.js";
import { modelsByokLaunch } from "./_helpers.js";

const capture = vi.hoisted(() => ({ scanId: "" }));
vi.mock("../../../src/console-session.js", async (original) => {
  const actual = await original<typeof SessionModule>();
  return {
    ...actual,
    createLocalConsoleSession(...args: Parameters<typeof actual.createLocalConsoleSession>) {
      const session = actual.createLocalConsoleSession(...args);
      capture.scanId = session.scanId;
      return session;
    },
  };
});

let tui: TuiHandle | undefined;
afterEach(async () => {
  await tui?.close();
  tui = undefined;
  capture.scanId = "";
  vi.restoreAllMocks();
});

async function selectTask(label: string) {
  const rows = tui!.rawFrame().replace(/਀/g, " ").split("\n");
  const y = rows.findIndex((line) => line.includes(label));
  expect(y, tui!.captureFrame()).toBeGreaterThanOrEqual(0);
  await tui!.moveMouse(rows[y]!.indexOf(label), y);
  await tui!.click(rows[y]!.indexOf(label), y);
}

function contextLine() {
  return tui!.captureFrame().split("\n").find((line) => line.includes("Context:")) ?? "";
}

test("worker focus shows its measured context, retains partial samples and leaves root plan uncluttered", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  const fixture = modelsByokLaunch({ mouse: true });
  tui = await launch({ ...fixture, route: { type: "chat" }, cols: 140, rows: 40,
    settings: { reduceMotion: true, mouseSupport: true, showContextMeter: true,
      diagnosticReporting: "off", diagnosticReportingPrompted: true } });
  await tui.waitForText(/Context: unknown\s*\/\s*128k/);
  await tui.settle();
  expect(capture.scanId).not.toBe("");
  const parent = capture.scanId;
  eventBus.emit("todos", { scan_id: parent, revision: 1, done: 0, total: 2, line: "Plan 0/2",
    todos: [{ id: "trace", content: "Trace the authorization boundary", status: "in_progress" },
      { id: "verify", content: "Verify the source evidence", status: "pending" }] });
  for (const [id, task] of [["measured", "Inspect authorization with measured context"],
    ["unknown", "Inspect headers without a context sample"]] as const) {
    eventBus.emit("subagent_lifecycle", { agent_id: id, parent_scan_id: parent, name: id,
      status: "running", task, max_turns: 20, model: "gpt-6-astra", provider: "openai" });
  }
  eventBus.emit("peer_message", { scan_id: parent, from: "measured", to: "Main",
    kind: "peer", ts: 1, body: "The source workspace is ready for review." });
  eventBus.emit("subagent_message", { agent_id: "measured", parent_scan_id: parent,
    turn: 1, ts: 1, model: "gpt-6-astra", provider: "openai", contextTokens: 210_000,
    usage: { inputTokens: 900_000, outputTokens: 100_000, cachedInputTokens: 0 },
    assistant: "The measured worker retained its source observations." });
  await tui.waitForText(/Trace the authorization boundary/);
  expect(tui.captureFrame()).toContain("Trace the authorization boundary");
  expect(tui.captureFrame()).not.toMatch(/No main-task lead|Needs you:|main tasks done/);
  await selectTask("Inspect authorization with measured context");
  expect(contextLine()).toContain("20%");
  expect(contextLine()).not.toMatch(/unavailable|95%|100%/);
  eventBus.emit("subagent_message", { agent_id: "measured", parent_scan_id: parent,
    turn: 2, ts: 2, partial: true, assistant: "Inspecting another source region." });
  await tui.waitForText(/Inspecting another source region/);
  expect(contextLine()).toContain("20%");
  await selectTask("Inspect headers without a context sample");
  expect(contextLine()).toContain("unknown");
  expect(contextLine()).not.toMatch(/20%|0%|unavailable/);
  await tui.sendKey("home", { ctrl: true, shift: true });
  expect(contextLine()).not.toContain("20%");
});

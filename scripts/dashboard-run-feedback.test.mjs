import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
test("composer feedback reflects terminal events before session refresh and the live phase", async () => {
  const directory = await mkdtemp(resolve(root, "packages/dashboard/.run-feedback-test-"));
  try {
    const output = resolve(directory, "fixture.mjs");
    await build({ entryPoints: [resolve(root, "packages/dashboard/src/console/run-feedback.ts")], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const { runFeedback, turnLimitNotice } = await import(pathToFileURL(output).href);
    const snapshot = { session: { status: "working" }, pendingDecisions: [] };
    const turn = { isComplete: false, notices: [], toolCalls: [], assistantText: "", stopReason: undefined };
    assert.deepEqual(runFeedback(snapshot, turn), { label: "Thinking…", active: true });
    assert.match(runFeedback(snapshot, { ...turn, toolCalls: [{ name: "read_file", isRunning: true }] }).label, /Running read file/);
    assert.deepEqual(runFeedback({ ...snapshot, session: { status: "waiting" } }, turn), { label: "Waiting for your decision", active: true, waiting: true });
    assert.equal(runFeedback(snapshot, { ...turn, notices: ["Cancellation requested."] }).label, "Stopping…");
    assert.deepEqual(runFeedback(snapshot, { ...turn, notices: ["Provider output cap reached; continuing from retained observations (continuation 4)."] }), { label: "Continuing automatically…", active: true });
    assert.deepEqual(runFeedback(snapshot, { ...turn, isComplete: true, stopReason: "max_tool_iterations" }), { label: "Response stopped at the previous tool limit", active: false }, "the stop button cannot stay active after turn-complete");
    assert.deepEqual(runFeedback(snapshot, { ...turn, isComplete: true, stopReason: "end_turn" }), { label: "Response complete", active: false });
    assert.deepEqual(runFeedback(snapshot, { ...turn, isComplete: true, stopReason: "cancelled", error: "Workbench cancelled" }), { label: "Stopped", active: false });
    assert.deepEqual(runFeedback({ ...snapshot, session: { status: "failed" } }, { ...turn, error: "Connection refused" }), { label: "Response failed", active: false, error: "Connection refused" });
    assert.equal(runFeedback({ ...snapshot, session: { status: "ready" } }), null, "new chats do not get a noisy ready row");
    assert.equal(turnLimitNotice({ ...turn, isComplete: true, stopReason: "max_tool_iterations" }), "This response stopped at the previous tool limit.");
    assert.equal(turnLimitNotice({ ...turn, isComplete: false, stopReason: "max_tool_iterations" }), undefined, "live turns cannot display terminal notices");
    assert.equal(turnLimitNotice({ ...turn, isComplete: true, stopReason: "end_turn" }), undefined, "successful replies do not need a redundant status banner");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

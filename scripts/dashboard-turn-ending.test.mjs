import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("a turn that produced nothing shows a plain row, never a bare Worked divider", async () => {
  const dashboard = resolve(repoRoot, "packages/web");
  const temporary = await mkdtemp(resolve(dashboard, ".turn-ending-test-"));
  try {
    const output = resolve(temporary, "fixture.mjs");
    await build({
      stdin: { contents: `
        import React from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { TurnTimeline } from "./src/console/turn-timeline";
        import { TurnEndingRow } from "./src/console/turn-ending-row";
        export { reduceTurns } from "./src/console/transcript";
        export { turnEnding } from "./src/console/turn-ending";
        export const timeline = turn => renderToStaticMarkup(React.createElement(TurnTimeline, { turn, streaming: false, latestTurn: true }));
        export const row = props => renderToStaticMarkup(React.createElement(TurnEndingRow, { snapshot: { session: { id: "s" } }, message: { text: "hello?" }, busy: false, ...props }));
      `, resolveDir: dashboard, loader: "tsx" },
      outfile: output, bundle: true, platform: "node", format: "esm",
      packages: "external", loader: { ".css": "empty", ".svg": "dataurl" }, logLevel: "silent", jsx: "automatic",
    });
    const { reduceTurns, turnEnding, timeline, row } = await import(pathToFileURL(output).href);
    const at = { occurredAt: "2026-01-01T00:00:10Z" };
    const budget = { tokensUsed: 0, tokenBudget: null, iterations: 1, maxToolIterations: null };
    const turnFor = (...events) => reduceTurns([{ type: "user", sequence: 1, text: "hello?", occurredAt: "2026-01-01T00:00:00Z" }, ...events.map((event, index) => ({ sequence: index + 2, ...at, ...event }))], "ready")[0];
    const done = (rest = {}) => ({ type: "turn-complete", assistantText: "", stopReason: "end_turn", budget, ...rest });

    // Nothing to show: no divider at all.
    const empty = turnFor(done());
    assert.doesNotMatch(timeline(empty), /Worked|Turn work|data-turn-work-status/);
    // Reasoning only is kept as partial progress, but it is named for what it is.
    const thought = turnFor({ type: "reasoning-delta", text: "Considering the question." }, done());
    assert.match(timeline(thought), /Thought for 10s/);
    assert.doesNotMatch(timeline(thought), /Worked/);
    // Real work keeps the Worked divider.
    const worked = turnFor({ type: "tool-start", call: { id: "a", name: "read_file", arguments: {} } }, { type: "tool-result", call: { id: "a", name: "read_file" }, result: { success: true, output: "x" } }, done({ assistantText: "Done." }));
    assert.match(timeline(worked), /Worked for 10s/);

    const text = html => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    // The row: copy, and the actions that fit each ending.
    const view = (kind, interactive = true, extra = {}) => row({ kind, interactive, onRetry() {}, onContinue() {}, ...extra });
    assert.equal(text(view("truncated")), "The reply was cut off. Continue");
    assert.equal(text(view("filtered", true, { onRetry: undefined })), "The provider blocked this reply.");
    assert.equal(text(view("disconnected")), "The connection dropped before the model answered. Retry");
    assert.equal(text(view("no_reply", false)), "The model returned no reply.", "history turns and busy threads show the sentence without controls");
    assert.match(view("truncated"), /data-turn-ending="truncated"/);
    assert.match(view("disconnected"), /role="status"/);
    assert.match(view("disconnected", true, { busy: true }), /<button[^>]*disabled=""[^>]*>Retry<\/button>/, "Retry waits while the thread is busy");

    // Endings only appear once the turn is over.
    assert.equal(turnEnding(empty), "no_reply");
    assert.equal(turnEnding(reduceTurns([{ type: "user", sequence: 1, text: "hi" }], "working")[0]), undefined);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

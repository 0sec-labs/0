import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("agent companion panel keeps cancellation noise out while preserving actual failures", async () => {
  const dashboard = resolve(repoRoot, "packages/dashboard");
  const temporary = await mkdtemp(resolve(dashboard, ".agents-panel-test-"));
  const previousWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: false }), location: { origin: "http://localhost" } };
  try {
    const output = resolve(temporary, "fixture.mjs");
    await build({ stdin: { contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { AgentsPanel } from "./src/console/agents-panel";
      import { ToolActivity } from "./src/console/tool-activity";
      export const render = props => renderToStaticMarkup(React.createElement(AgentsPanel, props));
      export const renderTools = props => renderToStaticMarkup(React.createElement(ToolActivity, props));
    `, resolveDir: dashboard, loader: "tsx" }, outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", alias: { "@": resolve(dashboard, "src") }, logLevel: "silent" });
    const { render, renderTools } = await import(pathToFileURL(output).href);
    const calls = [
      { id: "browser", name: "browser", arguments: {}, result: { success: false, error: "Connection refused" }, isRunning: false },
      { id: "command", name: "run_command", arguments: {}, result: { success: true }, isRunning: false },
      { id: "search", name: "search_files", arguments: {}, isRunning: true },
    ];
    const liveTools = renderTools({ calls, working: true });
    assert.match(liveTools, /aria-label="Live tools"/);
    assert.match(liveTools, /Using search files/);
    assert.match(liveTools, /run command/);
    assert.match(liveTools, /lucide-globe/);
    assert.doesNotMatch(liveTools, /to review/);
    const finishedTools = renderTools({ calls: calls.map(call => ({ ...call, isRunning: false })), working: false });
    assert.doesNotMatch(finishedTools, /aria-label="Live tools"/);
    assert.doesNotMatch(finishedTools, /to review/);
    const worker = { id: "agent-1", parentId: "main", name: "Inspect browser", task: "Inspect the visible page", status: "failed", model: "test-model", transcript: [{ turn: 1, ts: 1000, assistant: "This operation was aborted" }], summary: "This operation was aborted", error: "This operation was aborted" };
    const snapshot = { workers: [worker] };
    const html = render({ snapshot, selectedWorkerId: worker.id, onSelect() {} });
    assert.match(html, /aria-label="Agents"/);
    assert.match(html, /aria-label="Back to agents"/);
    assert.match(html, /Stopped/);
    assert.doesNotMatch(html, /This operation was aborted/);
    assert.doesNotMatch(html, /role="alert"/);
    assert.match(html, /aria-label="View agent assignment"/, "assignment remains available through the info button");
    assert.doesNotMatch(html, /Task details/);
    assert.doesNotMatch(html, /Inspect the visible page/, "closed assignment dialog keeps the raw task out of the transcript");

    const failure = render({ snapshot: { workers: [{ ...worker, transcript: [], summary: undefined, error: "Browser connection refused" }] }, selectedWorkerId: worker.id, onSelect() {} });
    assert.match(failure, /role="alert"[^>]*>Browser connection refused/);
    const grouped = render({ snapshot: { workers: [{ ...worker, status: "running", error: undefined, transcript: [] }, { ...worker, id: "agent-2", name: "Review output", status: "completed", error: undefined, transcript: [] }, { ...worker, id: "agent-3" }] }, onSelect() {} });
    assert.match(grouped, />Active<\/span>/);
    assert.match(grouped, />Complete<\/span>/);
    assert.match(grouped, />Stopped \/ Failed<\/span>/);
    assert.match(grouped, /Inspect browser/);
    assert.match(grouped, /Review output/);
    assert.doesNotMatch(grouped, /This operation was aborted/);
    const closed = render({ snapshot, open: false, onSelect() {} });
    assert.match(closed, /data-open="false"/);
    assert.match(closed, /aria-hidden="true"/);
    assert.match(closed, /inert=""/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await rm(temporary, { recursive: true, force: true });
  }
});

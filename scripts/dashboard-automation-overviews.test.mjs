import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const dashboard = fileURLToPath(new URL("../packages/dashboard/", import.meta.url));
test("large swarm overview preserves each agent and keeps workflow configuration out of the preview", async () => {
  const temporary = await mkdtemp(resolve(dashboard, ".automation-overviews-"));
  try {
    const output = resolve(temporary, "fixture.mjs");
    await build({ stdin: { contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { SwarmProgress } from "./src/console/swarm-progress";
      import { WorkflowGraph } from "./src/components/workflow-graph";
      export const swarm = workers => renderToStaticMarkup(React.createElement(SwarmProgress, { workers, onSelect() {} }));
      export const graph = definition => renderToStaticMarkup(React.createElement(WorkflowGraph, { definition, selectedId: null, onSelect() {} }));
    `, resolveDir: dashboard, loader: "tsx" }, outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", alias: { "@": resolve(dashboard, "src") }, logLevel: "silent" });
    const { swarm, graph } = await import(pathToFileURL(output).href);
    const workers = Array.from({ length: 1024 }, (_, index) => ({ id: `agent-${index}`, name: `Agent ${index}`, status: index < 512 ? "completed" : index < 544 ? "running" : "queued", transcript: [], task: "Review assigned area" }));
    const html = swarm(workers);
    assert.match(html, /512 \/ 1024 complete/);
    assert.match(html, /32 running/);
    assert.match(html, /480 waiting/);
    assert.equal((html.match(/aria-label="Agent \d+:/g) ?? []).length, 1024);
    assert.match(html, /Agent 1024: Agent 1023, queued/);
    const cancelled = swarm([{ ...workers[0], status: "failed", error: "This operation was aborted" }]);
    assert.match(cancelled, /1 stopped/);
    assert.doesNotMatch(cancelled, /need attention/);
    const definition = { nodes: [{ id: "review", label: "Trust boundaries", type: "audit", enabled: true, execution: { instructions: "LONG_CONFIGURATION_SENTINEL", allowedAgentTools: ["PRIVATE_TOOL_SENTINEL"] }, plan: { goal: "unknown-vulnerabilities", depth: "deep", runCount: 1, executionMode: "sequential", timeCapMs: 600000, costCapUsd: 5 } }], edges: [] };
    const preview = graph(definition);
    assert.match(preview, /Step 1: Trust boundaries, Security assessment, enabled/);
    assert.doesNotMatch(preview, /LONG_CONFIGURATION_SENTINEL|PRIVATE_TOOL_SENTINEL|Limits:|sequential run/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

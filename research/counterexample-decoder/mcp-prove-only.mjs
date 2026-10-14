#!/usr/bin/env node
/**
 * Production-path workflow proof: drive the audit→counterexample workflow
 * through `0 mcp-server --workflows` (the real engine job lifecycle) over
 * MCP stdio. The server owns execution — no embedded-host lifecycle issues.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = new URL("../../", import.meta.url).pathname;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/0.js", "mcp-server", "--workflows", "--workspace", REPO, "--db-path", "/tmp/zero-wf-mcp.db"],
  cwd: REPO,
  env: { ...process.env, PATH: `/opt/homebrew/opt/llvm@22/bin:${process.env.PATH}` },
  stderr: "inherit",
});
const client = new Client({ name: "counterexample-workflow-proof", version: "0.1.0" });
await client.connect(transport);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find(c => c.type === "text")?.text ?? "";
  if (result.isError) throw new Error(`${name}: ${text}`);
  return result.structuredContent?.output ?? JSON.parse(text);
};

const definition = {
  name: "Review then counterexample-prove",
  instructions: "Audit a C target, then prove a finding with a sanitizer witness replay and mitigation replay.",
  target: "research/counterexample-decoder/demo-target",
  nodes: [
    { id: "start", type: "trigger", label: "Start", enabled: true },
    { id: "prove", type: "research", label: "Counterexample proof", enabled: true,
      inputs: {
        engine: "counterexample",
        findingId: "b780dd5d-cef1-4362-9bb8-da2b311db8e4",
        fn: "decode_payload",
        header: "decoder.h",
        declaration: "int decode_payload(const uint8_t *data, size_t size, uint8_t **out, size_t *out_size);",
        inputShape: "bytesAndLenOut",
        timeoutSec: 10,
        witnesses: ["witness-65537x1.bin"],
        mitigationSources: ["patched-decoder.c"],
        mitigationIncludes: ["include"],
      },
      plan: { goal: "unknown-vulnerabilities", depth: "default", runCount: 1, executionMode: "sequential", timeCapMs: 300_000, costCapUsd: 1 } },
  ],
  edges: [{ source: "start", target: "prove" }],
};

const saved = await call("save_workflow", { definition });
console.error(`saved workflow ${saved.id ?? saved.workflow?.id} revision ${saved.revision ?? saved.workflow?.revision}`);
const workflowId = saved.id ?? saved.workflow?.id;
const revision = saved.revision ?? saved.workflow?.revision;

const run = await call("start_run", { workflowId, revision, target: definition.target, timeCapMs: 900_000, costCapUsd: 10 });
console.error(`run ${run.id ?? run.runId} started`);
const runId = run.id ?? run.runId;

for (;;) {
  const status = await call("get_run", { runId });
  if (status.status !== "queued" && status.status !== "running") {
    console.error(`run finished: ${status.status}${status.error ? ` (${status.error})` : ""}`);
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
}

const results = await call("get_run_results", { runId, limit: 20 });
for (const finding of results.findings ?? []) {
  console.log(JSON.stringify({
    id: finding.id, title: finding.title, severity: finding.severity,
    status: finding.status, grade: finding.researchEvidence?.at(-1)?.grade,
  }));
}
await client.close();

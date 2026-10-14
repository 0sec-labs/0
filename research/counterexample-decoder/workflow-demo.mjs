#!/usr/bin/env node
/**
 * Automation demo: run the full loop as ONE Zero workflow.
 *
 *   audit node  — pipeline source review discovers the decoder bug
 *   research    — counterexample engine replays a witness through the
 *                 sanitizer build and the reference mitigation
 *
 * Uses Zero's own workflow runtime with the embedded host (same engine the
 * browser API and `0 mcp-server --workflows` local mode use), so the demo
 * does not collide with an already-running engine's workflow store.
 * Requires OPENAI_API_KEY for the audit node and a libFuzzer-capable clang
 * on PATH for the counterexample node (Homebrew LLVM).
 */
import { createCliWorkflowRuntime } from "../../packages/cli/dist/workflow-runtime.js";
import { ConsoleGateway } from "../../packages/cli/dist/web/console-gateway.js";
import { WebWorkflowService } from "../../packages/cli/dist/web/workflows.js";

const REPO = new URL("../../", import.meta.url).pathname;

const definition = {
  // No revision: the store treats id+revision on first save as a failed update.
  id: `counterexample-pipeline-demo-${Date.now()}`,
  name: "Review then counterexample-prove",
  instructions: "Audit a C target, then prove a finding with a sanitizer witness replay and mitigation replay.",
  target: "research/counterexample-decoder/demo-target",
  nodes: [
    { id: "start", type: "trigger", label: "Start", enabled: true },
    { id: "audit", type: "audit", label: "Source review", enabled: true,
      plan: { goal: "unknown-vulnerabilities", depth: "default", runCount: 1, executionMode: "sequential", timeCapMs: 600_000, costCapUsd: 5 } },
    { id: "prove", type: "research", label: "Counterexample proof", enabled: true,
      inputs: {
        engine: "counterexample",
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
  edges: [{ source: "start", target: "audit" }, { source: "audit", target: "prove" }],
};

const gateway = new ConsoleGateway({ projectPath: REPO });
const workflows = new WebWorkflowService({ gateway });
gateway.attachWorkflowLifecycle({ invoke: (sessionId, name, args, capabilities) => workflows.invokeLifecycle(sessionId, name, args, capabilities) });
const runtime = await createCliWorkflowRuntime(
  { ownerId: "demo:counterexample-pipeline", workspace: REPO },
  { host: { gateway, workflows } },
);

const saved = await runtime.saveWorkflow(definition);
console.error(`saved workflow revision ${saved.revision ?? definition.revision}`);

const run = await runtime.startRun({
  workflowId: definition.id,
  revision: saved.revision ?? definition.revision,
  target: definition.target,
  timeCapMs: 900_000,
  costCapUsd: 10,
});
console.error(`run ${run.id} started`);

for (;;) {
  const status = await runtime.getRun(run.id);
  if (status.status !== "queued" && status.status !== "running") {
    console.error(`run finished: ${status.status}${status.error ? ` (${status.error})` : ""}`);
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
}

const results = await runtime.getRunResults(run.id, { limit: 20 });
for (const finding of results.findings ?? []) {
  console.log(JSON.stringify({
    id: finding.id, title: finding.title, severity: finding.severity,
    status: finding.status, grade: finding.researchEvidence?.at(-1)?.grade,
  }));
}
await runtime.dispose?.();

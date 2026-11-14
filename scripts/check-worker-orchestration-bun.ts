/** Offline issue290 qualification through the built CLI's private worker entry.
 * Usage: bun scripts/check-worker-orchestration-bun.ts <built-cli-index.js>
 * No model mocks inside the worker: all tools/native loops use a loopback Responses API.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LlmApiRuntime, TOOL_DEFINITIONS } from "../packages/engine/dist/index.js";
import { createHostConsoleSession, type HostConsoleSession } from "../packages/cli/src/host-console-session.js";

assert(process.versions.bun, "Run this qualification with Bun");
assert(["darwin", "linux"].includes(process.platform), "Host workers require qualified POSIX/Bun execution");
assert(process.argv[2], "Supply the freshly built CLI index.js");
const cli = resolve(process.argv[2]);
assert(existsSync(cli), "Build the CLI before qualification");
const root = mkdtempSync(join(tmpdir(), "0-worker-orchestration-"));
// Only this isolated qualification process and its owned child use this HOME.
process.env.HOME = root;
const checkout = join(root, "checkout");
execFileSync("git", ["init", "--quiet", checkout]);
const file = join(checkout, "fixture.txt");
const sentinel = join(checkout, "ticks.txt");
writeFileSync(file, "original\n");
execFileSync("git", ["-C", checkout, "add", "."]);
execFileSync("git", ["-C", checkout, "-c", "user.name=Offline fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
type Item = { role?: string; type?: string; content?: unknown; output?: string; call_id?: string };
const traces: Array<{ actor: string; outputs: string[] }> = [];
const counts = new Map<string, number>();
let stopId = "";
let requests = 0;
const text = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value);
function reply(output: unknown[]) {
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
    id: `offline-${requests}`, status: "completed", output, usage: { input_tokens: 8, output_tokens: 4 },
  } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
}
const done = () => reply([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Offline fixture completed" }] }]);
const call = (name: string, args: unknown) => reply([{ type: "function_call", call_id: `call_${requests}`, name, arguments: JSON.stringify(args) }]);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  try {
    assert.equal(new URL(request.url).pathname, "/v1/responses");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-loopback-only");
    const body = await request.json() as { model: string; input: Item[] };
    assert.equal(body.model, "gpt-worker-fixture");
    assert(++requests <= 80, "Unexpected provider loop");
    const user = body.input.filter(item => item.role === "user" || item.role === "system").map(item => text(item.content)).join("\n");
    const markers = [...user.matchAll(/(?:OP|CHILD)_290_[A-Z]+/g)];
    const actor = markers.at(-1)?.[0];
    assert(actor, "Request has no explicit fixture task marker");
    const n = counts.get(actor) ?? 0;
    counts.set(actor, n + 1);
    traces.push({ actor, outputs: body.input.filter(item => item.type === "function_call_output").map(item => item.output ?? "") });
    if (actor === "CHILD_290_WRITER") {
      if (n === 0) return call("str_replace", { path: file, old_string: "original", new_string: "written" });
      if (n === 1) return call("bash", { command: `while true; do printf x >> '${sentinel}'; sleep 0.05; done`, timeout: 120 });
      return call("done", { summary: "Actual tool outcome observed" });
    }
    if (actor === "CHILD_290_READONLY") {
      if (n === 0) return call("str_replace", { path: file, old_string: "written", new_string: "FORBIDDEN" });
      return call("done", { summary: "Actual tool outcome observed" });
    }
    if (actor === "CHILD_290_FAILURE") {
      if (n === 0) return call("str_replace", { path: file, old_string: "written", new_string: "failure-written" });
      return Response.json({ error: { message: "Deterministic offline worker provider failure", type: "invalid_request_error" } }, { status: 400 });
    }
    if (actor === "CHILD_290_EARLY") return Response.json({ error: { message: "Deterministic offline failure before tools", type: "invalid_request_error" } }, { status: 400 });
    if (n > 0) return done();
    if (actor === "OP_290_WRITER") return call("spawn_agent", { task: "CHILD_290_WRITER: perform the fixture edit then run the bounded sentinel shell until stopped.", name: "writer", wait: false });
    if (actor === "OP_290_SECOND") return call("spawn_agent", { task: "CHILD_290_SECOND: no work", name: "second-writer", wait: false });
    if (actor === "OP_290_READONLY") return call("spawn_agent", { task: "CHILD_290_READONLY: attempt the fixture edit once and report the actual tool result.", name: "readonly", read_only: true, wait: false });
    if (actor === "OP_290_FAILURE") return call("spawn_agent", { task: "CHILD_290_FAILURE: attempt the fixture edit once then encounter the deterministic provider failure.", name: "failure", wait: false });
    if (actor === "OP_290_EARLY") return call("spawn_agent", { task: "CHILD_290_EARLY: no tool may execute before the deterministic provider failure.", name: "early-failure", wait: false });
    if (actor === "OP_290_STOP") return call("spawn_agent", { op: "stop", agent_id: stopId });
    if (actor === "OP_290_STOPALL") return call("spawn_agent", { op: "stop_all" });
    if (actor === "OP_290_LIST") return call("spawn_agent", { op: "list" });
    throw new Error(`Unexpected actor ${actor}`);
  } catch (error) {
    console.error("Loopback fixture error:", String(error));
    return new Response("fixture protocol failed", { status: 500 });
  }
} });
let session: HostConsoleSession | undefined;
const until = async (test: () => boolean, label: string) => {
  const deadline = Date.now() + 15000;
  while (!test()) { assert(Date.now() < deadline, `Timed out: ${label}; ${JSON.stringify(traces)}`); await Bun.sleep(25); }
};
try {
  const runtime = new LlmApiRuntime({ type: "api", timeout: 10000, provider: "openai", model: "gpt-worker-fixture", env: {
    OPENAI_API_KEY: "synthetic-loopback-only", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`, OPENAI_WIRE_API: "responses", ZERO_SUPPRESS_PROVIDER_STARTUP_LOG: "1", ZERO_LLM_FALLBACK: "",
  } });
  session = createHostConsoleSession({ config: { runtime, role: "attack", tools: ["spawn_agent", "str_replace", "bash", "done"].map(name => TOOL_DEFINITIONS[name]), scanId: "offline-orchestration", workspaceRoot: checkout,
    agentMessaging: { selfId: "offline-orchestration", selfRole: "parent", projectPath: checkout, homeDir: root, siblingChannelEnabled: false, operatorChannelEnabled: false },
    codebaseLearning: false, refineObjective: false, autonomyMode: "yolo", maxToolIterations: 12 },
    dbPath: join(root, "fixture.db"), executionEnvironment: { ZERO_0VERSE_MCP: "0", ZERO_DISABLE_HUNT_MEMORY: "1", ZERO_NO_TELEMETRY: "1" },
    launch: { command: process.execPath, args: [cli, "--host-console-worker"], cwd: checkout, env: { PATH: process.env.PATH, HOME: root }, graceMs: 100 },
  });
  await session.ready;
  await session.configureWorkspace(checkout);
  const op = async (marker: string) => {
    counts.set(marker, 0);
    const turn = await session!.send(marker);
    const tool = turn.toolCalls.find(item => item.call.name === "spawn_agent");
    assert(tool, `${marker} did not dispatch the public tool`);
    return tool.result;
  };
  const first = await op("OP_290_WRITER");
  assert(first.success, JSON.stringify(first));
  stopId = (first.output as { agent_id: string }).agent_id;
  assert(stopId, "Spawn receipt omitted worker ID");
  await until(() => existsSync(sentinel) && readFileSync(sentinel).length > 1, "actual child edit and owned shell");
  assert.equal(readFileSync(file, "utf8"), "written\n");
  const second = await op("OP_290_SECOND");
  assert.equal(second.success, false, "Second shared-checkout writer was admitted");
  assert.match(JSON.stringify(second), /writ|workspace/i);
  const list = await op("OP_290_LIST");
  assert(list.success);
  const writer = (list.output as { workers: Array<{ id: string; workspace: { writeCapable: boolean }; localEffects: { attempts: number; observedWrites: number; tools: string[] }; effects: string }> }).workers.find(item => item.id === stopId);
  assert(writer);
  assert.equal(writer.workspace.writeCapable, true);
  assert.equal(writer.localEffects.observedWrites, 1);
  assert(writer.localEffects.attempts >= 2);
  assert.equal(writer.effects, "unknown", "Cleanup/effect knowledge must remain distinct");
  assert.match(JSON.stringify(list.output), /observedWrites/);
  assert.match(JSON.stringify(list.output), /str_replace/);
  const stopped = await op("OP_290_STOP");
  assert(stopped.success, JSON.stringify(stopped));
  const stopReceipt = stopped.output as { cleanupDrained: boolean; worker: { cleanup: string; effects: string; localEffects: { observedWrites: number } } };
  assert.equal(stopReceipt.cleanupDrained, true);
  assert.equal(stopReceipt.worker.cleanup, "drained");
  assert.equal(stopReceipt.worker.effects, "unknown");
  assert.equal(stopReceipt.worker.localEffects.observedWrites, 1, "Stop erased an observed edit");
  const bytes = readFileSync(sentinel).length;
  await Bun.sleep(250);
  assert.equal(readFileSync(sentinel).length, bytes, "Stopped owned shell continued writing");
  assert((await op("OP_290_READONLY")).success);
  await until(() => (counts.get("CHILD_290_READONLY") ?? 0) >= 2, "readonly attempt result");
  assert.equal(readFileSync(file, "utf8"), "written\n", "read_only was advisory");
  assert.match(JSON.stringify(traces.filter(t => t.actor === "CHILD_290_READONLY").at(-1)?.outputs), /read.only|denied|not.allowed|not.available/i);
  type Worker = { name: string; status: string; live: boolean; cleanup: string; workspace: { readOnly: boolean; writeCapable: boolean }; localEffects: { attempts: number; observedWrites: number; tools: string[] }; effects: string };
  const waitFailed = async (name: string) => {
    const deadline = Date.now() + 15000;
    while (true) {
      const result = await op("OP_290_LIST");
      assert(result.success);
      const workers = (result.output as { workers: Worker[] }).workers;
      const worker = workers.find(item => item.name === name);
      if (worker?.status === "failed" && !worker.live && worker.cleanup === "drained") return { worker, workers };
      assert(Date.now() < deadline, `Worker did not fail/drain: ${JSON.stringify(worker)}`);
      await Bun.sleep(50);
    }
  };
  assert((await op("OP_290_FAILURE")).success);
  const afterWrite = (await waitFailed("failure")).worker;
  assert.equal(readFileSync(file, "utf8"), "failure-written\n");
  assert.equal(afterWrite.localEffects.observedWrites, 1);
  assert.equal(afterWrite.localEffects.attempts, 1);
  assert.deepEqual(afterWrite.localEffects.tools, ["str_replace"]);
  assert.equal(afterWrite.effects, "unknown", "Provider failure cannot erase an observed edit or prove all effects");
  assert((await op("OP_290_EARLY")).success);
  const { worker: beforeTools, workers } = await waitFailed("early-failure");
  assert.equal(beforeTools.localEffects.observedWrites, 0);
  assert.equal(beforeTools.localEffects.attempts, 0);
  assert.deepEqual(beforeTools.localEffects.tools, []);
  assert.equal(readFileSync(file, "utf8"), "failure-written\n");
  const readonly = workers.find(item => item.name === "readonly");
  assert(readonly);
  assert.equal(readonly.workspace.readOnly, true);
  assert.equal(readonly.workspace.writeCapable, false);
  assert.equal(readonly.localEffects.observedWrites, 0);
  assert((await op("OP_290_STOPALL")).success);
  const proof = await session.forceStop();
  assert.deepEqual(proof, { processExited: true, resourcesStopped: true, quarantined: false });
  console.log(JSON.stringify({ builtCli: cli, loopbackRequests: requests, publicSpawnListStop: true, observedChildEdit: true,
    stoppedShellStable: true, readOnlyEnforced: true, sharedWriterBoundEnforced: true, failedWorkersObservedBeforeAndAfterWrite: true, ownershipProof: proof }));
} finally {
  const cleanup = session ? await Promise.allSettled([session.cleanup()]) : [];
  server.stop(true);
  if (cleanup.every(result => result.status === "fulfilled")) rmSync(root, { recursive: true, force: true });
  assert(cleanup.every(result => result.status === "fulfilled"), `Unconfirmed teardown; retained ${root}`);
}

/** Native release qualification. No preload, real credentials, or external traffic. */
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LlmApiRuntime } from "../packages/engine/dist/index.js";
import { osecDB } from "../packages/engine/dist/storage/index.js";
import { createHostConsoleSession, type HostConsoleSession } from "../packages/cli/src/host-console-session.js";

if (!process.versions.bun) throw new Error("This qualification requires an actual Bun parent");
if (!["darwin", "linux"].includes(process.platform)) {
  console.log("Skipped native host-worker qualification: this platform has no qualified process ownership boundary");
  process.exit(0);
}
if (!process.argv[2]) throw new Error("Usage: bun scripts/check-host-console-worker-bun.ts <compiled-release-binary>");
const root = mkdtempSync(join(tmpdir(), "0-native-host-worker-"));
const binary = join(root, "0");
copyFileSync(resolve(process.argv[2]), binary); chmodSync(binary, 0o700);
// Only this standalone qualification process changes its own HOME.
process.env.HOME = root;
let requests = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  assert.equal(new URL(request.url).pathname, "/v1/responses");
  assert.equal(request.headers.get("authorization"), "Bearer synthetic-loopback-only");
  const body = await request.json() as { model?: string };
  assert.equal(body.model, "gpt-native-fixture"); requests++; assert(requests <= 8, "Unexpected unbounded synthetic provider traffic");
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
    id: `loopback-${requests}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Compiled worker request completed" }] }],
    usage: { input_tokens: 3, output_tokens: 2 },
  } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
} });
const sessions: HostConsoleSession[] = [];
try {
  const selected = new LlmApiRuntime({ type: "api", timeout: 5000, provider: "openai", model: "gpt-native-fixture", env: {
    OPENAI_API_KEY: "synthetic-loopback-only", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`, OPENAI_WIRE_API: "responses", ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_LLM_FALLBACK: "",
  } });
  const create = (scanId: string) => {
    const session = createHostConsoleSession({
      config: { runtime: selected, scanId, workspaceRoot: root, codebaseLearning: false, refineObjective: false, autonomyMode: "yolo" }, dbPath: join(root, "selected.db"),
      executionEnvironment: { ZERO_0VERSE_MCP: "0", ZERO_DISABLE_HUNT_MEMORY: "1", ZERO_NO_TELEMETRY: "1" },
      launch: { command: binary, args: ["--host-console-worker"], cwd: root, env: { PATH: process.env.PATH, HOME: root }, graceMs: 100 },
    }); sessions.push(session); return session;
  };
  const first = create("compiled-worker-first"); await first.ready;
  assert.equal((await first.send("Synthetic loopback request only")).assistantText, "Compiled worker request completed");
  const firstRequests = requests; assert(firstRequests >= 1);
  assert.deepEqual(await first.forceStop(), { processExited: true, resourcesStopped: true, quarantined: false });
  await Bun.sleep(100); assert.equal(requests, firstRequests, "Stopped execution dispatched another provider request");
  const db = new osecDB(join(root, "selected.db"));
  db.createScan({ target: "native-lock-recovery-fixture", depth: "quick", format: "json", runtime: "api" }, "compiled-worker-followup");
  assert.equal(db.getScan("compiled-worker-followup")?.target, "native-lock-recovery-fixture"); db.close();
  const other = create("compiled-worker-other"); await other.ready;
  assert.equal((await other.send("Another compiled worker remains usable")).assistantText, "Compiled worker request completed");
  assert(requests > firstRequests, "The second compiled worker did not reach the loopback provider");
  console.log(JSON.stringify({ nativeWorker: "qualified", privateBootstrap: true, confirmedExit: true, databaseWritable: true, loopbackRequests: requests }));
} finally {
  const cleanup = await Promise.allSettled(sessions.map(session => session.cleanup()));
  server.stop(true); rmSync(root, { recursive: true, force: true });
  assert(cleanup.every(result => result.status === "fulfilled"), "Native worker teardown was not confirmed");
}

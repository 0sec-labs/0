/** Real CLI → authenticated HTTP engine integration; no model, provider account, or workflow execution. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = resolve(process.argv[2] ?? join(repo, "dist/0.js"));
const command = /\.[cm]?js$/.test(cli) ? process.execPath : cli;
const prefix = command === cli ? [] : [cli];
const temporary = await mkdtemp(join(tmpdir(), "zero-api-engine-"));
const home = join(temporary, "home"), workspace = join(temporary, "workspace"), assets = join(temporary, "assets");
await Promise.all([home, workspace, assets].map(path => mkdir(path)));
await writeFile(join(assets, "index.html"), "<!doctype html><html><head></head><body>Isolated API integration</body></html>");
// Deliberately do not inherit provider keys, account/session paths, backend registries, or team configuration.
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"),
  TMPDIR: temporary, LANG: "en_US.UTF-8", NO_COLOR: "1", CI: "1",
  ZERO_OFFLINE: "1", ZERO_NO_UPDATE_CHECK: "1", ZERO_ANALYTICS_LEVEL: "off", DO_NOT_TRACK: "1", ZERO_0VERSE_MCP: "0",
  TEST_ENGINE_TOKEN: randomBytes(32).toString("hex"),
};
let output = "", errors = "";
const server = spawn(command, [...prefix, "web", "--port", "0", "--no-open", "--ready-json", "--engine-token-env", "TEST_ENGINE_TOKEN", "--engine-workspace", workspace, "--db-path", join(temporary, "control.db"), "--asset-dir", assets], { env, cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", data => { output = (output + data).slice(-200_000); });
server.stderr.on("data", data => { errors = (errors + data).slice(-200_000); });
const exited = new Promise(resolve => server.once("exit", (code, signal) => resolve({ code, signal })));
let url;
try {
  const deadline = Date.now() + 30_000;
  while (!url) {
    const match = output.match(/ZERO_DASHBOARD_READY (\{[^\n]+\})/);
    if (match) { url = JSON.parse(match[1]).url; break; }
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Engine exited before ready: ${errors || output}`);
    if (Date.now() >= deadline) throw new Error(`Engine readiness timed out: ${errors || output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const api = async (path, method = "GET", body, expected = 200, overrides = {}) => {
    const args = [...prefix, "api", ...(path ? [path] : []), "--engine-url", url, "--engine-token-env", "TEST_ENGINE_TOKEN", "--method", method];
    if (body !== undefined) args.push("--data", typeof body === "string" ? body : JSON.stringify(body));
    let result;
    try { result = await run(command, args, { env: { ...env, ...overrides }, cwd: workspace, timeout: 20_000, maxBuffer: 2_000_000 }); }
    catch (error) { result = error; }
    const stdout = result.stdout?.trim();
    const response = stdout ? JSON.parse(stdout) : JSON.parse(result.stderr?.trim() || "{}");
    assert.equal(response.status, expected, `${method} ${path ?? "handshake"}: ${JSON.stringify(response)}`);
    assert.equal(response.ok, expected >= 200 && expected < 300);
    assert.equal(result.code === undefined || result.code === 0, expected >= 200 && expected < 300, "CLI exit status must match HTTP success");
    return response.data;
  };
  const handshake = await api();
  assert.equal(handshake.protocolVersion, 1);
  assert.ok(handshake.capabilities.includes("sessions"));
  assert.ok(handshake.capabilities.includes("learning"));
  assert.ok(handshake.capabilities.includes("schedules"));
  // Both read and write routes must reject missing/wrong credentials without changing the store.
  for (const method of ["GET", "POST"]) {
    const denied = await fetch(`${url}/api/console/sessions`, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "must not exist" }) } : {}) });
    assert.equal(denied.status, 403);
  }
  await api("/api/console/sessions", "GET", undefined, 503, { TEST_ENGINE_TOKEN: "wrong-token-".repeat(4) });
  const wrongCredential = await fetch(`${url}/api/console/sessions`, { headers: { Authorization: `Bearer ${"wrong-token-".repeat(4)}` } });
  assert.equal(wrongCredential.status, 403);
  const identityMismatch = await fetch(`${url}/api/console/sessions`, { headers: { Authorization: `Bearer ${env.TEST_ENGINE_TOKEN}`, "X-0-Expected-Engine-ID": "different-engine" } });
  assert.equal(identityMismatch.status, 409);
  assert.deepEqual((await api("/api/console/sessions")).sessions, []);
  const registryPath = join(temporary, "backends.json");
  await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, backends: [{ id: "isolated", name: "Isolated integration", url, bearerTokenEnv: "TEST_ENGINE_TOKEN", expectedEngineId: handshake.engineId }] }));
  const registered = await run(command, [...prefix, "api", "/api/console/sessions", "--backend", "isolated", "--backends-config", registryPath], { env, cwd: workspace, timeout: 20_000 });
  assert.deepEqual(JSON.parse(registered.stdout), { ok: true, status: 200, data: { sessions: [] } });
  const draftPath = join(temporary, "session-draft.json");
  await writeFile(draftPath, JSON.stringify({ title: "API integration draft", target: workspace }));
  const created = (await api("/api/console/sessions", "POST", `@${draftPath}`, 201)).session;
  const sessionPath = `/api/console/sessions/${encodeURIComponent(created.id)}`;
  assert.equal((await api(`${sessionPath}/configuration`, "PATCH", { title: "Renamed without a model" })).session.title, "Renamed without a model");
  const snapshot = (await api(sessionPath)).snapshot;
  assert.equal(snapshot.session.title, "Renamed without a model");
  assert.equal(snapshot.usage.inputTokens + snapshot.usage.outputTokens, 0);
  assert.equal(snapshot.messages.length, 0);
  const saved = (await api(`${sessionPath}/save`, "POST", {})).session;
  const savedPath = `/api/console/saved/${encodeURIComponent(saved.id)}`;
  assert.deepEqual((await api(savedPath)).messages, []);
  assert.ok((await api("/api/console/saved")).sessions.some(row => row.id === saved.id));
  const definition = (await api("/api/console/workflow-definitions", "POST", {
    name: "Paused API integration", instructions: "Storage integration only; never execute.", target: `source:${workspace}`,
    nodes: [{ id: "start", type: "trigger", label: "Start", enabled: true }, { id: "audit", type: "audit", label: "Audit", enabled: true }], edges: [{ source: "start", target: "audit" }],
  }, 201)).definition;
  const schedule = (await api("/api/console/workflow-triggers", "POST", {
    workflowId: definition.id, workflowRevision: definition.revision, sessionId: created.id,
    cadence: "daily", startAt: "2035-01-01T00:00:00.000Z", timezone: "UTC", enabled: false,
  }, 201)).trigger;
  assert.equal(schedule.enabled, false);
  const triggerPath = `/api/console/workflow-triggers/${encodeURIComponent(schedule.id)}`;
  const patched = (await api(triggerPath, "PATCH", { cadence: "weekly", expectedVersion: schedule.version })).trigger;
  assert.equal(patched.cadence, "weekly"); assert.equal(patched.enabled, false);
  await api(triggerPath, "PATCH", { enabled: true }, 400);
  const listed = (await api("/api/console/workflow-triggers")).triggers;
  assert.equal(listed.length, 1); assert.equal(listed[0].enabled, false);
  const learning = await api("/api/console/learning?limit=10");
  for (const key of ["events", "knowledge", "improvements"]) assert.ok(Array.isArray(learning[key]));
  assert.deepEqual((await api("/api/console/workflow-executions")).executions, []);
  assert.equal((await api(triggerPath, "DELETE")).deleted, true);
  assert.deepEqual((await api("/api/console/workflow-triggers")).triggers, []);
  await api(`/api/console/workflow-definitions/${encodeURIComponent(definition.id)}?revision=${definition.revision}`, "DELETE");
  const archived = (await api(`${sessionPath}/archive`, "POST", {})).session;
  assert.equal(archived.archived, true);
  assert.equal(Boolean((await api(`${savedPath}/archive`, "POST", { archived: false })).session.archived), false);
  await api(savedPath, "DELETE");
  assert.deepEqual((await api("/api/console/saved")).sessions, []);
  console.log("API engine integration passed: real CLI handshake; credential/identity gates; session create/configure/read/save/archive/delete; learning read; paused schedule CRUD; no model turns or workflow executions.");
} finally {
  server.kill("SIGTERM");
  const stopped = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
  if (!stopped) { server.kill("SIGKILL"); await exited; }
  await rm(temporary, { recursive: true, force: true });
}

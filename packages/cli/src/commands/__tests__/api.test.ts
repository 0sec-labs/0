import { afterEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerApiCommand, runApiCommand, type ApiCommandOptions } from "../api.js";

const servers: Server[] = [];
const directories: string[] = [];
const token = "test-token-".repeat(4);
const handshake = { protocolVersion: 1, engineId: "engine-api-test", capabilities: ["sessions", "workflows", "approvals", "events", "workspaces", "model-connections", "workflow-engine", "operator-services", "process-controls", "artifacts"], platform: { os: "linux", pathStyle: "posix" } };
function directory() { const path = mkdtempSync(join(tmpdir(), "0-api-test-")); directories.push(path); return path; }
async function engine(handler?: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const calls: Array<{ path: string; method: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    calls.push({ path: req.url!, method: req.method!, headers: req.headers, body });
    res.setHeader("X-0-Engine-ID", handshake.engineId);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/backend/handshake") { res.end(JSON.stringify(handshake)); return; }
    if (handler) handler(req, res, body);
    else res.end(JSON.stringify({ method: req.method, body: body ? JSON.parse(body) : null }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return { calls, url: `http://127.0.0.1:${address.port}` };
}
async function invoke(path: string | undefined, options: ApiCommandOptions, env: NodeJS.ProcessEnv = { API_TEST_TOKEN: token }) {
  const stdout: string[] = []; const stderr: string[] = []; let exitCode = 0;
  await runApiCommand(path, options, { env, out: value => stdout.push(value), err: value => stderr.push(value), setExitCode: value => { exitCode = value; } });
  return { stdout: stdout.map(value => JSON.parse(value)), stderr: stderr.map(value => JSON.parse(value)), exitCode };
}
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe("deterministic engine API command", () => {
  it("registers the command and defaults to authenticated discovery", async () => {
    const remote = await engine(); const stdout: string[] = [];
    const command = new Command();
    registerApiCommand(command, { env: { API_TEST_TOKEN: token }, out: text => stdout.push(text), err: text => { throw new Error(text); } });
    await command.parseAsync(["api", "--engine-url", remote.url, "--engine-token-env", "API_TEST_TOKEN"], { from: "user" });
    expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, status: 200, data: handshake });
    expect(remote.calls.every(call => call.headers.authorization === `Bearer ${token}`)).toBe(true);
  });
  it("pins the engine identity and performs a JSON mutation", async () => {
    const remote = await engine();
    const result = await invoke("/api/console/settings", { engineUrl: remote.url, engineTokenEnv: "API_TEST_TOKEN", method: "PATCH", data: '{"key":"theme","value":"dark"}' });
    expect(result).toMatchObject({ stdout: [{ ok: true, status: 200, data: { method: "PATCH", body: { key: "theme", value: "dark" } } }], stderr: [], exitCode: 0 });
    expect(remote.calls.map(call => call.path)).toEqual(["/api/backend/handshake", "/api/console/settings"]);
    expect(remote.calls[1]!.headers["x-0-expected-engine-id"]).toBe(handshake.engineId);
    expect(remote.calls[1]!.headers["content-type"]).toBe("application/json");
  });
  it("reads through a registered backend with explicit configuration", async () => {
    const remote = await engine(); const configPath = join(directory(), "backends.json");
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, backends: [{ id: "registered", name: "Test", url: remote.url, bearerTokenEnv: "API_TEST_TOKEN", expectedEngineId: handshake.engineId }] }));
    const result = await invoke("/api/console/sessions?limit=2", { backend: "registered", backendsConfig: configPath });
    expect(result.exitCode).toBe(0);
    expect(remote.calls[1]!.path).toBe("/api/console/sessions?limit=2");
  });
  it("keeps HTTP errors machine-readable and returns nonzero", async () => {
    const remote = await engine((_req, res) => { res.statusCode = 403; res.end(JSON.stringify({ error: "Forbidden" })); });
    const result = await invoke("/api/console/sessions", { engineUrl: remote.url, engineTokenEnv: "API_TEST_TOKEN" });
    expect(result.stdout).toEqual([{ ok: false, status: 403, data: { error: "Forbidden" } }]);
    expect(result.stderr[0]).toMatchObject({ ok: false, status: 403 });
    expect(result.exitCode).toBe(2);
  });
  it.each([
    { method: "TRACE" }, { method: "GET", data: "{}" }, { method: "POST", data: "not JSON" },
    { method: "POST", data: JSON.stringify("x".repeat(1_000_000)) },
    { backend: "other" }, { engineTokenEnv: undefined },
  ])("rejects malformed options before engine calls: %j", async patch => {
    const remote = await engine();
    const result = await invoke("/api/console/sessions", { engineUrl: remote.url, engineTokenEnv: "API_TEST_TOKEN", ...patch });
    expect(result.exitCode).toBe(2); expect(result.stdout).toEqual([]); expect(remote.calls).toEqual([]);
  });
  it.each(["/api/console/%2e%2e/sessions", "/api/console/a%2fb", "/api/console/%ZZ", "/api/console/sessions#fragment", "/api/backends", "https://example.com/api/console/sessions"]) ("rejects invalid path before engine calls: %s", async path => {
    const remote = await engine();
    const result = await invoke(path, { engineUrl: remote.url, engineTokenEnv: "API_TEST_TOKEN" });
    expect(result.exitCode).toBe(2); expect(remote.calls).toEqual([]);
  });
  it("requires an explicit selector and available token", async () => {
    expect((await invoke(undefined, {})).exitCode).toBe(2);
    const remote = await engine();
    const result = await invoke(undefined, { engineUrl: remote.url, engineTokenEnv: "API_TEST_TOKEN" }, {});
    expect(result.exitCode).toBe(2); expect(remote.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it("reads bounded JSON files and rejects directories and oversized files before I/O", async () => {
    const remote = await engine(); const dir = directory(); const path = join(dir, "data.json");
    writeFileSync(path, '{"approved":true}');
    const base = { engineUrl: remote.url, engineTokenEnv: "API_TEST_TOKEN", method: "POST" };
    expect((await invoke("/api/console/sessions", { ...base, data: `@${path}` })).exitCode).toBe(0);
    expect(JSON.parse(remote.calls[1]!.body)).toEqual({ approved: true });
    remote.calls.length = 0;
    expect((await invoke("/api/console/sessions", { ...base, data: `@${dir}` })).exitCode).toBe(2);
    writeFileSync(path, " ".repeat(1_000_001));
    expect((await invoke("/api/console/sessions", { ...base, data: `@${path}` })).exitCode).toBe(2);
    expect(remote.calls).toEqual([]);
  });
  it("never follows redirects", async () => {
    const remote = await engine((_req, res) => { res.statusCode = 302; res.setHeader("Location", "/api/console/redirected"); res.end(); });
    expect((await invoke("/api/console/sessions", { engineUrl: remote.url, engineTokenEnv: "API_TEST_TOKEN" })).exitCode).toBe(2);
    expect(remote.calls.map(call => call.path)).toEqual(["/api/backend/handshake", "/api/console/sessions"]);
  });
  it("preserves text exports and empty HEAD/204 bodies in the envelope", async () => {
    const remote = await engine((req, res) => {
      if (req.method === "DELETE") { res.statusCode = 204; res.end(); }
      else { res.setHeader("Content-Type", "text/markdown"); res.end("# Export\n"); }
    });
    const base = { engineUrl: remote.url, engineTokenEnv: "API_TEST_TOKEN" };
    expect((await invoke("/api/console/sessions", base)).stdout[0].data).toBe("# Export\n");
    expect((await invoke("/api/console/sessions", { ...base, method: "HEAD" })).stdout[0].data).toBeNull();
    expect((await invoke("/api/console/sessions", { ...base, method: "DELETE" })).stdout[0]).toEqual({ ok: true, status: 204, data: null });
  });
  it("rejects malformed response JSON and mismatched response identity", async () => {
    const remote = await engine((_req, res) => { res.end("malformed"); });
    const base = { engineUrl: remote.url, engineTokenEnv: "API_TEST_TOKEN" };
    const malformed = await invoke("/api/console/sessions", base);
    expect(malformed.exitCode).toBe(2); expect(malformed.stderr[0].error).toContain("malformed JSON");
    const other = await engine((_req, res) => { res.setHeader("X-0-Engine-ID", "other-engine"); res.end("{}"); });
    const mismatch = await invoke("/api/console/sessions", { ...base, engineUrl: other.url });
    expect(mismatch.exitCode).toBe(2); expect(mismatch.stderr[0].status).toBe(409);
  });
  it("enforces discovered capabilities and never sends an unsupported mutation", async () => {
    const remote = await engine();
    const stdout: string[] = []; const stderr: string[] = []; let code = 0;
    await runApiCommand("/api/console/settings", { engineUrl: remote.url, engineTokenEnv: "API_TEST_TOKEN", method: "PATCH", data: "{}" }, {
      env: { API_TEST_TOKEN: token },
      fetch: async (url, options) => {
        const response = await fetch(url, options);
        if (String(url).endsWith("/api/backend/handshake")) return Response.json({ ...handshake, capabilities: [] });
        return response;
      }, out: text => stdout.push(text), err: text => stderr.push(text), setExitCode: value => { code = value; },
    });
    expect(code).toBe(2); expect(stdout).toEqual([]);
    expect(JSON.parse(stderr[0]!).status).toBe(409);
    expect(remote.calls.map(call => call.path)).toEqual(["/api/backend/handshake"]);
  });
  it("rejects a registered backend without a token before sending any HTTP request", async () => {
    const remote = await engine(); const configPath = join(directory(), "backends.json");
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, backends: [{ id: "missing-token", name: "Test", url: remote.url, bearerTokenEnv: "UNAVAILABLE_TEST_TOKEN" }] }));
    expect((await invoke("/api/console/sessions", { backend: "missing-token", backendsConfig: configPath }, {})).exitCode).toBe(2);
    expect(remote.calls).toEqual([]);
  });
});

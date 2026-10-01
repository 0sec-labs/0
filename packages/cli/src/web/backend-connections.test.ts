import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { BackendHandshake } from "@0/shared";
import { BackendConnectionRegistry, createBackendHandshake, handleBackendConnectionRequest, loadBackendConnectionConfig } from "./backend-connections.js";
const temporary: string[] = [];
const registries: BackendConnectionRegistry[] = [];
const servers: Server[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "0-backends-")); temporary.push(path); return path; }
const handshake = (engineId = "engine-a", capabilities = ["sessions", "workflows", "approvals", "events", "workspaces", "model-connections", "workflow-engine", "operator-services", "process-controls", "artifacts"]): BackendHandshake => ({ protocolVersion: 1, engineId, capabilities, platform: { os: "linux", pathStyle: "posix" } });
function response(value: unknown, engineId = "engine-a", type = "application/json") { return new Response(JSON.stringify(value), { headers: { "Content-Type": type, "X-0-Engine-ID": engineId } }); }
function fixture(capabilities?: string[]) {
  const call = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith("/api/backend/handshake")) return response(handshake("engine-a", capabilities));
    return response({ url: String(url), headers: Object.fromEntries(new Headers(options?.headers)), body: options?.body });
  });
  const registry = new BackendConnectionRegistry({ connections: [{ id: "remote", name: "Remote", url: "http://127.0.0.1:12345/", bearerTokenEnv: "REMOTE_TOKEN" }], env: { REMOTE_TOKEN: "a".repeat(32) }, fetch: call, localHandshake: handshake("local-engine") });
  registries.push(registry); return { registry, call };
}
afterEach(async () => { for (const registry of registries.splice(0)) registry.dispose(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe("trusted backend registry", () => {
  it("persists random engine identity per database while rotating connection epochs", () => {
    const path = directory();
    const a = createBackendHandshake(join(path, "a.db")); const restarted = createBackendHandshake(join(path, "a.db")); const b = createBackendHandshake(join(path, "b.db"));
    expect(a.engineId).toBe(restarted.engineId); expect(a.serverInstanceId).not.toBe(restarted.serverInstanceId); expect(a.engineId).not.toBe(b.engineId);
  });
  it("accepts trusted HTTPS and SSH-loopback URLs but refuses arbitrary HTTP and embedded secrets", () => {
    const path = join(directory(), "connections.json");
    for (const url of ["http://example.com", "https://user:secret@example.com", "https://example.com?token=secret", "file:///tmp/backend"]) {
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, backends: [{ id: "remote", name: "Remote", url, bearerTokenEnv: "REMOTE_TOKEN" }] }));
      expect(() => loadBackendConnectionConfig(path)).toThrow();
    }
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, backends: [{ id: "remote", name: "Remote", url: "https://engine.example.com", bearerTokenEnv: "REMOTE_TOKEN" }] }));
    expect(loadBackendConnectionConfig(path)[0]!.id).toBe("remote");
  });
  it("omits endpoints, credential references and bearer secrets from browser descriptors", async () => {
    const { registry } = fixture(); await registry.handshake("remote");
    const publicJson = JSON.stringify(registry.list());
    expect(publicJson).not.toContain("127.0.0.1"); expect(publicJson).not.toContain("REMOTE_TOKEN"); expect(publicJson).not.toContain("a".repeat(32));
  });
  it("pins peer identity and fails incompatible versions before dispatch", async () => {
    const { registry, call } = fixture(); await registry.handshake("remote");
    call.mockImplementation(async () => response(handshake("engine-b"), "engine-b"));
    expect((await registry.handshake("remote")).backend.status).toBe("incompatible");
    await expect(registry.request("remote", "/api/console/sessions")).rejects.toThrow("identity changed");
    call.mockImplementation(async () => response({ ...handshake("engine-a"), protocolVersion: 2 }));
    expect((await registry.handshake("remote")).backend.status).toBe("incompatible");
  });
  it("requires response identity even while the handshake is cached", async () => {
    const { registry, call } = fixture(); await registry.handshake("remote");
    call.mockImplementation(async () => response({ ok: true }, "engine-b"));
    await expect(registry.request("remote", "/api/console/sessions", { method: "POST", body: {} })).rejects.toThrow("identity");
    expect(new Headers(call.mock.calls.at(-1)![1]!.headers).get("x-0-expected-engine-id")).toBe("engine-a");
  });
  it("enforces actual decision/model/project/fix capabilities and rejects hostile paths", async () => {
    const { registry, call } = fixture(["sessions", "workflows"]);
    await registry.handshake("remote"); const before = call.mock.calls.length;
    for (const path of ["/api/console/sessions/same-id/decisions/approval", "/api/console/models", "/api/console/project", "/api/console/fixes/apply", "/api/console/fixes/publish"]) await expect(registry.request("remote", path, { method: "POST", body: {} })).rejects.toThrow("does not support");
    for (const path of ["//evil.example/api", "/api/../backends", "/api/console/%2e%2e/backend", "/api/console/%2fbackend", "/api/backends/other/proxy/api/console/sessions", "/api/unknown", "/api/control/not-real"]) await expect(registry.request("remote", path)).rejects.toThrow();
    await expect(registry.request("unregistered", "/api/console/sessions")).rejects.toThrow("not registered");
    expect(call.mock.calls.length).toBe(before);
  });
  it("bounds bodies and response streams and sanitizes transport failures", async () => {
    const { registry, call } = fixture(); await registry.handshake("remote");
    await expect(registry.request("remote", "/api/console/sessions", { method: "POST", body: "x".repeat(1_000_001) })).rejects.toThrow("exceeds");
    call.mockImplementation(async () => new Response(new Uint8Array(16_000_001), { headers: { "X-0-Engine-ID": "engine-a" } }));
    await expect(registry.request("remote", "/api/console/sessions")).rejects.toThrow("response exceeds");
    call.mockImplementation(async () => { throw new Error("secretBearer:a" + "a".repeat(31)); });
    expect((await registry.handshake("remote")).error).toBe("Backend transport failed.");
  });
  it("holds capacity for live SSE streams, releases slots on cancel, and forwards only safe replay headers", async () => {
    const { registry, call } = fixture(); await registry.handshake("remote");
    call.mockImplementation(async () => new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream", "X-0-Engine-ID": "engine-a" } }));
    const responses: Response[] = [];
    for (let i = 0; i < 32; i++) responses.push(await registry.request("remote", "/api/v1/presentation/events", { stream: true, lastEventId: "cursor-42", requestId: "request-42" }));
    await expect(registry.request("remote", "/api/v1/presentation/events", { stream: true })).rejects.toThrow("capacity");
    const headers = new Headers(call.mock.calls.at(-1)![1]!.headers); expect(headers.get("last-event-id")).toBe("cursor-42"); expect(headers.get("x-0-request-id")).toBe("request-42"); expect(headers.get("authorization")).toBe(`Bearer ${"a".repeat(32)}`);
    await responses.shift()!.body!.cancel();
    responses.push(await registry.request("remote", "/api/v1/presentation/events", { stream: true }));
    await Promise.all(responses.map(item => item.body!.cancel()));
    await expect(registry.request("remote", "/api/v1/presentation/events", { stream: true, lastEventId: "cursor\r\nAuthorization:evil" })).rejects.toThrow("cursor");
  });
  it("aborts SSE transport on disconnect without sending a workflow cancellation", async () => {
    const { registry, call } = fixture(); await registry.handshake("remote");
    const cancelled = vi.fn();
    call.mockImplementation(async () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { "Content-Type": "text/event-stream", "X-0-Engine-ID": "engine-a" } }));
    const abort = new AbortController();
    const stream = await registry.request("remote", "/api/v1/presentation/events", { stream: true, signal: abort.signal });
    abort.abort();
    await expect(stream.text()).rejects.toThrow("connection closed");
    expect(cancelled).toHaveBeenCalled(); expect(call.mock.calls.some(([url]) => String(url).includes("cancel"))).toBe(false);
  });
  it("bounds individual SSE events before forwarding oversized data", async () => {
    const { registry, call } = fixture(); await registry.handshake("remote");
    call.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(1_000_001)}`)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream", "X-0-Engine-ID": "engine-a" } }));
    const stream = await registry.request("remote", "/api/v1/presentation/events", { stream: true });
    await expect(stream.text()).rejects.toThrow("event exceeds");
  });
  it("isolates credentials across two same-ID engines through the HTTP proxy", async () => {
    const records: Array<{ authorization?: string; cookie?: string; browserToken?: string; cursor?: string; expected?: string }> = [];
    const upstream = createServer((req, res) => { records.push({ authorization: req.headers.authorization, cookie: req.headers.cookie, browserToken: req.headers["x-0-control-token"] as string, cursor: req.headers["last-event-id"] as string, expected: req.headers["x-0-expected-engine-id"] as string }); res.setHeader("X-0-Engine-ID", req.url!.startsWith("/a/") ? "engine-a" : "engine-b"); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(req.url!.endsWith("handshake") ? handshake(req.url!.startsWith("/a/") ? "engine-a" : "engine-b") : { id: "same-id" })); }); servers.push(upstream);
    await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done)); const address = upstream.address() as { port: number };
    const registry = new BackendConnectionRegistry({ connections: ["a", "b"].map(id => ({ id, name: id, url: `http://127.0.0.1:${address.port}/${id}/`, bearerTokenEnv: `${id.toUpperCase()}_TOKEN` })), env: { A_TOKEN: "a".repeat(32), B_TOKEN: "b".repeat(32) }, localHandshake: handshake("local-engine") }); registries.push(registry);
    const proxy = createServer(async (req, res) => { try { const result = await handleBackendConnectionRequest(req, res, new URL(req.url!, "http://localhost"), registry); if (!result.handled) { res.statusCode = 404; res.end(); } } catch (error) { res.statusCode = 500; res.end(String(error)); } }); servers.push(proxy);
    await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done)); const proxyAddress = proxy.address() as { port: number };
    for (const id of ["a", "b"]) { const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/api/backends/${id}/proxy/api/console/sessions/same-id`, { headers: { "X-0-Control-Token": "browser-secret", Cookie: "browser-cookie", Origin: "http://browser-origin" } }); expect(response.status).toBe(200); }
    expect(records.every(row => !row.cookie && !row.browserToken)).toBe(true);
    expect(records.filter(row => row.expected).map(row => [row.authorization, row.expected])).toEqual([[`Bearer ${"a".repeat(32)}`, "engine-a"], [`Bearer ${"b".repeat(32)}`, "engine-b"]]);
  });
});

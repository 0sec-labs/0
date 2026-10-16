import { createServer, type Server } from "node:http";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLocalEngineAvailable, connectLocalEngine, localEngineDescriptorPath, registerLocalEngine, type LocalEngineRegistration } from "./local-engine.js";

const roots: string[] = [];
const servers: Server[] = [];
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), "0-local-engine-")); roots.push(homeDir);
  const workspace = join(homeDir, "workspace"); mkdirSync(workspace);
  const dbPath = join(homeDir, "engine.db");
  return { homeDir, workspace, dbPath };
}
function descriptor(workspace: string, overrides: Partial<LocalEngineRegistration> = {}): LocalEngineRegistration {
  return { url: "http://127.0.0.1:1/", token: "fixture-token".repeat(4), engineId: "fixture-engine", serverInstanceId: "fixture-epoch", pid: process.pid, workspace, ...overrides };
}
async function server(input: LocalEngineRegistration) {
  let epoch = input.serverInstanceId;
  const calls: string[] = [];
  const instance = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("X-0-Engine-ID", input.engineId);
    if (request.headers.authorization !== `Bearer ${input.token}`) { response.writeHead(403); response.end(JSON.stringify({ error: "Unauthorized" })); return; }
    if (request.url === "/api/backend/handshake") {
      response.end(JSON.stringify({ protocolVersion: 1, engineId: input.engineId, serverInstanceId: epoch, capabilities: ["workflow-engine"], platform: { os: "fixture", pathStyle: "posix" } })); return;
    }
    if (request.headers["x-0-expected-engine-id"] !== input.engineId) { response.writeHead(409); response.end('{}'); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const { name } = JSON.parse(Buffer.concat(chunks).toString()); calls.push(name);
    response.end(JSON.stringify(name === "list_templates" ? [{ id: "engine-owned" }] : []));
  });
  servers.push(instance); await new Promise<void>(done => instance.listen(0, "127.0.0.1", done));
  const address = instance.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  return { url: `http://127.0.0.1:${address.port}/`, calls, setEpoch: (value: string) => { epoch = value; } };
}

describe("secure local engine discovery", () => {
  it("registers private metadata and attaches without changing ambient credentials", async () => {
    const paths = fixture(); const input = descriptor(paths.workspace); const peer = await server(input);
    const unregister = registerLocalEngine({ ...input, url: peer.url }, paths.dbPath, paths); cleanup.push(unregister);
    const path = localEngineDescriptorPath(paths.dbPath, paths.homeDir);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
    const before = process.env.LOCAL_ENGINE_DISCOVERY_TOKEN;
    const runtime = await connectLocalEngine(paths); expect(runtime).not.toBeNull(); cleanup.push(runtime!.dispose);
    expect(await runtime!.listTemplates()).toEqual([{ id: "engine-owned" }]);
    expect(peer.calls).toEqual(["list_templates"]);
    expect(process.env.LOCAL_ENGINE_DISCOVERY_TOKEN).toBe(before);
  });
  it("blocks database recovery before a second server can touch live history", () => {
    const paths = fixture();
    expect(() => assertLocalEngineAvailable(paths.dbPath, paths.homeDir)).not.toThrow();
    cleanup.push(registerLocalEngine(descriptor(paths.workspace, { url: "http://127.0.0.2:1/" }), paths.dbPath, paths));
    expect(() => assertLocalEngineAvailable(paths.dbPath, paths.homeDir)).toThrow("already owns this database");
  });
  it("leaves a live unreachable owner intact and refuses a replacement host", async () => {
    const paths = fixture(); cleanup.push(registerLocalEngine(descriptor(paths.workspace), paths.dbPath, paths));
    await expect(connectLocalEngine(paths)).rejects.toThrow("no replacement host was started");
    expect(existsSync(localEngineDescriptorPath(paths.dbPath, paths.homeDir))).toBe(true);
    expect(() => registerLocalEngine(descriptor(paths.workspace), paths.dbPath, paths)).toThrow("already owns");
  });
  it("removes stale metadata only after the PID is proven dead", async () => {
    const paths = fixture(); const unregister = registerLocalEngine(descriptor(paths.workspace, { pid: 999999 }), paths.dbPath, paths);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("No such process"), { code: "ESRCH" }); });
    expect(await connectLocalEngine(paths)).toBeNull();
    expect(existsSync(localEngineDescriptorPath(paths.dbPath, paths.homeDir))).toBe(false);
    unregister();
  });
  it("never considers permission denial proof that a PID is dead", async () => {
    const paths = fixture(); cleanup.push(registerLocalEngine(descriptor(paths.workspace), paths.dbPath, paths));
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Permission denied"), { code: "EPERM" }); });
    await expect(connectLocalEngine(paths)).rejects.toThrow("no replacement");
  });
  it("cleanup preserves a replacement registration with a different nonce", () => {
    const paths = fixture(); const unregister = registerLocalEngine(descriptor(paths.workspace), paths.dbPath, paths);
    const path = localEngineDescriptorPath(paths.dbPath, paths.homeDir);
    const original = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...original, nonce: "00000000-0000-4000-8000-000000000000" }));
    unregister(); expect(existsSync(path)).toBe(true);
  });
  it("rejects symlinks, public permissions and oversized secret descriptors", async () => {
    const paths = fixture(); registerLocalEngine(descriptor(paths.workspace), paths.dbPath, paths);
    const path = localEngineDescriptorPath(paths.dbPath, paths.homeDir);
    const real = `${path}.real`; writeFileSync(real, readFileSync(path), { mode: 0o600 }); unlinkSync(path); symlinkSync(real, path);
    await expect(connectLocalEngine(paths)).rejects.toThrow("safely read");
    unlinkSync(path); writeFileSync(path, readFileSync(real), { mode: 0o644 });
    await expect(connectLocalEngine(paths)).rejects.toThrow("private regular file");
    chmodSync(path, 0o600); writeFileSync(path, "x".repeat(17 * 1024));
    await expect(connectLocalEngine(paths)).rejects.toThrow("16 KiB");
    chmodSync(dirname(path), 0o755);
    await expect(connectLocalEngine(paths)).rejects.toThrow("0700");
  });
  it("rejects metadata owned by another user", async () => {
    if (!process.getuid) return;
    const paths = fixture(); registerLocalEngine(descriptor(paths.workspace), paths.dbPath, paths);
    const uid = process.getuid();
    const owner = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    await expect(connectLocalEngine(paths)).rejects.toThrow("owned by this user");
    owner.mockRestore();
  });
  it("rejects endpoints outside loopback and mismatched host configuration", async () => {
    const paths = fixture();
    expect(() => registerLocalEngine(descriptor(paths.workspace, { url: "https://example.test/" }), paths.dbPath, paths)).toThrow("loopback");
    cleanup.push(registerLocalEngine(descriptor(paths.workspace), paths.dbPath, paths));
    await expect(connectLocalEngine({ ...paths, workspace: paths.homeDir })).rejects.toThrow("another workspace");
    await expect(connectLocalEngine({ ...paths, model: "replacement" })).rejects.toThrow("owns model");
    await expect(connectLocalEngine({ ...paths, scopePath: "/scope.json" })).rejects.toThrow("owns model");
  });
  it("pins both engine identity and process epoch before attaching", async () => {
    const paths = fixture(); const input = descriptor(paths.workspace); const peer = await server(input);
    cleanup.push(registerLocalEngine({ ...input, url: peer.url }, paths.dbPath, paths));
    peer.setEpoch("replacement-epoch");
    await expect(connectLocalEngine(paths)).rejects.toThrow("no replacement");
    expect(peer.calls).toEqual([]);
  });
  it("does not publish or discover ephemeral in-memory databases", async () => {
    const paths = fixture(); registerLocalEngine(descriptor(paths.workspace), ":memory:", paths)();
    expect(await connectLocalEngine({ ...paths, dbPath: ":memory:" })).toBeNull();
  });
});

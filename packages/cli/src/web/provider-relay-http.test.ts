import { expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleSession, createWorkbenchProviderBroker } from "@0/core";
import type { ConsoleRuntimeSnapshot } from "@0/shared";
import { BackendConnectionError, BackendConnectionRegistry } from "./backend-connections.js";
import { ConsoleGateway } from "./console-gateway.js";
import { RemoteProviderRelayBroker, handleRemoteProviderRelayRequest } from "./remote-provider-relay.js";
import { createLocalProviderRelay } from "./local-provider-relay.js";
async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

it.each([false, true])("keeps credentials local and completes HTTP-relayed turns when upstream keepalive=%s", async keepalive => {
  const credential = "local-provider-secret-never-remote"; const engineToken = "r".repeat(32); const remoteBodies: string[] = []; const remoteAuthorization: string[] = [];
  let providerAuthorization: string | undefined;
  let upstreamClosed = false;
  let providerRequests = 0;
  const provider = createServer(async (req,res) => {
    providerRequests++;
    providerAuthorization = req.headers.authorization;
    res.on("close", () => { upstreamClosed = true; });
    for await (const _chunk of req) { /* Consume the actual broker request. */ }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "From local account" })}\n\n`);
    const completed = `data: ${JSON.stringify({ type: "response.completed", response: { id: "http-result", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "From local account" }] }], usage: { input_tokens: 4, output_tokens: 3 } } })}\n\n`;
    if (keepalive) res.write(completed); else res.end(completed);
  });
  const providerUrl = await listen(provider);
  const broker = new RemoteProviderRelayBroker({ epoch: "epoch-1" }); let grantId = "";
  const home = mkdtempSync(join(tmpdir(), "0-provider-http-"));
  const gateway = new ConsoleGateway({ homeDir: home, remoteProviderRelays: broker, createSession: input => createConsoleSession({ ...input, runtime: broker.runtime(grantId, input.scanId) }) });
  const remote = createServer(async (req,res) => {
    res.setHeader("X-0-Engine-ID", "remote-engine");
    remoteAuthorization.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== `Bearer ${engineToken}`) { res.writeHead(401); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks).toString(); remoteBodies.push(raw);
    const readBody = async () => raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://remote.invalid");
    const send = (value: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    try {
      if (url.pathname === "/api/backend/handshake") { send({ protocolVersion: 1, engineId: "remote-engine", serverInstanceId: "epoch-1", capabilities: ["sessions", "events", "provider-relay"], platform: { os: "linux", pathStyle: "posix" } }); return; }
      if (await handleRemoteProviderRelayRequest(req,res,url,broker,readBody)) return;
      if (url.pathname === "/api/console/sessions" && req.method === "POST") { send({ session: gateway.create(await readBody()) }); return; }
      const match = /^\/api\/console\/sessions\/([^/]+)(\/messages)?$/.exec(url.pathname);
      if (match?.[2] && req.method === "POST") send({ session: await gateway.send(match[1]!, await readBody()) });
      else if (match && req.method === "GET") send({ snapshot: gateway.get(match[1]!) });
      else { res.writeHead(404); res.end(); }
    } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(error) })); }
  });
  const remoteUrl = await listen(remote);
  const registry = new BackendConnectionRegistry({ connections: [{ id: "remote", name: "Remote", url: remoteUrl, bearerTokenEnv: "ENGINE_TOKEN" }], env: { ENGINE_TOKEN: engineToken }, localHandshake: { protocolVersion: 1, engineId: "local-engine", capabilities: ["sessions"], platform: { os: "darwin", pathStyle: "posix" } } });
  let relay: Awaited<ReturnType<typeof createLocalProviderRelay>> | undefined;
  try {
    const localBroker = createWorkbenchProviderBroker({ provider: "chatgpt-codex", models: ["gpt-6.1-sol"], resolveCredentials: async () => ({ accessToken: credential, accountId: "local-account" }), fetchImpl: async (_url, init) => fetch(providerUrl, init) });
    relay = await createLocalProviderRelay({ registry, backendId: "remote", createProvider: async () => ({ info: { model: "gpt-6.1-sol", providerId: "chatgpt-codex", configured: true } as ConsoleRuntimeSnapshot, grant: localBroker.grant, transport: { provider: "chatgpt-codex", models: ["gpt-6.1-sol"], request: localBroker.request, close: localBroker.close } }) });
    grantId = relay.grant.id;
    const created = await registry.request("remote", "/api/console/sessions", { method: "POST", body: { modelSource: { kind: "local", grantId } } }); const { session } = await created.json() as { session: { id: string; runtime: { modelSource: string } } };
    expect(session.runtime.modelSource).toBe("local"); relay.start(session.id);
    const sent = await registry.request("remote", `/api/console/sessions/${session.id}/messages`, { method: "POST", body: { text: "Hello from remote tools host" } }); expect(sent.ok).toBe(true); await sent.body?.cancel();
    let answer = "";
    for (let attempt = 0; attempt < 60 && !answer; attempt++) {
      const response = await registry.request("remote", `/api/console/sessions/${session.id}`, { method: "GET" });
      const value = await response.json() as { snapshot: { lastOutcome?: { assistantText: string } } }; answer = value.snapshot.lastOutcome?.assistantText ?? "";
      if (!answer) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(answer).toBe("From local account");
    if (keepalive) await vi.waitFor(() => expect(upstreamClosed).toBe(true));
    const previousRequests = providerRequests;
    // The first turn worked. A dropped background poll must not strand the
    // next ordinary message or turn it into an account sign-in failure.
    const request = registry.request.bind(registry);
    let droppedPoll = false;
    const requestSpy = vi.spyOn(registry, "request").mockImplementation(async (backendId, path, options) => {
      if (!droppedPoll && options?.method === "GET" && path.endsWith("/requests")) {
        droppedPoll = true;
        throw new BackendConnectionError("Backend request timed out.", 504);
      }
      return request(backendId, path, options);
    });
    try {
      const next = await registry.request("remote", `/api/console/sessions/${session.id}/messages`, { method: "POST", body: { text: "wassup" } });
      expect(next.ok).toBe(true); await next.body?.cancel();
      await vi.waitFor(() => expect(providerRequests).toBeGreaterThan(previousRequests), { timeout: 5000 });
      await vi.waitFor(() => expect(gateway.get(session.id).session.status).toBe("ready"), { timeout: 5000 });
      expect(gateway.get(session.id).lastOutcome?.assistantText).toBe("From local account");
      expect(gateway.get(session.id).lastOutcome?.error).toBeUndefined();
      expect(droppedPoll).toBe(true);
      expect(relay.status().phase).not.toBe("failed");
    } finally { requestSpy.mockRestore(); }
    expect(providerAuthorization).toBe(`Bearer ${credential}`);
    expect(remoteAuthorization.every(value => value === `Bearer ${engineToken}`)).toBe(true); expect(remoteBodies.join("\n")).not.toContain(credential); expect(remoteBodies.join("\n")).not.toContain("local-account");
  } finally { await relay?.close(); await gateway.closeAll(); broker.dispose(); registry.dispose(); await Promise.all([close(remote), close(provider)]); rmSync(home,{recursive:true,force:true}); }
}, 20_000);

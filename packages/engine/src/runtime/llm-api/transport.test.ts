import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect, createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyTransportFailure } from "./retry.js";
import { causeCode, modelDispatcher, modelFetch, setModelConnectOptionsForTests, modelTransportStats, resetModelTransportForTests } from "./transport.js";

type Behavior = "ok" | "reset" | "hang" | "http503";
let server: Server;
let url: string;
let script: Behavior[];
let seen: number;

beforeEach(async () => {
  resetModelTransportForTests();
  script = []; seen = 0;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const behavior = script.shift() ?? "ok";
    seen++;
    req.resume();
    if (behavior === "reset") { req.socket.destroy(); return; }
    if (behavior === "hang") return;
    if (behavior === "http503") { res.writeHead(503).end("busy"); return; }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

const post = (signal?: AbortSignal) => modelFetch(url, { method: "POST", body: JSON.stringify({ input: "x".repeat(1000) }), ...(signal ? { signal } : {}) });

describe("model transport self-healing", () => {
  it("recovers on the next call after the server resets the connection", async () => {
    script = ["reset"];
    await expect(post()).rejects.toThrow();
    expect(modelTransportStats()).toMatchObject({ consecutiveFailures: 1, failedCalls: 1, recycles: 1 });
    expect(modelTransportStats().lastFailureCode).not.toBeNull();
    expect((await post()).status).toBe(200);
    expect(modelTransportStats().consecutiveFailures).toBe(0);
  });

  it("keeps recovering through a run of resets, 5xx responses and a cancelled hang", async () => {
    script = ["reset", "reset", "http503", "hang", "ok"];
    await expect(post()).rejects.toThrow();
    await expect(post()).rejects.toThrow();
    expect(modelTransportStats().consecutiveFailures).toBe(2);
    expect((await post()).status).toBe(503); // an HTTP answer is not a connection failure, and resets the streak
    expect(modelTransportStats().consecutiveFailures).toBe(0);
    const controller = new AbortController();
    const hung = post(controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(hung).rejects.toThrow();
    expect(modelTransportStats().failedCalls).toBe(2); // an operator abort is not counted
    expect((await post()).status).toBe(200);
    expect(seen).toBe(5);
  });

  it("serves concurrent calls after a reset without sharing the broken connection", async () => {
    script = ["reset"];
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => post()));
    expect(results.filter(r => r.status === "rejected").length).toBe(1);
    const again = await Promise.all(Array.from({ length: 6 }, () => post()));
    expect(again.every(r => r.status === 200)).toBe(true);
  });
});

describe("transport failure reporting", () => {
  it("surfaces cause codes that contain punctuation instead of 'unknown'", () => {
    const tls = new TypeError("fetch failed", { cause: Object.assign(new Error("0A0003FC:SSL routines:ssl3_read_bytes:ssl/tls alert bad record mac"), { code: "ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC" }) });
    expect(causeCode(tls)).toBe("ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC");
    const failure = classifyTransportFailure(tls);
    expect(failure.code).toBe("ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC");
    expect(failure.message).toContain("bad record mac");
  });

  it("treats a TLS error on a connection that wrote nothing as safe to replay, and one after the request was sent as not", () => {
    const tls = (bytesWritten: number) => new TypeError("fetch failed", { cause: Object.assign(new Error("bad record mac"), { code: "ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC", socket: { bytesWritten } }) });
    expect(classifyTransportFailure(tls(0)).beforeDispatch).toBe(true);
    expect(classifyTransportFailure(tls(2_000)).beforeDispatch).toBe(false);
  });

  it("names ECONNRESET when the server resets a live request", async () => {
    script = ["reset"];
    const error = await post().catch((e: unknown) => e);
    expect(classifyTransportFailure(error).code).toMatch(/ECONNRESET|UND_ERR_SOCKET|CONNECTION_CLOSED/);
  });
});

describe("recovery from a poisoned TLS connection", () => {
  const FAILURES = 3;
  let dir: string;
  let tlsServer: HttpsServer | undefined;
  let proxy: NetServer | undefined;
  let relayed: Array<{ destroy: () => unknown }> = [];
  let tlsUrl: string;
  let connections = 0;
  let resumed = 0;
  const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;

  beforeEach(async () => {
    if (!haveOpenssl) return;
    dir = mkdtempSync(join(tmpdir(), "model-tls-"));
    const key = join(dir, "k.pem"); const cert = join(dir, "c.pem");
    spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert,
      "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    const pem = { key: readFileSync(key), cert: readFileSync(cert) };
    connections = 0; resumed = 0; relayed = [];
    tlsServer = createHttpsServer(pem, (req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}")); });
    tlsServer.on("secureConnection", (socket: TLSSocket) => { if (socket.isSessionReused()) resumed++; });
    await new Promise<void>(resolve => tlsServer!.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (tlsServer.address() as AddressInfo).port;
    // A TCP relay in front of the TLS server. For the first FAILURES connections, once the client has
    // sent part of its request it answers with a well-formed TLS application-data record header over
    // a body that cannot authenticate: the client reports bad_record_mac, exactly like production.
    proxy = createNetServer(client => {
      const poisoned = ++connections <= FAILURES;
      const upstream = connect(upstreamPort, "127.0.0.1");
      relayed.push(client, upstream);
      let sent = 0; let injected = false;
      client.on("data", chunk => { sent += chunk.length; if (!injected) upstream.write(chunk); });
      upstream.on("data", chunk => {
        if (poisoned && !injected && sent > 200_000) {
          // The whole request went out; instead of the response, deliver a record that cannot authenticate.
          injected = true;
          client.write(Buffer.concat([Buffer.from([0x17, 0x03, 0x03, 0x00, 0x30]), Buffer.alloc(0x30, 0xab)]));
          setTimeout(() => client.destroy(), 100); // a real server hangs up after the alert it receives
        } else if (!injected) client.write(chunk);
      });
      for (const s of [client, upstream]) s.on("error", () => undefined);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => { if (!injected) client.destroy(); });
    });
    await new Promise<void>(resolve => proxy!.listen(0, "127.0.0.1", resolve));
    tlsUrl = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1/responses`;
    setModelConnectOptionsForTests({ ca: pem.cert });
  });
  afterEach(async () => {
    setModelConnectOptionsForTests({});
    for (const s of relayed) s.destroy();
    if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
    if (tlsServer) { tlsServer.closeAllConnections(); await new Promise<void>(resolve => tlsServer!.close(() => resolve())); }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!haveOpenssl || typeof (globalThis as { Bun?: unknown }).Bun !== "undefined")(
    "rebuilds the pool after each bad_record_mac, never resumes a session, and recovers on the next call", async () => {
      const send = () => modelFetch(tlsUrl, { method: "POST", body: JSON.stringify({ input: "x".repeat(200_000) }) });
      const seenDispatchers = new Set<unknown>();
      for (let i = 1; i <= FAILURES; i++) {
        seenDispatchers.add(modelDispatcher());
        const error = await send().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(modelTransportStats()).toMatchObject({ failedCalls: i, recycles: i, consecutiveFailures: i, lastSessionReused: false });
        expect(modelTransportStats().lastFailureCode).toMatch(/BAD_RECORD_MAC/);
      }
      expect(seenDispatchers.size).toBe(FAILURES); // a brand-new dispatcher (own SecureContext, no session cache) every time
      expect((await send()).status).toBe(200);
      expect(modelTransportStats().http).toBe("1.1");
      expect(modelTransportStats()).toMatchObject({ consecutiveFailures: 0, lastSessionReused: false });
      expect(connections).toBe(FAILURES + 1);
      expect(resumed).toBe(0);
    });
});

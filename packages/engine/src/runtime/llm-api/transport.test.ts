import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyTransportFailure } from "./retry.js";
import { causeCode, modelFetch, modelTransportStats, resetModelTransportForTests } from "./transport.js";

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

  it("names ECONNRESET when the server resets a live request", async () => {
    script = ["reset"];
    const error = await post().catch((e: unknown) => e);
    expect(classifyTransportFailure(error).code).toMatch(/ECONNRESET|UND_ERR_SOCKET|CONNECTION_CLOSED/);
  });
});

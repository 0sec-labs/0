import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createOastServer } from "./server.js";

const secret = "dns-ingest-test-secret-0123456789abcdef";
const running: ReturnType<typeof createOastServer>[] = [];
const previousEnv = process.env.ZERO_OAST_DNS_INGEST_TOKEN;
afterEach(async () => {
  if (previousEnv === undefined) delete process.env.ZERO_OAST_DNS_INGEST_TOKEN;
  else process.env.ZERO_OAST_DNS_INGEST_TOKEN = previousEnv;
  for (const handle of running.splice(0)) { handle.server.closeAllConnections(); await handle.close(); }
});

async function listen(options: Parameters<typeof createOastServer>[0] = {}) {
  const handle = createOastServer({ baseDomain: "oast.test", ...options });
  running.push(handle);
  await new Promise<void>(resolve => handle.server.listen(0, "127.0.0.1", resolve));
  return { ...handle, port: (handle.server.address() as AddressInfo).port };
}

function send(port: number, path: string, authorization?: string, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) } }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("trusted DNS ingestion HTTP boundary", () => {
  it("fails closed when unconfigured without disabling public HTTP callbacks", async () => {
    delete process.env.ZERO_OAST_DNS_INGEST_TOKEN;
    const server = await listen(); const handle = server.store.register();
    expect(await send(server.port, "/ingest/dns", undefined, { queryName: handle.host })).toBe(503);
    expect(server.store.poll(handle.token)).toEqual([]);
    expect(await send(server.port, `/${handle.token}/beacon`)).toBe(200);
    expect(server.store.poll(handle.token).map(item => item.protocol)).toEqual(["http"]);
  });

  it("rejects missing, malformed and wrong secrets without recording forged DNS evidence", async () => {
    const server = await listen({ dnsIngestToken: secret }); const handle = server.store.register();
    for (const authorization of [undefined, secret, `Basic ${secret}`, `Bearer ${secret.slice(1)}`, `Bearer ${secret}x`, `Bearer ${"x".repeat(secret.length)}`]) {
      expect(await send(server.port, "/ingest/dns?from=frontend", authorization, { queryName: handle.host, raw: `DNS ${handle.token}` })).toBe(403);
      expect(server.store.poll(handle.token)).toEqual([]);
    }
    expect(await send(server.port, "/ingest/dns", `Bearer ${secret}`, { queryName: handle.host, remoteAddress: "198.51.100.2" })).toBe(200);
    expect(server.store.poll(handle.token)).toMatchObject([{ protocol: "dns", queryName: handle.host, remoteAddress: "198.51.100.2" }]);
  });

  it("denies an unauthenticated request before its unfinished body is read", async () => {
    const server = await listen({ dnsIngestToken: secret });
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: server.port, method: "POST", path: "/ingest/dns", headers: { "content-type": "application/json", "content-length": 1000 } }, res => {
        res.resume(); res.on("end", () => { resolve(res.statusCode ?? 0); req.destroy(); });
      });
      req.on("error", reject); req.setTimeout(2000, () => { req.destroy(); reject(new Error("Authentication waited for the request body")); });
      req.write("{");
    });
    expect(status).toBe(403);
  });

  it("supports deployment environment configuration and rejects invalid secret lengths", async () => {
    process.env.ZERO_OAST_DNS_INGEST_TOKEN = secret;
    const server = await listen(); const handle = server.store.register();
    expect(await send(server.port, "/ingest/dns", `Bearer ${secret}`, { queryName: handle.host })).toBe(200);
    for (const dnsIngestToken of ["", "x".repeat(31), "x".repeat(4097)]) expect(() => createOastServer({ dnsIngestToken })).toThrow(/32–4096/);
  });
});

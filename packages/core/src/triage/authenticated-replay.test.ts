import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Finding, NamedIdentity } from "@0/shared";
import { ToolExecutor } from "../agent/tools.js";
import { SessionEngine } from "../agent/session.js";
import { ScopePolicy } from "../scope/scope.js";
import { parseRequest, verifyOracleByCategory } from "./oracles.js";

describe("authenticated ownership replay against a real local server", () => {
  let server: Server;
  let origin: string;
  const marker = "PRIVATE_OWNER_RESOURCE_93d879ac";
  const identities: NamedIdentity[] = [
    { label: "owner", role: "admin", auth: { type: "bearer", token: "synthetic-owner-token" } },
    { label: "other", role: "user", auth: { type: "bearer", token: "synthetic-other-token" } },
  ];
  const seen: string[] = [];
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      seen.push(String(req.headers.authorization));
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://localhost:1/should-never-be-followed" });
        res.end(); return;
      }
      if (req.url === "/echo") {
        let body = "";
        for await (const chunk of req) body += chunk;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ method: req.method, body, csrf: req.headers["x-csrf-token"] })); return;
      }
      if (req.url === "/public") { res.end("shared public landing page"); return; }
      if (!req.headers.authorization) { res.writeHead(401); res.end("login required"); return; }
      if (req.url === "/protected/uuid-owner" && req.headers.authorization !== "Bearer synthetic-owner-token") {
        res.writeHead(403); res.end("denied"); return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ marker, reflectedToken: req.headers.authorization }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing local address");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  function executor(path: string, configured = identities) {
    return new ToolExecutor({
      target: origin, scanId: "local-replay", findings: [], attackResults: [], targetInfo: {},
      identities: configured, session: new SessionEngine(configured),
      scope: ScopePolicy.fromJson({ in_scope: ["127.0.0.1"] }),
      accessControlFixtures: [{ url: origin + path, ownerIdentity: "owner", comparisonIdentities: ["other"], ownershipMarker: marker }],
    }, null);
  }
  function finding(path: string): Finding {
    return { id: "local-idor", templateId: "fixture", title: "IDOR candidate", description: "",
      category: "information-disclosure", severity: "high", status: "discovered", confidence: 0.7,
      timestamp: Date.now(), evidence: { request: `GET ${path} HTTP/1.1\r\n\r\n`, response: "" } };
  }
  async function check(path: string) {
    const ex = executor(path);
    return verifyOracleByCategory(finding(path), origin, {
      fetch: (url, init) => ex.fetchOracleRequest(url, init),
      verifyAccessControl: (f, target) => ex.verifyAccessControlFinding(f, target),
    });
  }
  it("confirms a UUID resource leaked across real authenticated identities", async () => {
    const result = await check("/vulnerable/uuid-owner");
    expect(result.verified).toBe(true);
    expect(seen).toContain("Bearer synthetic-owner-token");
    expect(seen).toContain("Bearer synthetic-other-token");
    expect(result.evidence).toContain(marker);
    expect(result.evidence).not.toContain("synthetic-owner-token");
    expect(result.evidence).not.toContain("synthetic-other-token");
  });
  it("does not confirm a correctly isolated UUID resource", async () => {
    expect((await check("/protected/uuid-owner")).verified).toBe(false);
  });
  it("does not confirm identical public pages without the private marker", async () => {
    const result = await check("/public");
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("inconclusive");
    expect(result.inconclusive).toBe(true);
  });
  it("refuses labels backed by identical credentials", async () => {
    const ex = executor("/vulnerable/uuid-owner", [identities[0], { ...identities[1], auth: identities[0].auth }]);
    const result = await ex.verifyAccessControlFinding(finding("/vulnerable/uuid-owner"), origin);
    expect(result?.verified).toBe(false);
    expect(result?.reason).toContain("distinct authentication");
  });
  it("rejects headers that replace the comparison identity", async () => {
    const result = await executor("/public").execute({ name: "access_control_probe", arguments: {
      url: origin + "/public", headers: { aUtHoRiZaTiOn: "Bearer synthetic-owner-token" },
    } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot override");
  });
  it("restores live auth while retaining recorded JSON, method and CSRF header", async () => {
    const ex = executor("/echo");
    const parsed = parseRequest("POST /echo HTTP/1.1\r\nAuthorization: Bearer stale\r\nContent-Type: application/json\r\nX-CSRF-Token: synthetic-csrf\r\n\r\n{\"name\":\"fixture\"}", origin);
    const res = await ex.fetchOracleRequest(parsed.url, { method: parsed.method, headers: parsed.headers, body: parsed.body });
    expect(await res.json()).toEqual({ method: "POST", body: '{"name":"fixture"}', csrf: "synthetic-csrf" });
    expect(seen.at(-1)).toBe("Bearer synthetic-owner-token");
  });
  it("does not follow redirects during replay", async () => {
    const res = await executor("/redirect").fetchOracleRequest(origin + "/redirect", { method: "GET" });
    expect(res.status).toBe(302);
  });
});


it("preserves JSON structure and separate query fields during injection replay", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const finding = { id: "json-probe", category: "sql-injection", evidence: {
    request: 'POST /search?tenant=synthetic HTTP/1.1\nContent-Type: application/json\n\n{"name":"seed","nested":{"keep":true}}',
  } } as Finding;
  await verifyOracleByCategory(finding, "https://fixture.test", { fetch: async (url, init) => {
    requests.push({ url, init });
    return new Response("no injection signals", { status: 200 });
  } });
  expect(requests.length).toBeGreaterThan(1);
  for (const request of requests) {
    expect(new URL(request.url).searchParams.get("tenant")).toMatch(/^synthetic/);
    expect(request.init.method).toBe("POST");
    expect(new Headers(request.init.headers).get("content-type")).toBe("application/json");
    const body = JSON.parse(String(request.init.body));
    expect(body.name).toMatch(/^seed/);
    expect(body.nested).toEqual({ keep: true });
    expect(body).not.toHaveProperty("tenant");
  }
});

it("does not automatically mutate resource IDs through write methods", async () => {
  let requests = 0;
  const finding = { category: "information-disclosure", evidence: {
    request: "DELETE /resource?id=42 HTTP/1.1\n\n",
  } } as Finding;
  const result = await verifyOracleByCategory(finding, "https://fixture.test", { fetch: async () => {
    requests++; return new Response("ok");
  } });
  expect(requests).toBe(0);
  expect(result.verified).toBe(false);
  expect(result.inconclusive).toBe(true);
});

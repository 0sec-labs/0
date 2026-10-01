import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Finding } from "@0/shared";
import { validateFindingInline } from "../agent/inline-validation.js";

// Explicit qualification must fail if the optional browser is unavailable.
describe.runIf(process.env.ZERO_TEST_BROWSER_ORACLES === "1")("real browser XSS validator", () => {
  let server: Server;
  let origin: string;
  const requests: Array<{ path: string; method: string; body: string }> = [];
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const url = new URL(req.url!, "http://localhost");
      requests.push({ path: url.pathname, method: req.method!, body });
      if (url.pathname === "/public") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ publicResource: url.searchParams.get("id") })); return;
      }
      const payload = req.method === "POST"
        ? new URLSearchParams(body).get("q") ?? ""
        : url.searchParams.get("q") ?? "";
      if (url.pathname === "/post" && req.method !== "POST") {
        res.writeHead(405); res.end("POST required"); return;
      }
      if (url.pathname === "/csp") res.setHeader("content-security-policy", "script-src 'none'");
      if (url.pathname === "/json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ payload })); return;
      }
      res.setHeader("content-type", "text/html");
      const escaped = payload.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      if (url.pathname === "/escaped") res.end(`<p>${escaped}</p>`);
      else if (url.pathname === "/unrelated") res.end("<script>alert('unrelated dialog')</script>");
      else res.end(`<html><body>${payload}</body></html>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no fixture port");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  async function check(path: string, method = "GET") {
    const url = `${origin}${path}${method === "GET" ? "?q=seed" : ""}`;
    const finding = {
      id: `browser-${path}`, templateId: "local-fixture", title: "XSS hypothesis",
      description: "", category: "xss", severity: "high", status: "discovered",
      confidence: 0.7, timestamp: Date.now(),
      evidence: { request: method === "POST" ? `curl -X POST ${url} --data 'q=seed'` : `curl ${url}`, response: "" },
    } as Finding;
    // Real save_finding validator path; no mocked oracle or browser.
    return validateFindingInline(finding, url);
  }
  it("confirms actual GET script execution with a fresh token", async () => {
    const result = await check("/get");
    expect(result.confirmed).toBe(true);
    expect(result.evidence).toMatch(/playwright dialog captured token=osec_[a-f0-9]+/);
  });
  it("confirms actual POST script execution, retaining method and body", async () => {
    const result = await check("/post", "POST");
    expect(result.confirmed).toBe(true);
    const captured = requests.filter(r => r.path === "/post");
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured.every(r => r.method === "POST")).toBe(true);
    expect(captured.every(r => new URLSearchParams(r.body).get("q")?.includes("<script>alert('osec_"))).toBe(true);
  });
  for (const path of ["/escaped", "/csp", "/json", "/unrelated"]) {
    it(`does not confirm ${path} without execution of the fresh token`, async () => {
      const result = await check(path);
      expect(result.confirmed).toBe(false);
      expect(result.evidence).not.toContain("playwright dialog captured");
    });
  }
  it("does not turn differing public resource responses into verified IDOR", async () => {
    const target = `${origin}/public?id=42`;
    const result = await validateFindingInline({
      id: "public-id-control", templateId: "local-fixture", title: "IDOR hypothesis",
      description: "", category: "information-disclosure", severity: "high",
      status: "discovered", confidence: 0.7, timestamp: Date.now(),
      evidence: { request: `curl ${target}`, response: "" },
    } as Finding, target);
    expect(result.confirmed).toBe(false);
    expect(result.evidence).toContain("distinct responses on id mutation");
    expect(result.reason).toContain("identity and resource ownership");
  });
});

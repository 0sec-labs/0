// Spawns the real CLI: the whole request path (host rules, gate, cookie session, CSRF, health, drain).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TOKEN = "integration-access-token-0123456789abcdef";
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const cwd = fileURLToPath(new URL("../..", import.meta.url));

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string }
function call(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { Host: init.host ?? `localhost:${port}`, ...init.headers } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c as Buffer));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end(init.body);
  });
}

interface Running { child: ChildProcess; port: number; log: () => string; exited: Promise<number | null> }
async function start(args: string[], env: Record<string, string>, port: number): Promise<Running> {
  const home = mkdtempSync(join(tmpdir(), "zero-server-mode-"));
  const assets = join(home, "assets"); mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "<!doctype html><html><head><title>t</title></head><body>app</body></html>");
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", entry, "web", "--port", String(port), "--asset-dir", assets, "--no-open", ...args], { cwd, env: { ...process.env, HOME: home, ZERO_NO_TELEMETRY: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", d => { output += String(d); }); child.stderr!.on("data", d => { output += String(d); });
  const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  const deadline = Date.now() + 60_000;
  while (!output.includes("ZERO_DASHBOARD_READY") && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${output}`);
    await new Promise(r => setTimeout(r, 100));
  }
  return { child, port, log: () => output, exited };
}

const servers: Running[] = [];
afterAll(() => { for (const s of servers) s.child.kill("SIGKILL"); });

describe("0 web --server-mode", () => {
  let server: Running;
  beforeAll(async () => { server = await start(["--host", "127.0.0.1", "--server-mode"], { ZERO_ACCESS_TOKEN: TOKEN, ZERO_ALLOWED_HOSTS: "localhost" }, 48961); servers.push(server); }, 90_000);

  it("keeps the control token and access token out of anonymous responses and the log", async () => {
    for (const path of ["/", "/chats", "/chats/abc"]) {
      const page = await call(server.port, path);
      expect(page.status).toBe(200);
      expect(page.text).not.toContain("0-control-token");
      expect(page.text).not.toContain(TOKEN);
    }
    expect((await call(server.port, "/api/console/sessions")).status).toBe(401);
    expect((await call(server.port, "/index.html")).status).toBe(401);
    expect(server.log()).not.toContain(TOKEN);
  });

  it("reaches the webhook handler anonymously on exactly one path; every neighbour stays behind sign-in", async () => {
    const hook = { "Content-Type": "application/json", "X-GitHub-Event": "ping", "X-GitHub-Delivery": "integration-0001" };
    // No secret yet: the handler answers 404 itself (proves it was reached without a session or control token).
    const reached = await call(server.port, "/api/webhooks/github", { method: "POST", headers: hook, body: "{}" });
    expect(reached.status).toBe(404);
    expect(reached.headers["x-0-request-id"]).toBeDefined();
    for (const path of ["/api/webhooks/github/", "/api/webhooks/github2", "/api/webhooks", "/api/console/github/webhook", "/api/console/github/webhook/secret", "/api/v1/webhooks/github"]) {
      expect((await call(server.port, path, { method: "POST", headers: hook, body: "{}" })).status, path).toBe(401);
    }
    // The engine bearer is not a credential for the webhook route and does not open its management routes.
    expect((await call(server.port, "/api/console/github/webhook/secret", { method: "POST", headers: { ...hook, Authorization: "Bearer not-the-engine-token" }, body: "{}" })).status).toBe(403);
  });

  it("answers health probes without credentials and with any Host", async () => {
    expect(JSON.parse((await call(server.port, "/healthz", { host: "10.0.0.5:1" })).text)).toEqual({ status: "ok", modelTransport: expect.objectContaining({ consecutiveFailures: 0, failedCalls: 0 }) });
    expect(JSON.parse((await call(server.port, "/readyz")).text)).toEqual({ status: "ready" });
  });

  it("returns 403 for an unknown Host, a foreign Origin and a cross-site API call", async () => {
    expect((await call(server.port, "/", { host: "evil.example.com" })).status).toBe(403);
    expect((await call(server.port, "/_access/login", { method: "POST", host: `localhost:${server.port}`, headers: { Origin: "https://evil.example.com" }, body: "{}" })).status).toBe(403);
    expect((await call(server.port, "/api/console/sessions", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
  });

  it("signs in with the access token, then enforces cookie + control token + Origin on the API", async () => {
    const origin = `http://localhost:${server.port}`;
    const json = { "Content-Type": "application/json", Origin: origin };
    expect((await call(server.port, "/_access/login", { method: "POST", headers: json, body: JSON.stringify({ token: "wrong".repeat(10) }) })).status).toBe(401);
    const ok = await call(server.port, "/_access/login", { method: "POST", headers: json, body: JSON.stringify({ token: TOKEN }) });
    expect(ok.status).toBe(200);
    const setCookie = String(ok.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/); expect(setCookie).toMatch(/SameSite=Strict/);
    expect(ok.text).not.toMatch(/token/i);
    const cookie = setCookie.split(";")[0]!;
    const page = await call(server.port, "/chats", { headers: { Cookie: cookie } });
    const control = /name="0-control-token" content="([^"]+)"/.exec(page.text)?.[1];
    expect(control).toBeTruthy();
    expect(control).not.toBe(TOKEN);
    const authed = { Cookie: cookie, "x-0-control-token": control! };
    expect((await call(server.port, "/api/console/sessions", { headers: authed })).status).toBe(200);
    expect((await call(server.port, "/api/console/sessions", { headers: { Cookie: cookie } })).status).toBe(403);
    expect((await call(server.port, "/api/console/sessions", { method: "POST", headers: { ...authed, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await call(server.port, "/api/console/sessions", { headers: { "x-0-control-token": control! } })).status).toBe(401);
    expect(server.log()).not.toContain(control!);
  });

  it("throttles repeated wrong tokens", async () => {
    const origin = `http://localhost:${server.port}`;
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await call(server.port, "/_access/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ token: `bad-${i}`.padEnd(40, "x") }) })).status);
    expect(statuses).toContain(429);
    const locked = await call(server.port, "/_access/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ token: TOKEN }) });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("drains on SIGTERM and exits 0", async () => {
    const started = Date.now();
    server.child.kill("SIGTERM");
    expect(await server.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe("server mode startup rules", () => {
  it("refuses to start with a short access token, or a wildcard bind and no allowed host", async () => {
    for (const [args, env, message] of [
      [["--host", "127.0.0.1", "--server-mode"], { ZERO_ACCESS_TOKEN: "short" }, /32/],
      [["--host", "0.0.0.0", "--server-mode"], { ZERO_ACCESS_TOKEN: TOKEN, ZERO_ALLOWED_HOSTS: "" }, /allowed host/],
    ] as const) {
      await expect(start([...args], { ...env }, 48962)).rejects.toThrow(message);
    }
  }, 60_000);
});

describe("loopback default is unchanged", () => {
  let server: Running;
  beforeAll(async () => { server = await start(["--host", "127.0.0.1"], {}, 48963); servers.push(server); }, 90_000);
  it("still injects the token for the local operator and 403s a foreign Host", async () => {
    const page = await call(server.port, "/", { host: `127.0.0.1:${server.port}` });
    expect(page.text).toContain("0-control-token");
    expect((await call(server.port, "/", { host: "evil.example.com" })).status).toBe(403);
    // No gate exists here: the sign-in route is just an app route and issues no cookie.
    expect((await call(server.port, "/_access/login", { method: "POST", host: `127.0.0.1:${server.port}` })).headers["set-cookie"]).toBeUndefined();
    expect((await call(server.port, "/healthz", { host: `127.0.0.1:${server.port}` })).status).toBe(200);
    expect((await call(server.port, "/healthz", { host: "evil.example.com" })).status).toBe(403);
  });
  it("does not mount the webhook route or its settings outside server mode", async () => {
    const host = `127.0.0.1:${server.port}`;
    const page = await call(server.port, "/", { host });
    const control = /name="0-control-token" content="([^"]+)"/.exec(page.text)![1]!;
    const hook = { "Content-Type": "application/json", "X-GitHub-Event": "ping", "X-GitHub-Delivery": "integration-0002" };
    expect((await call(server.port, "/api/webhooks/github", { host, method: "POST", headers: hook, body: "{}" })).status).toBe(403);
    expect((await call(server.port, "/api/webhooks/github", { host, method: "POST", headers: { ...hook, "X-0-Control-Token": control }, body: "{}" })).status).toBe(404);
    const status = await call(server.port, "/api/console/github/webhook", { host, headers: { "X-0-Control-Token": control } });
    expect(JSON.parse(status.text)).toEqual({ webhook: { serverMode: false } });
    expect((await call(server.port, "/api/console/github/webhook/secret", { host, method: "POST", headers: { ...hook, "X-0-Control-Token": control }, body: "{}" })).status).toBe(404);
  });
  it("refuses a non-loopback bind without --server-mode", async () => {
    await expect(start(["--host", "0.0.0.0"], {}, 48964)).rejects.toThrow(/loopback/);
  }, 60_000);
});

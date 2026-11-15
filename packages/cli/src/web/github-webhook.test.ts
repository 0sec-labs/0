import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAudit } from "@0/engine/storage";
import { configureAudit } from "./audit.js";
import {
  DeliveryDedupe, GITHUB_WEBHOOK_PATH, GitHubWebhookReceiver, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_ROTATION_GRACE_MS, WebhookSecretStore,
  handleWebhookConsoleRequest, parsePullRequestEvent, verifySignature,
} from "./github-webhook.js";
import { ANONYMOUS_API_EXEMPTIONS, isAnonymousApiExemption, isBrowserOnlyRoute } from "./privileged-routes.js";

const dirs: string[] = [];
const servers: Server[] = [];
let clock = Date.parse("2026-03-02T10:00:00Z");
let delivery = 0;
const sign = (body: string | Buffer, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const prPayload = (over: Record<string, unknown> = {}, pull: Record<string, unknown> = {}) => JSON.stringify({
  action: "synchronize", repository: { full_name: "acme/app" }, pull_request: { number: 7, state: "open", draft: false, base: { ref: "main" }, head: { sha: "a".repeat(40) }, title: "PAYLOAD-TITLE-MARKER", ...pull }, ...over,
});

async function fixture(options: { targets?: Array<{ id: string }>; limits?: { source?: number; global?: number }; configured?: boolean; maxBody?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zero-webhook-"));
  dirs.push(dir);
  configureAudit(join(dir, "audit.db"));
  const secrets = new WebhookSecretStore(dir, () => clock);
  const secret = options.configured === false ? undefined : secrets.create()!;
  const checks: string[] = [];
  const targets = vi.fn((_repo: string, _base: string) => options.targets ?? [{ id: "trig-1" }]);
  const receiver = new GitHubWebhookReceiver({
    secrets, now: () => clock,
    dispatcher: () => ({ targets, check: async id => { checks.push(id); return true; } }),
    ...(options.limits?.source ? { sourceLimitPerMinute: options.limits.source } : {}), ...(options.limits?.global ? { globalLimitPerMinute: options.limits.global } : {}),
    ...(options.maxBody ? { maxBodyBytes: options.maxBody } : {}),
  });
  const server = createServer((req, res) => { void receiver.handle(req, res, req.socket.remoteAddress ?? "?"); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const post = (body: string | Buffer, headers: Record<string, string | undefined> = {}, method = "POST") => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const merged: Record<string, string> = { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": `d-${String(++delivery).padStart(8, "0")}`, ...(secret ? { "x-hub-signature-256": sign(body, secret) } : {}) };
    for (const [key, value] of Object.entries(headers)) { if (value === undefined) delete merged[key]; else merged[key] = value; }
    const req = httpRequest({ host: "127.0.0.1", port, path: GITHUB_WEBHOOK_PATH, method, headers: { ...merged, ...(method === "POST" ? { "content-length": String(Buffer.byteLength(body)) } : {}), ...(headers["content-length"] ? { "content-length": headers["content-length"] } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end(body);
  });
  return { dir, secrets, secret: secret!, receiver, post, checks, targets, port };
}
const audits = (dir: string) => listAudit({ limit: 200 }, { dbPath: join(dir, "audit.db") }).events;

beforeEach(() => { clock = Date.parse("2026-03-02T10:00:00Z"); });
afterEach(async () => { configureAudit(null); for (const s of servers.splice(0)) await new Promise<void>(done => { s.closeAllConnections(); s.close(() => done()); }); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("signature verification", () => {
  const body = Buffer.from('{"a":1}'); const secret = "ab".repeat(32);
  it("accepts the right HMAC and rejects wrong secret, tampered body, missing, malformed and wrong-length headers", () => {
    expect(verifySignature(body, sign(body, secret), [secret])).toBe(true);
    expect(verifySignature(body, sign(body, "cd".repeat(32)), [secret])).toBe(false);
    expect(verifySignature(Buffer.from('{"a":2}'), sign(body, secret), [secret])).toBe(false);
    expect(verifySignature(body, undefined, [secret])).toBe(false);
    expect(verifySignature(body, sign(body, secret).replace("sha256=", "sha1="), [secret])).toBe(false);
    expect(verifySignature(body, sign(body, secret).slice(0, -2), [secret])).toBe(false);
    expect(verifySignature(body, `${sign(body, secret)}00`, [secret])).toBe(false);
    expect(verifySignature(body, sign(body, secret).toUpperCase(), [secret])).toBe(false);
    expect(verifySignature(body, sign(body, secret), [])).toBe(false);
  });
  it("compares with crypto.timingSafeEqual on equal-length digests and never string-compares", () => {
    const source = readFileSync(new URL("./github-webhook.ts", import.meta.url), "utf8");
    expect(source).toMatch(/timingSafeEqual\(provided, expected\)/);
    expect(source).toMatch(/provided\.length === expected\.length/);
  });
});

describe("receiver", () => {
  it("accepts a correctly signed pull_request, answers 202 and checks every matching trigger through the dispatcher", async () => {
    const f = await fixture({ targets: [{ id: "t1" }, { id: "t2" }] });
    const reply = await f.post(prPayload());
    expect(reply.status).toBe(202);
    await f.receiver.settled();
    expect(f.checks).toEqual(["t1", "t2"]);
    expect(f.targets).toHaveBeenCalledWith("acme/app", "main");
    expect(f.receiver.status()).toMatchObject({ configured: true, lastResult: "received", deliveries: [{ result: "received", event: "pull_request" }] });
  });

  it("returns 404 when no secret exists and 405 for other methods", async () => {
    const none = await fixture({ configured: false });
    expect((await none.post(prPayload(), {})).status).toBe(404);
    const f = await fixture();
    const get = await f.post("", {}, "GET");
    expect(get.status).toBe(405);
  });

  it("rejects a missing, malformed or wrong signature with a bare 401 and checks nothing", async () => {
    const f = await fixture();
    for (const headers of [{ "x-hub-signature-256": undefined }, { "x-hub-signature-256": "sha256=zz" }, { "x-hub-signature-256": sign(prPayload(), "ff".repeat(32)) }, { "x-hub-signature-256": `sha1=${"a".repeat(40)}` }]) {
      const reply = await f.post(prPayload(), headers);
      expect(reply.status).toBe(401);
      expect(reply.text).toBe("{}");
    }
    const tampered = await f.post(prPayload(), { "x-hub-signature-256": sign(prPayload({ action: "opened" }), f.secret) });
    expect(tampered.status).toBe(401);
    await f.receiver.settled();
    expect(f.checks).toEqual([]);
  });

  it("verifies before parsing: a signed non-JSON body is a 400 only after the signature passed, an unsigned one is 401", async () => {
    const f = await fixture();
    expect((await f.post("not json", { "x-hub-signature-256": "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect((await f.post("not json")).status).toBe(400);
  });

  it("only accepts application/json", async () => {
    const f = await fixture();
    expect((await f.post(prPayload(), { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await f.post(prPayload(), { "content-type": "text/plain" })).status).toBe(415);
    expect((await f.post(prPayload(), { "content-type": "application/json; charset=utf-8" })).status).toBe(202);
  });

  it("caps the body: by Content-Length, and while streaming without a length", async () => {
    const f = await fixture({ maxBody: 2048 });
    const big = JSON.stringify({ pad: "x".repeat(4096) });
    expect((await f.post(big)).status).toBe(413);
    expect((await f.post(prPayload(), { "content-length": "99999999" })).status).toBe(413);
    expect((await f.post(prPayload(), { "content-length": "abc" })).status).toBe(400);
    // Chunked, no Content-Length: the stream is cut when it passes the cap.
    const status = await new Promise<number>(resolve => {
      const req = httpRequest({ host: "127.0.0.1", port: f.port, path: GITHUB_WEBHOOK_PATH, method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"0".repeat(64)}`, "transfer-encoding": "chunked" } }, res => resolve(res.statusCode!));
      req.on("error", () => resolve(0));
      req.write("x".repeat(1500)); req.write("x".repeat(1500)); req.end();
    });
    expect(status).toBe(413);
    expect(WEBHOOK_MAX_BODY_BYTES).toBe(1_000_000);
  });

  it("applies the event allow-list: ping is received, other events and actions are ignored with 202", async () => {
    const f = await fixture();
    expect((await f.post(JSON.stringify({ zen: "hi" }), { "x-github-event": "ping" })).status).toBe(202);
    expect((await f.post("{}", { "x-github-event": "push" })).status).toBe(202);
    expect((await f.post(prPayload({ action: "closed" }))).status).toBe(202);
    expect((await f.post(prPayload({ action: "labeled" }))).status).toBe(202);
    expect((await f.post(prPayload({}, { state: "closed" }))).status).toBe(202);
    expect((await f.post(prPayload({}, { state: "open", merged: true }))).status).toBe(202);
    for (const action of ["opened", "reopened", "synchronize", "ready_for_review"]) expect((await f.post(prPayload({ action }))).status).toBe(202);
    await f.receiver.settled();
    expect(f.checks).toHaveLength(4);
    const results = f.receiver.status().deliveries;
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("ignores payloads that match no enabled trigger and malformed shapes", async () => {
    const none = await fixture({ targets: [] });
    expect((await none.post(prPayload())).status).toBe(202);
    await none.receiver.settled();
    expect(none.checks).toEqual([]);
    expect(none.receiver.status().lastReason).toBe("no_matching_trigger");
    expect(parsePullRequestEvent({ action: "opened", repository: { full_name: "bad repo" }, pull_request: { state: "open", base: { ref: "main" } } })).toEqual({ ok: false, reason: "payload_shape" });
    expect(parsePullRequestEvent(null)).toEqual({ ok: false, reason: "action_not_allowed" });
  });

  it("dedupes replayed X-GitHub-Delivery ids, requires a delivery id, and bounds memory with a TTL", async () => {
    const f = await fixture();
    const headers = { "x-github-delivery": "replay-0001-aaaa" };
    expect((await f.post(prPayload(), headers)).status).toBe(202);
    expect((await f.post(prPayload(), headers)).status).toBe(202);
    await f.receiver.settled();
    expect(f.checks).toHaveLength(1);
    expect(f.receiver.status().lastReason).toBe("duplicate_delivery");
    expect((await f.post(prPayload(), { "x-github-delivery": undefined })).status).toBe(400);
    const dedupe = new DeliveryDedupe(() => clock, 1000, 3);
    expect(dedupe.claim("a")).toBe(true); expect(dedupe.claim("a")).toBe(false);
    clock += 1001; expect(dedupe.claim("a")).toBe(true);
    for (const id of ["b", "c", "d", "e"]) dedupe.claim(id);
    expect(dedupe.size).toBeLessThanOrEqual(3);
  });

  it("an unsigned request cannot burn a delivery id", async () => {
    const f = await fixture();
    const headers = { "x-github-delivery": "victim-id-0001" };
    expect((await f.post(prPayload(), { ...headers, "x-hub-signature-256": `sha256=${"1".repeat(64)}` })).status).toBe(401);
    expect((await f.post(prPayload(), headers)).status).toBe(202);
    await f.receiver.settled();
    expect(f.checks).toHaveLength(1);
  });

  it("rate limits per source before any work, and has a global cap on verified deliveries", async () => {
    const f = await fixture({ limits: { source: 3, global: 2 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await f.post(prPayload())).status);
    expect(statuses).toEqual([202, 202, 429, 429, 429]);
    clock += 61_000;
    const g = await fixture({ limits: { source: 100, global: 2 } });
    const out: number[] = [];
    for (let i = 0; i < 4; i++) out.push((await g.post(prPayload())).status);
    expect(out).toEqual([202, 202, 429, 429]);
    clock += 61_000;
    expect((await g.post(prPayload())).status).toBe(202);
  });

  it("answers an oversize or garbage flood without verifying beyond the per-source limit", async () => {
    const f = await fixture({ limits: { source: 2 } });
    const out: number[] = [];
    for (let i = 0; i < 4; i++) out.push((await f.post(prPayload(), { "x-hub-signature-256": `sha256=${"0".repeat(64)}` })).status);
    expect(out).toEqual([401, 401, 429, 429]);
  });
});

describe("secret lifecycle", () => {
  it("creates 32 random bytes as hex in a 0600 file once and never returns it from status", () => {
    const dir = mkdtempSync(join(tmpdir(), "zero-webhook-")); dirs.push(dir);
    const store = new WebhookSecretStore(dir, () => clock);
    expect(store.configured).toBe(false);
    const secret = store.create()!;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(store.create()).toBeUndefined();
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(store.status())).not.toContain(secret);
  });
  it("accepts the old secret for 5 minutes after rotation, then only the new one", async () => {
    const f = await fixture();
    const old = f.secret;
    const next = f.secrets.rotate();
    expect(next).not.toBe(old);
    expect(WEBHOOK_ROTATION_GRACE_MS).toBe(300_000);
    const payload = prPayload();
    expect((await f.post(payload, { "x-hub-signature-256": sign(payload, old) })).status).toBe(202);
    expect((await f.post(payload, { "x-hub-signature-256": sign(payload, next) })).status).toBe(202);
    expect(f.receiver.status().graceUntil).toBeDefined();
    clock += WEBHOOK_ROTATION_GRACE_MS + 1;
    expect((await f.post(payload, { "x-hub-signature-256": sign(payload, old) })).status).toBe(401);
    expect((await f.post(payload, { "x-hub-signature-256": sign(payload, next) })).status).toBe(202);
    expect(f.receiver.status().graceUntil).toBeUndefined();
  });
  it("a corrupted or world-readable-looking file is treated as unconfigured, not trusted", () => {
    const dir = mkdtempSync(join(tmpdir(), "zero-webhook-")); dirs.push(dir);
    const store = new WebhookSecretStore(dir);
    writeFileSync(store.path, JSON.stringify({ version: 1, current: "short" }));
    expect(store.configured).toBe(false);
  });
});

describe("console surface", () => {
  it("shows the secret exactly once (create and rotate) and no other response contains it", async () => {
    const f = await fixture({ configured: false });
    const context = { receiver: f.receiver, payloadUrl: "https://0.example.com/api/webhooks/github" };
    const created = handleWebhookConsoleRequest("github/webhook/secret", "POST", context)!;
    const secret = (created.data as { secret: string }).secret;
    expect(created.status).toBe(201);
    expect(handleWebhookConsoleRequest("github/webhook/secret", "POST", context)!.status).toBe(409);
    const status = handleWebhookConsoleRequest("github/webhook", "GET", context)!;
    expect(JSON.stringify(status.data)).not.toContain(secret);
    expect(status.data).toMatchObject({ webhook: { serverMode: true, configured: true, contentType: "application/json", events: ["Pull requests"], payloadUrl: "https://0.example.com/api/webhooks/github" } });
    const rotated = handleWebhookConsoleRequest("github/webhook/secret/rotate", "POST", context)!;
    expect(rotated).toMatchObject({ status: 200, data: { graceSeconds: 300 } });
    expect((rotated.data as { secret: string }).secret).not.toBe(secret);
    expect(JSON.stringify(handleWebhookConsoleRequest("github/webhook", "GET", context)!.data)).not.toContain((rotated.data as { secret: string }).secret);
  });
  it("shows nothing outside server mode", () => {
    expect(handleWebhookConsoleRequest("github/webhook", "GET", {})).toEqual({ status: 200, data: { webhook: { serverMode: false } } });
    expect(handleWebhookConsoleRequest("github/webhook/secret", "POST", {})!.status).toBe(404);
    expect(handleWebhookConsoleRequest("github/other", "GET", {})).toBeNull();
  });
});

describe("audit and logs", () => {
  it("records received, ignored and rejected with reasons and never the secret, signature, delivery id or payload", async () => {
    const f = await fixture();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {}); const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const payload = prPayload();
    const signature = sign(payload, f.secret);
    await f.post(payload, { "x-hub-signature-256": signature, "x-github-delivery": "leak-check-0001" });
    await f.post("{}", { "x-github-event": "push" });
    await f.post(payload, { "x-hub-signature-256": sign(payload, "ee".repeat(32)) });
    await f.receiver.settled();
    const rows = audits(f.dir);
    const actions = rows.map(row => row.action);
    expect(actions).toEqual(expect.arrayContaining(["webhook.received", "webhook.ignored", "webhook.rejected"]));
    const everything = JSON.stringify(rows) + JSON.stringify(f.receiver.status()) + errors.mock.calls.join() + logs.mock.calls.join();
    for (const forbidden of [f.secret, signature, "leak-check-0001", "PAYLOAD-TITLE-MARKER", "a".repeat(40), "acme"]) expect(everything).not.toContain(forbidden);
    expect(rows.find(row => row.action === "webhook.rejected")!.detail).toMatchObject({ reason: "invalid_signature" });
    errors.mockRestore(); logs.mockRestore();
  });
});

describe("route exemption", () => {
  it("is the only anonymous API path, documented, POST-only, and never granted to the engine bearer", () => {
    expect(ANONYMOUS_API_EXEMPTIONS.map(entry => entry.path)).toEqual(["/api/webhooks/github"]);
    expect(ANONYMOUS_API_EXEMPTIONS[0]!.methods).toEqual(["POST"]);
    expect(ANONYMOUS_API_EXEMPTIONS[0]!.why.length).toBeGreaterThan(30);
    expect(isAnonymousApiExemption("/api/webhooks/github")).toBe(true);
    for (const other of ["/api/webhooks/github/", "/api/webhooks", "/api/webhooks/github2", "/api/console/sessions", "/api/console/github/webhook", "/api/console/github/webhook/secret", "/api/team/setup", "//api/webhooks/github", "/API/webhooks/github"]) expect(isAnonymousApiExemption(other), other).toBe(false);
    expect(isBrowserOnlyRoute("/api/webhooks/github", "POST")).toBe(true);
    for (const path of ["/api/console/github/webhook/secret", "/api/console/github/webhook/secret/rotate"]) expect(isBrowserOnlyRoute(path, "POST"), path).toBe(true);
  });
  it("is wired before the session gate and only when the receiver exists (server mode)", () => {
    const source = readFileSync(new URL("../commands/dashboard.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const webhook = serverMode \? new GitHubWebhookReceiver/);
    const exempt = source.indexOf("isAnonymousApiExemption(requestUrl.pathname)");
    expect(exempt).toBeGreaterThan(0);
    expect(source.slice(exempt - 120, exempt)).toContain("webhook && serverContext");
    expect(exempt).toBeLessThan(source.indexOf("serverGuard.isAuthenticated(req, teamAuth)"));
    expect(exempt).toBeLessThan(source.indexOf("requireControlToken(req, res, controlToken"));
  });
});

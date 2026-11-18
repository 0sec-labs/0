// GitHub webhook receiver for server mode: an accelerator for the Sentinel `github-pr` trigger.
//
// The route is the ONE anonymous API path in server mode (GitHub cannot sign in), so everything here is
// defensive. Order of checks, cheapest first and always before any JSON parsing:
//   no secret configured -> 404 | method -> 405 | per-source rate limit -> 429 | content type -> 415 |
//   Content-Length cap -> 413 | signature header shape -> 401 | body read with a streaming cap and a deadline ->
//   413/408 | HMAC-SHA256 of the RAW bytes with timingSafeEqual (current secret, plus the previous one during
//   the rotation grace window) -> 401 | global cap on verified deliveries -> 429 | X-GitHub-Delivery dedupe ->
//   event allow-list -> JSON parse -> payload shape.
// Payload fields only LOCATE enabled `github-pr` triggers (repo full name and base branch). The webhook never
// launches anything itself: it asks the same routine the poller uses to check that trigger now, so draft, fork,
// closed, comment and baseline rules and the per-PR head-SHA cursor stay identical and one head SHA launches once.
// Audit events carry a reason and counts, never payload content, headers, the secret or the signature.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { audit } from "./audit.js";
import { json } from "./dashboard-http.js";

export const GITHUB_WEBHOOK_PATH = "/api/webhooks/github";
export const WEBHOOK_MAX_BODY_BYTES = 1_000_000;
export const WEBHOOK_ROTATION_GRACE_MS = 5 * 60_000;
const BODY_DEADLINE_MS = 10_000;
const DELIVERY_TTL_MS = 24 * 60 * 60_000;
const DELIVERY_MAX_ENTRIES = 5_000;
const SOURCE_LIMIT_PER_MINUTE = 30;
const GLOBAL_LIMIT_PER_MINUTE = 300;
const MAX_SOURCES = 5_000;
const HISTORY_SIZE = 20;
const ALLOWED_PR_ACTIONS: ReadonlySet<string> = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
const SIGNATURE_SHAPE = /^sha256=[0-9a-f]{64}$/;
const DELIVERY_SHAPE = /^[0-9A-Za-z-]{8,64}$/;
const REPO_SHAPE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export type DeliveryResult = "received" | "ignored" | "rejected";
export interface DeliveryRecord { at: string; result: DeliveryResult; event?: string; reason?: string }

interface SecretFile { version: 1; current: string; createdAt: string; previous?: { secret: string; until: number } }

/** The per-instance secret: 32 random bytes as hex in a 0600 file. Never returned by an API after creation. */
export class WebhookSecretStore {
  readonly path: string;
  constructor(stateDir: string, private readonly now: () => number = Date.now) { this.path = join(stateDir, "github-webhook-secret.json"); }

  private read(): SecretFile | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SecretFile>;
      if (parsed.version !== 1 || typeof parsed.current !== "string" || !/^[0-9a-f]{64}$/.test(parsed.current)) return undefined;
      const previous = parsed.previous && typeof parsed.previous.secret === "string" && /^[0-9a-f]{64}$/.test(parsed.previous.secret) && typeof parsed.previous.until === "number" ? parsed.previous : undefined;
      return { version: 1, current: parsed.current, createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(), ...(previous ? { previous } : {}) };
    } catch { return undefined; }
  }
  private write(file: SecretFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
  }

  get configured(): boolean { return this.read() !== undefined; }
  status(): { configured: boolean; createdAt?: string; graceUntil?: string } {
    const file = this.read();
    if (!file) return { configured: false };
    const grace = file.previous && file.previous.until > this.now() ? { graceUntil: new Date(file.previous.until).toISOString() } : {};
    return { configured: true, createdAt: file.createdAt, ...grace };
  }
  /** First enable. Returns the secret for one-time display, or undefined when one already exists. */
  create(): string | undefined {
    if (this.read()) return undefined;
    const secret = randomBytes(32).toString("hex");
    this.write({ version: 1, current: secret, createdAt: new Date(this.now()).toISOString() });
    return secret;
  }
  /** New secret; the old one stays valid for the grace window so GitHub can be updated without dropping deliveries. */
  rotate(): string {
    const existing = this.read();
    const secret = randomBytes(32).toString("hex");
    this.write({ version: 1, current: secret, createdAt: new Date(this.now()).toISOString(), ...(existing ? { previous: { secret: existing.current, until: this.now() + WEBHOOK_ROTATION_GRACE_MS } } : {}) });
    return secret;
  }
  /** Secrets that currently verify, newest first. */
  active(): string[] {
    const file = this.read();
    if (!file) return [];
    return file.previous && file.previous.until > this.now() ? [file.current, file.previous.secret] : [file.current];
  }
}

/** True when `header` is a well-formed `sha256=<hex>` value that matches the HMAC of the raw body under any candidate secret. Every candidate is evaluated. */
export function verifySignature(raw: Buffer, header: string | undefined, secrets: readonly string[]): boolean {
  if (typeof header !== "string" || !SIGNATURE_SHAPE.test(header)) return false;
  const provided = Buffer.from(header.slice("sha256=".length), "hex");
  let ok = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(raw).digest();
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) ok = true;
  }
  return ok;
}

/** Bounded delivery-id memory: insertion ordered, TTL on read, oldest evicted at the cap. */
export class DeliveryDedupe {
  private readonly seen = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = DELIVERY_TTL_MS, private readonly maxEntries = DELIVERY_MAX_ENTRIES) {}
  /** True when the id is new (and is now remembered); false for a replay inside the TTL. */
  claim(id: string): boolean {
    const t = this.now();
    const at = this.seen.get(id);
    if (at !== undefined && t - at < this.ttlMs) return false;
    this.seen.delete(id);
    this.seen.set(id, t);
    for (const [key, when] of this.seen) { if (t - when >= this.ttlMs || this.seen.size > this.maxEntries) this.seen.delete(key); else break; }
    return true;
  }
  get size(): number { return this.seen.size; }
}

class WindowCounter {
  private hits: number[] = [];
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  take(t: number): boolean {
    while (this.hits.length && t - this.hits[0]! >= this.windowMs) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(t); return true;
  }
  idle(t: number): boolean { return this.hits.length === 0 || t - this.hits[this.hits.length - 1]! >= this.windowMs; }
}

export interface WebhookTarget { id: string }
export interface WebhookDispatcher {
  /** Enabled `github-pr` triggers for this repository and base branch (matching is case-insensitive on the repository). */
  targets(repo: string, baseBranch: string): WebhookTarget[];
  /** The poller's own check routine for one trigger. Resolves false when the trigger is off or busy. */
  check(triggerId: string): Promise<boolean>;
}

export interface WebhookOptions {
  secrets: WebhookSecretStore;
  dispatcher: () => WebhookDispatcher | undefined;
  now?: () => number;
  sourceLimitPerMinute?: number;
  globalLimitPerMinute?: number;
  maxBodyBytes?: number;
}

const reply = (res: ServerResponse, status: number, body: Record<string, unknown> = {}): void => { json(res, status, body); };

export class GitHubWebhookReceiver {
  readonly secrets: WebhookSecretStore;
  private readonly dispatcher: WebhookOptions["dispatcher"];
  private readonly now: () => number;
  private readonly dedupe: DeliveryDedupe;
  private readonly sources = new Map<string, WindowCounter>();
  private readonly global: WindowCounter;
  private readonly sourceLimit: number;
  private readonly maxBody: number;
  private readonly history: DeliveryRecord[] = [];
  private readonly pending = new Set<Promise<void>>();
  private lastRateAudit = 0;

  constructor(options: WebhookOptions) {
    this.secrets = options.secrets; this.dispatcher = options.dispatcher; this.now = options.now ?? Date.now;
    this.dedupe = new DeliveryDedupe(this.now);
    this.sourceLimit = options.sourceLimitPerMinute ?? SOURCE_LIMIT_PER_MINUTE;
    this.global = new WindowCounter(options.globalLimitPerMinute ?? GLOBAL_LIMIT_PER_MINUTE, 60_000);
    this.maxBody = options.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES;
  }

  /** Resolves when asynchronous checks started so far have finished (tests and shutdown). */
  async settled(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  /** Metadata only: no secret, no payload, no delivery ids. */
  status(): { configured: boolean; createdAt?: string; graceUntil?: string; lastDeliveryAt?: string; lastResult?: DeliveryResult; lastReason?: string; deliveries: DeliveryRecord[] } {
    const last = this.history[0];
    return { ...this.secrets.status(), ...(last ? { lastDeliveryAt: last.at, lastResult: last.result, ...(last.reason ? { lastReason: last.reason } : {}) } : {}), deliveries: this.history.slice(0, 5).map(item => ({ ...item })) };
  }

  private record(result: DeliveryResult, client: string, event: string | undefined, reason?: string): void {
    this.history.unshift({ at: new Date(this.now()).toISOString(), result, ...(event ? { event } : {}), ...(reason ? { reason } : {}) });
    if (this.history.length > HISTORY_SIZE) this.history.length = HISTORY_SIZE;
    audit({ actor: "github-webhook", action: `webhook.${result}`, subject: "github", outcome: result === "rejected" ? "denied" : "ok", detail: { ...(event ? { kind: event } : {}), ...(reason ? { reason } : {}), client } });
  }
  private reject(res: ServerResponse, status: number, client: string, event: string | undefined, reason: string, body: Record<string, unknown> = {}): void {
    this.record("rejected", client, event, reason);
    reply(res, status, status === 401 ? {} : body);
  }
  private ignore(res: ServerResponse, client: string, event: string | undefined, reason: string): void {
    this.record("ignored", client, event, reason);
    reply(res, 202, { ok: true });
  }

  private sourceAllowed(client: string, t: number): boolean {
    if (this.sources.size >= MAX_SOURCES) for (const [key, counter] of this.sources) if (counter.idle(t)) this.sources.delete(key);
    if (this.sources.size >= MAX_SOURCES) this.sources.clear();
    let counter = this.sources.get(client);
    if (!counter) { counter = new WindowCounter(this.sourceLimit, 60_000); this.sources.set(client, counter); }
    return counter.take(t);
  }

  /** `client` is the already-resolved peer address (rightmost untrusted forwarded hop when behind a trusted proxy). */
  async handle(req: IncomingMessage, res: ServerResponse, client: string): Promise<void> {
    if (!this.secrets.configured) { reply(res, 404, { error: "Not found." }); return; }
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); reply(res, 405, { error: "Use POST." }); return; }
    const t = this.now();
    if (!this.sourceAllowed(client, t)) {
      if (t - this.lastRateAudit > 10_000) { this.lastRateAudit = t; this.record("rejected", client, undefined, "rate_limited_source"); }
      res.setHeader("Retry-After", "60"); reply(res, 429, {}); return;
    }
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") { this.reject(res, 415, client, undefined, "content_type"); return; }
    const lengthHeader = req.headers["content-length"];
    if (lengthHeader !== undefined) {
      const length = /^\d{1,12}$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
      if (!Number.isFinite(length)) { this.reject(res, 400, client, undefined, "content_length"); return; }
      if (length > this.maxBody) { this.tooLarge(req, res, client); return; }
    }
    const signature = req.headers["x-hub-signature-256"];
    if (typeof signature !== "string" || !SIGNATURE_SHAPE.test(signature)) { this.reject(res, 401, client, undefined, "signature_missing_or_malformed"); return; }

    let raw: Buffer;
    try { raw = await this.readRaw(req); }
    catch (error) {
      if (error instanceof BodyError) { if (error.reason === "too_large") this.tooLarge(req, res, client); else this.reject(res, 408, client, undefined, "body_timeout"); return; }
      this.reject(res, 400, client, undefined, "body_read"); return;
    }
    const eventHeader = typeof req.headers["x-github-event"] === "string" ? req.headers["x-github-event"].slice(0, 40) : undefined;
    // Verification happens on the raw bytes, before the body is parsed or any header is believed.
    if (!verifySignature(raw, signature, this.secrets.active())) { this.reject(res, 401, client, undefined, "invalid_signature"); return; }
    if (!this.global.take(this.now())) { res.setHeader("Retry-After", "60"); this.record("rejected", client, undefined, "rate_limited_global"); reply(res, 429, {}); return; }

    const event = eventHeader && /^[a-z_]{1,40}$/.test(eventHeader) ? eventHeader : undefined;
    const delivery = req.headers["x-github-delivery"];
    if (typeof delivery !== "string" || !DELIVERY_SHAPE.test(delivery)) { this.reject(res, 400, client, event, "delivery_id", { error: "Bad request." }); return; }
    if (!this.dedupe.claim(delivery)) { this.ignore(res, client, event, "duplicate_delivery"); return; }
    if (event === "ping") { this.record("received", client, "ping"); reply(res, 202, { ok: true }); return; }
    if (event !== "pull_request") { this.ignore(res, client, event, "event_not_allowed"); return; }

    let payload: unknown;
    try { payload = JSON.parse(raw.toString("utf8")); } catch { this.reject(res, 400, client, event, "malformed_json", { error: "Bad request." }); return; }
    const parsed = parsePullRequestEvent(payload);
    if (!parsed.ok) { this.ignore(res, client, event, parsed.reason); return; }
    const dispatcher = this.dispatcher();
    const targets = dispatcher?.targets(parsed.repo, parsed.base) ?? [];
    if (!dispatcher || targets.length === 0) { this.ignore(res, client, event, "no_matching_trigger"); return; }

    this.record("received", client, event, `${parsed.action}:${targets.length}`);
    reply(res, 202, { ok: true });
    // Answered already: the checks run on their own, one routine per matching trigger.
    const work = (async () => { for (const target of targets) { try { await dispatcher.check(target.id); } catch { /* The poller retries at its next tick. */ } } })()
      .finally(() => { this.pending.delete(work); });
    this.pending.add(work);
  }

  private tooLarge(req: IncomingMessage, res: ServerResponse, client: string): void {
    this.record("rejected", client, undefined, "body_too_large");
    res.setHeader("Connection", "close");
    reply(res, 413, {});
    res.once("finish", () => req.destroy());
  }

  private readRaw(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0; let done = false;
      const finish = (action: () => void) => { if (done) return; done = true; clearTimeout(timer); req.off("data", onData); action(); };
      const timer = setTimeout(() => finish(() => reject(new BodyError("timeout"))), BODY_DEADLINE_MS);
      timer.unref?.();
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxBody) { finish(() => reject(new BodyError("too_large"))); return; }
        chunks.push(chunk);
      };
      req.on("data", onData);
      req.once("end", () => finish(() => resolve(Buffer.concat(chunks, size))));
      req.once("error", error => finish(() => reject(error)));
      req.once("aborted", () => finish(() => reject(new Error("aborted"))));
    });
  }
}

class BodyError extends Error { constructor(readonly reason: "too_large" | "timeout") { super(reason); } }

type ParsedEvent = { ok: true; action: string; repo: string; base: string } | { ok: false; reason: string };

/** Only what is needed to locate triggers. Nothing here authorizes anything. */
export function parsePullRequestEvent(payload: unknown): ParsedEvent {
  const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
  const body = record(payload);
  const action = body?.["action"];
  if (typeof action !== "string" || !ALLOWED_PR_ACTIONS.has(action)) return { ok: false, reason: "action_not_allowed" };
  const repo = record(body?.["repository"])?.["full_name"];
  const pull = record(body?.["pull_request"]);
  const base = record(pull?.["base"])?.["ref"];
  if (typeof repo !== "string" || !REPO_SHAPE.test(repo) || !pull || typeof base !== "string" || base.length === 0 || base.length > 200) return { ok: false, reason: "payload_shape" };
  if (pull["state"] !== "open" || pull["merged"] === true) return { ok: false, reason: "pull_request_not_open" };
  return { ok: true, action, repo, base };
}

export interface WebhookConsoleContext { receiver?: GitHubWebhookReceiver; payloadUrl?: string }

/**
 * Settings and CLI surface under /api/console/github/webhook (browser control token, owner in team mode, never the engine
 * bearer for mutations). The secret is returned exactly once, by create and rotate, and by nothing else.
 */
export function handleWebhookConsoleRequest(path: string, method: string, context: WebhookConsoleContext): { status: number; data: unknown } | null {
  if (path !== "github/webhook" && path !== "github/webhook/secret" && path !== "github/webhook/secret/rotate") return null;
  const { receiver } = context;
  if (!receiver) return path === "github/webhook" && method === "GET" ? { status: 200, data: { webhook: { serverMode: false } } } : { status: 404, data: { error: "Not found." } };
  const view = () => ({
    serverMode: true, ...receiver.status(), path: GITHUB_WEBHOOK_PATH, contentType: "application/json", events: ["Pull requests"],
    ...(context.payloadUrl ? { payloadUrl: context.payloadUrl } : {}),
  });
  if (path === "github/webhook") return method === "GET" ? { status: 200, data: { webhook: view() } } : { status: 405, data: { error: "Use GET." } };
  if (method !== "POST") return { status: 405, data: { error: "Use POST." } };
  if (path === "github/webhook/secret") {
    const secret = receiver.secrets.create();
    if (!secret) return { status: 409, data: { error: "A webhook secret already exists. Rotate it to get a new one." } };
    return { status: 201, data: { secret, webhook: view() } };
  }
  const secret = receiver.secrets.rotate();
  return { status: 200, data: { secret, graceSeconds: WEBHOOK_ROTATION_GRACE_MS / 1000, webhook: view() } };
}

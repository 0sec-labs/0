import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveOsecDbPath } from "@0/db";
import { BackendDescriptorSchema, BackendHandshakeSchema, BackendRequestIdSchema, backendCapabilitiesForApiPath, BACKEND_PROTOCOL_VERSION, homeStateDir, parseBackendHandshake, type BackendDescriptor, type BackendHandshake } from "@0/shared";

export class BackendConnectionError extends Error {
  constructor(message: string, readonly statusCode = 502) { super(message); this.name = "BackendConnectionError"; }
}
const idSchema = BackendDescriptorSchema.shape.id.refine(value => value !== "local", "The local backend ID is reserved.");
const connectionSchema = z.object({
  id: idSchema, name: z.string().trim().min(1).max(160), url: z.string().max(4096),
  bearerTokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128),
  expectedEngineId: BackendHandshakeSchema.shape.engineId.optional(),
}).strict();
const configSchema = z.object({ schemaVersion: z.literal(1), backends: z.array(connectionSchema).max(32) }).strict();
export type BackendConnectionConfig = z.infer<typeof connectionSchema>;
const MAX_BODY = 1_000_000;
const MAX_RESPONSE = 16_000_000;
const MAX_CONFIG = 65_536;

function loopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
}
function endpoint(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname)))) throw new BackendConnectionError("Backend URL must be credential-free HTTPS or loopback HTTP, without query or fragment.", 400);
  if (url.pathname.split("/").some(part => { const decoded = decodeURIComponent(part); return decoded === ".." || decoded === "." || /[\\\x00]/.test(decoded); })) throw new BackendConnectionError("Invalid backend URL path.", 400);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}
/** Trusted operator configuration only. Browser requests cannot add endpoints or secrets. */
export function loadBackendConnectionConfig(configPath?: string): BackendConnectionConfig[] {
  const path = configPath ?? join(homeStateDir(), "backends.json");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { if (!configPath && (error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG) throw new BackendConnectionError("Backend configuration must be a regular JSON file of at most 64 KiB.", 400);
    const buffer = Buffer.alloc(MAX_CONFIG + 1);
    let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
    if (length > MAX_CONFIG) throw new BackendConnectionError("Backend configuration exceeds 64 KiB.", 400);
    const config = configSchema.parse(JSON.parse(buffer.subarray(0, length).toString("utf8")));
    if (new Set(config.backends.map(row => row.id)).size !== config.backends.length) throw new BackendConnectionError("Backend connection IDs must be unique.", 400);
    for (const row of config.backends) endpoint(row.url);
    return config.backends;
  } finally { closeSync(fd); }
}
export function createBackendHandshake(dbPath?: string, capabilities: string[] = []): BackendHandshake {
  const db = resolveOsecDbPath(dbPath);
  let engineId = `engine-${randomUUID()}`;
  if (db !== ":memory:") {
    const path = `${resolve(db)}.engine-id`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, `${engineId}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).size > 256) throw new BackendConnectionError("Invalid persisted backend engine identity.", 500);
      const buffer = Buffer.alloc(257);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      if (count > 256) throw new BackendConnectionError("Invalid persisted backend engine identity.", 500);
      engineId = BackendHandshakeSchema.shape.engineId.parse(buffer.subarray(0, count).toString("utf8").trim());
    } finally { closeSync(fd); }
  }
  return { protocolVersion: BACKEND_PROTOCOL_VERSION, engineId, capabilities, platform: { os: process.platform, pathStyle: process.platform === "win32" ? "windows" : "posix" }, serverInstanceId: randomUUID() };
}
export function backendBearerFromEnv(name: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!name) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new BackendConnectionError("Invalid engine token environment variable name.", 400);
  const token = env[name];
  if (!token || token.length < 32 || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) throw new BackendConnectionError(`Configure a valid engine credential of 32–4096 characters.`, 400);
  return token;
}
function apiPath(path: string): string {
  if (!path.startsWith("/api/") || path.length > 8192 || /[\x00-\x20\\]/.test(path)) throw new BackendConnectionError("Backend requests require an API path.", 400);
  const url = new URL(path, "http://backend.invalid");
  for (const segment of path.split("?")[0]!.split("/")) {
    const decoded = decodeURIComponent(segment);
    if (decoded === "." || decoded === ".." || /[\/\\\x00]/.test(decoded)) throw new BackendConnectionError("Invalid backend request path.", 400);
  }
  if (url.pathname.startsWith("/api/backends")) throw new BackendConnectionError("Backend connection registration is not a proxy operation.", 403);
  return `${url.pathname}${url.search}`;
}
function capabilities(path: string): string[] {
  const pathname = path.split("?")[0]!;
  const required = backendCapabilitiesForApiPath(pathname);
  if (!required.length && pathname !== "/api/backend/handshake") throw new BackendConnectionError("API route is not admitted by the backend transport.", 403);
  return required;
}
async function boundedResponse(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) { signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted(); if (next.done) break; length += next.value.length; if (length > maximum) throw new BackendConnectionError("Backend response exceeds the transport limit."); chunks.push(next.value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener("abort", onAbort); reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}
interface RequestOptions { method?: string; body?: unknown; signal?: AbortSignal; stream?: boolean; requestId?: string; lastEventId?: string }
export interface BackendConnectionRegistryOptions { configPath?: string; connections?: BackendConnectionConfig[]; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; localHandshake?: BackendHandshake; timeoutMs?: number }
/** Each request is permanently bound to a configured ID and its server-held credential. */
export class BackendConnectionRegistry {
  readonly #connections: Map<string, BackendConnectionConfig>;
  readonly #descriptors = new Map<string, BackendDescriptor>();
  readonly #pins = new Map<string, string>();
  readonly #handshakes = new Map<string, { value: BackendHandshake; at: number }>();
  readonly #pending = new Map<string, Promise<{ backend: BackendDescriptor; handshake?: BackendHandshake; error?: string }>>();
  readonly #env: NodeJS.ProcessEnv;
  readonly #fetch: typeof fetch;
  readonly #local: BackendHandshake;
  readonly #timeoutMs: number;
  readonly #abort = new AbortController();
  #active = 0;
  constructor(options: BackendConnectionRegistryOptions = {}) {
    const rows = options.connections ?? loadBackendConnectionConfig(options.configPath);
    const parsed = configSchema.parse({ schemaVersion: 1, backends: rows }).backends;
    if (new Set(parsed.map(row => row.id)).size !== parsed.length) throw new BackendConnectionError("Backend IDs must be unique.", 400);
    this.#connections = new Map(parsed.map(row => [row.id, { ...row, url: endpoint(row.url).href }]));
    this.#env = { ...(options.env ?? process.env) }; this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#local = parseBackendHandshake(options.localHandshake ?? createBackendHandshake());
    this.#descriptors.set("local", { id: "local", name: "Local engine", transport: "local", status: "connected", protocolVersion: this.#local.protocolVersion, capabilities: this.#local.capabilities, platform: this.#local.platform });
    for (const row of parsed) this.#descriptors.set(row.id, { id: row.id, name: row.name, transport: "http", status: "disconnected", capabilities: [] });
  }
  list(): BackendDescriptor[] { return structuredClone([...this.#descriptors.values()]); }
  async handshake(id: string): Promise<{ backend: BackendDescriptor; handshake?: BackendHandshake; error?: string }> {
    if (id === "local") return { backend: this.list()[0]!, handshake: structuredClone(this.#local) };
    if (!this.#connections.has(id)) throw new BackendConnectionError("Backend is not registered.", 404);
    const pending = this.#pending.get(id); if (pending) return pending;
    const run = this.#probe(id); this.#pending.set(id, run);
    try { return await run; } finally { this.#pending.delete(id); }
  }
  async #probe(id: string) {
    const row = this.#connections.get(id)!;
    const descriptor = this.#descriptors.get(id)!;
    descriptor.status = "connecting"; delete descriptor.error;
    try {
      const response = await this.#send(row, "/api/backend/handshake", {});
      if (!response.ok) throw new BackendConnectionError("Backend handshake was rejected.", response.status === 401 || response.status === 403 ? 403 : 502);
      const raw = BackendHandshakeSchema.parse(await response.json());
      descriptor.protocolVersion = raw.protocolVersion;
      if (raw.protocolVersion !== BACKEND_PROTOCOL_VERSION) { descriptor.status = "incompatible"; throw new BackendConnectionError("Backend protocol is incompatible.", 409); }
      const pin = row.expectedEngineId ?? this.#pins.get(id);
      if (pin && pin !== raw.engineId) { descriptor.status = "incompatible"; throw new BackendConnectionError("Backend engine identity changed; review the trusted connection configuration.", 409); }
      this.#pins.set(id, raw.engineId); this.#handshakes.set(id, { value: raw, at: Date.now() });
      Object.assign(descriptor, { status: "connected", capabilities: raw.capabilities, platform: raw.platform });
      return { backend: structuredClone(descriptor), handshake: raw };
    } catch (error) {
      if (descriptor.status !== "incompatible") descriptor.status = "disconnected";
      // Transport errors may contain credential-bearing endpoints; expose only fixed messages.
      descriptor.error = error instanceof BackendConnectionError ? error.message : "Backend connection failed.";
      this.#handshakes.delete(id);
      return { backend: structuredClone(descriptor), error: descriptor.error };
    }
  }
  async request(id: string, path: string, options: RequestOptions = {}): Promise<Response> {
    if (id === "local") throw new BackendConnectionError("Local requests must use the local engine adapter.", 400);
    const row = this.#connections.get(id); if (!row) throw new BackendConnectionError("Backend is not registered.", 404);
    const canonical = apiPath(path);
    const cached = this.#handshakes.get(id);
    const view = cached && Date.now() - cached.at < 5000 ? { backend: this.#descriptors.get(id)! } : await this.handshake(id);
    if (view.backend.status !== "connected") throw new BackendConnectionError(view.backend.error ?? "Backend is disconnected.", view.backend.status === "incompatible" ? 409 : 503);
    for (const required of capabilities(canonical)) if (!view.backend.capabilities.includes(required)) throw new BackendConnectionError(`Backend does not support ${required}.`, 409);
    try { return await this.#send(row, canonical, options); }
    catch (error) { if (!options.signal?.aborted && (!(error instanceof BackendConnectionError) || error.statusCode >= 500 || error.statusCode === 409)) { this.#descriptors.get(id)!.status = error instanceof BackendConnectionError && error.statusCode === 409 ? "incompatible" : "disconnected"; this.#handshakes.delete(id); } throw error; }
  }
  async #send(row: BackendConnectionConfig, path: string, options: RequestOptions): Promise<Response> {
    if (this.#active >= 32) throw new BackendConnectionError("Backend request capacity exceeded.", 429);
    this.#abort.signal.throwIfAborted();
    const method = (options.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "POST", "PATCH", "DELETE", "PUT"].includes(method)) throw new BackendConnectionError("Backend method is not allowed.", 405);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined && Buffer.byteLength(body) > MAX_BODY) throw new BackendConnectionError("Backend request body exceeds 1 MB.", 413);
    const token = backendBearerFromEnv(row.bearerTokenEnv, this.#env)!;
    const requestId = BackendRequestIdSchema.safeParse(options.requestId).success ? options.requestId! : randomUUID();
    const expectedEngineId = this.#pins.get(row.id) ?? row.expectedEngineId;
    if (options.lastEventId !== undefined && (options.lastEventId.length > 4096 || /[\x00-\x20\x7f]/.test(options.lastEventId))) throw new BackendConnectionError("Invalid event replay cursor.", 400);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new BackendConnectionError("Backend request timed out.", 504)), this.#timeoutMs);
    const signal = AbortSignal.any([this.#abort.signal, timeout.signal, ...(options.signal ? [options.signal] : [])]);
    this.#active++;
    let retained = false;
    try {
      const url = new URL(`.${path}`, row.url);
      const response = await this.#fetch(url, { method, body, redirect: "error", signal, headers: { Authorization: `Bearer ${token}`, Accept: options.stream ? "text/event-stream" : "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), "X-0-Request-ID": requestId, ...(expectedEngineId ? { "X-0-Expected-Engine-ID": expectedEngineId } : {}), ...(options.stream && options.lastEventId ? { "Last-Event-ID": options.lastEventId } : {}) } });
      if (path !== "/api/backend/handshake" && expectedEngineId && response.headers.get("x-0-engine-id") !== expectedEngineId) { await response.body?.cancel(); throw new BackendConnectionError("Backend response identity does not match the registered engine.", 409); }
      const type = response.headers.get("content-type") ?? "application/json";
      if (type.includes("text/event-stream")) {
        if (!options.stream || method !== "GET") { await response.body?.cancel(); throw new BackendConnectionError("Unexpected event stream response."); }
        clearTimeout(timer);
        const reader = response.body?.getReader();
        let released = false;
        let onAbort: (() => void) | undefined;
        const release = () => { if (!released) { released = true; this.#active--; if (onAbort) signal.removeEventListener("abort", onAbort); } };
        let eventBytes = 0; let lineBytes = 0;
        const body = reader ? new ReadableStream<Uint8Array>({
          start: controller => {
            onAbort = () => { release(); void reader.cancel().catch(() => {}); controller.error(new BackendConnectionError("Backend event connection closed.", 499)); };
            if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
          },
          pull: async controller => {
            try {
              signal.throwIfAborted();
              const next = await reader.read();
              if (next.done) { release(); controller.close(); return; }
              for (const byte of next.value) {
                eventBytes++;
                if (byte === 10) { if (lineBytes === 0) eventBytes = 0; lineBytes = 0; }
                else if (byte !== 13) lineBytes++;
                if (eventBytes > MAX_BODY) throw new BackendConnectionError("Backend event exceeds 1 MB.");
              }
              controller.enqueue(next.value);
            } catch (error) { release(); await reader.cancel().catch(() => {}); controller.error(error); }
          },
          cancel: async () => { release(); await reader.cancel().catch(() => {}); },
        }) : null;
        if (body) retained = true;
        return new Response(body, { status: response.status, headers: { "Content-Type": type, "X-0-Request-ID": requestId, ...(response.headers.get("x-0-engine-id") ? { "X-0-Engine-ID": response.headers.get("x-0-engine-id")! } : {}) } });
      }
      const data = await boundedResponse(response, MAX_RESPONSE, signal);
      return new Response([204, 205, 304].includes(response.status) || method === "HEAD" ? null : data as BodyInit, { status: response.status, headers: { "Content-Type": type, "X-0-Request-ID": requestId, ...(response.headers.get("x-0-engine-id") ? { "X-0-Engine-ID": response.headers.get("x-0-engine-id")! } : {}) } });
    } catch (error) { if (error instanceof BackendConnectionError) throw error; if (timeout.signal.aborted) throw new BackendConnectionError("Backend request timed out.", 504); if (options.signal?.aborted) throw new BackendConnectionError("Backend request disconnected.", 499); throw new BackendConnectionError("Backend transport failed."); }
    finally { clearTimeout(timer); if (!retained) this.#active--; }
  }
  dispose(): void { this.#abort.abort(); }
}

async function requestJson(req: IncomingMessage): Promise<unknown> {
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { const buffer = Buffer.from(chunk as Buffer); length += buffer.length; if (length > MAX_BODY) { req.resume(); throw new BackendConnectionError("Backend request exceeds 1 MB.", 413); } chunks.push(buffer); }
  if (!length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")); } catch { throw new BackendConnectionError("Backend request must contain valid JSON.", 400); }
}
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
/** Call only after local origin and control-token authorization. Returns a local dispatch rewrite. */
export async function handleBackendConnectionRequest(req: IncomingMessage, res: ServerResponse, url: URL, registry: BackendConnectionRegistry): Promise<{ handled: boolean; localPath?: string }> {
  if (url.pathname === "/api/backends") { if (req.method !== "GET") throw new BackendConnectionError("Backend registry is read-only.", 405); json(res, 200, { backends: registry.list() }); return { handled: true }; }
  if (url.pathname === "/api/backend/handshake") { if (req.method !== "GET") throw new BackendConnectionError("Method not allowed.", 405); json(res, 200, (await registry.handshake("local")).handshake); return { handled: true }; }
  const match = url.pathname.match(/^\/api\/backends\/([^/]+)\/(handshake|proxy(?:\/.*)?)$/);
  if (!match) return { handled: false };
  const id = decodeURIComponent(match[1]!);
  if (match[2] === "handshake") { if (req.method !== "GET") throw new BackendConnectionError("Method not allowed.", 405); json(res, 200, await registry.handshake(id)); return { handled: true }; }
  const path = apiPath(`${url.pathname.slice(url.pathname.indexOf("/proxy/") + "/proxy".length)}${url.search}`);
  if (id === "local") return { handled: false, localPath: path };
  const abort = new AbortController();
  const disconnect = () => abort.abort();
  req.once("aborted", disconnect); res.once("close", disconnect);
  try {
    const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await requestJson(req);
    const stream = req.headers.accept?.includes("text/event-stream") === true;
    const response = await registry.request(id, path, { method: req.method, body, stream, signal: abort.signal, lastEventId: typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : undefined, requestId: typeof req.headers["x-0-request-id"] === "string" ? req.headers["x-0-request-id"] : undefined });
    if (res.destroyed) return { handled: true };
    res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store", "X-0-Request-ID": response.headers.get("x-0-request-id") ?? randomUUID(), ...(response.headers.get("x-0-engine-id") ? { "X-0-Engine-ID": response.headers.get("x-0-engine-id")! } : {}), "X-Content-Type-Options": "nosniff", ...(stream ? { "X-Accel-Buffering": "no" } : {}) });
    if (!response.body) { res.end(); return { handled: true }; }
    const reader = response.body.getReader();
    const onAbort = () => { void reader.cancel().catch(() => {}); };
    abort.signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!abort.signal.aborted) { const next = await reader.read(); if (next.done) break; if (next.value.length > MAX_RESPONSE) throw new BackendConnectionError("Backend stream chunk exceeds the transport limit."); if (!res.write(next.value)) await new Promise<void>(resolve => {
          const done = () => { res.removeListener("drain", done); res.removeListener("close", done); resolve(); };
          res.once("drain", done); res.once("close", done);
        }); }
      res.end();
    } catch { res.destroy(); }
    finally { abort.signal.removeEventListener("abort", onAbort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return { handled: true };
  } finally { req.removeListener("aborted", disconnect); res.removeListener("close", disconnect); }
}

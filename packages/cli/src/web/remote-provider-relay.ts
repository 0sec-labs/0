import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { LlmApiRuntime } from "@0/core";
import type { ConsoleRuntimeSelection } from "@0/shared";

export class ProviderRelayError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }
const GRANT_IDLE_MS = 30 * 60_000;
const REDELIVER_UNACKNOWLEDGED_MS = 5000;
const modelId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const grantInput = z.object({ epoch: z.string().min(1).max(256), provider: z.literal("chatgpt-codex"), models: z.array(modelId).min(1).max(16), model: modelId }).strict();
const eventsInput = z.object({ epoch: z.string(), sessionId: z.string().min(1).max(256), events: z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("headers"), status: z.number().int().min(200).max(599).refine(status => ![204,205,304].includes(status)), contentType: z.string().max(128).regex(/^(text\/event-stream|application\/json)(?:;[^\r\n]*)?$/i).transform(value => value.split(";")[0]!.toLowerCase()) }).strict(),
  z.object({ kind: z.literal("chunk"), data: z.string().max(65536).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict(),
  z.object({ kind: z.literal("end") }).strict(), z.object({ kind: z.literal("error") }).strict(),
])).min(1).max(16) }).strict();
export interface ProviderRelayGrant { id: string; epoch: string; provider: "chatgpt-codex"; models: string[]; model: string; expiresAt: string }
interface Pending {
  requestId: string; grantId: string; epoch: string; sessionId: string; provider: "chatgpt-codex"; model: string; body: string;
  startedAt: number; delivered: boolean; deliveredAt?: number; received: number; buffered: number; ended: boolean;
  resolve: (response: Response) => void; reject: (error: Error) => void;
  controller?: ReadableStreamDefaultController<Uint8Array>; headers: boolean; queue: Uint8Array[];
  timer: ReturnType<typeof setTimeout>; cleanup: () => void;
}
interface GrantState { grant: ProviderRelayGrant; sessionId?: string; requests: Map<string, Pending>; cancelled: string[] }

/** Inference only. No credential, provider URL, scope or tool authority is accepted here. */
export class RemoteProviderRelayBroker {
  readonly epoch: string;
  #grants = new Map<string, GrantState>();
  #disposed = false;
  constructor(options: { epoch: string }) { this.epoch = options.epoch; }
  create(input: unknown): ProviderRelayGrant {
    const value = grantInput.parse(input);
    if (this.#disposed || value.epoch !== this.epoch) throw new ProviderRelayError("Provider relay engine epoch changed.", 409);
    if (!value.models.includes(value.model) || new Set(value.models).size !== value.models.length) throw new ProviderRelayError("Provider relay requires an exact model allowlist.");
    for (const [id,state] of this.#grants) if (Date.parse(state.grant.expiresAt) <= Date.now()) this.close(id);
    if (this.#grants.size >= 32) throw new ProviderRelayError("Provider relay grant limit reached.", 429);
    const grant: ProviderRelayGrant = { id: randomUUID(), epoch: this.epoch, provider: value.provider, models: value.models, model: value.model, expiresAt: new Date(Date.now() + GRANT_IDLE_MS).toISOString() };
    this.#grants.set(grant.id, { grant, requests: new Map(), cancelled: [] }); return structuredClone(grant);
  }
  #get(id: string): GrantState {
    const state = this.#grants.get(id);
    if (!state || this.#disposed) throw new ProviderRelayError("Provider relay grant is unavailable. Reconnect the local model source.", 410);
    if (Date.parse(state.grant.expiresAt) <= Date.now()) { this.close(id); throw new ProviderRelayError("Provider relay grant expired. Reconnect the local model source.", 410); }
    return state;
  }
  bind(id: string, sessionId: string): ProviderRelayGrant {
    const state = this.#get(id);
    if (state.sessionId && state.sessionId !== sessionId) throw new ProviderRelayError("Provider relay grant belongs to another conversation.", 409);
    state.sessionId = sessionId; return structuredClone(state.grant);
  }
  transport(id: string, sessionId: string) {
    const grant = this.bind(id, sessionId);
    return { provider: grant.provider, models: grant.models, identity: `relay:${grant.epoch}:${grant.id}`, request: (envelope: { provider: "chatgpt-codex"; model: string; body: string }, signal?: AbortSignal) => this.request(id, sessionId, envelope, signal) };
  }
  runtime(id: string, sessionId: string, selection: ConsoleRuntimeSelection = {}): LlmApiRuntime {
    const grant = this.bind(id, sessionId);
    if (selection.providerId && selection.providerId !== grant.provider) throw new ProviderRelayError("Provider is outside the local model grant.", 403);
    return new LlmApiRuntime({ type: "api", timeout: 120_000, model: selection.model ?? grant.model, provider: "chatgpt-codex", singleModel: selection.singleModel, agentModels: selection.agentModels, autoRoute: selection.autoRoute,
      providerTransport: this.transport(id, sessionId) });
  }
  request(id: string, sessionId: string, envelope: { provider: "chatgpt-codex"; model: string; body: string }, signal?: AbortSignal): Promise<Response> {
    const state = this.#get(id);
    if (state.sessionId !== sessionId || envelope.provider !== state.grant.provider || !state.grant.models.includes(envelope.model)) throw new ProviderRelayError("Request is outside the local model grant.", 403);
    signal?.throwIfAborted();
    if (state.requests.size >= 4) throw new ProviderRelayError("Local model request limit reached.", 429);
    if (Buffer.byteLength(envelope.body) > 4 * 1024 * 1024) throw new ProviderRelayError("Local model request exceeds 4 MiB.", 413);
    const body = JSON.parse(envelope.body) as Record<string, unknown>;
    if (body.model !== envelope.model || body.background === true || body.store === true || !Array.isArray(body.input)) throw new ProviderRelayError("Invalid granted Responses request.");
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const cancel = () => this.#finish(state, pending, new Error("Local provider request cancelled."));
      const pending: Pending = { ...envelope, requestId, grantId: id, epoch: this.epoch, sessionId, startedAt: Date.now(), delivered: false, received: 0, buffered: 0, ended: false, headers: false, queue: [], resolve, reject,
        timer: setTimeout(() => this.#finish(state, pending, new Error("Local provider relay timed out.")), 120_000), cleanup: () => signal?.removeEventListener("abort", cancel) };
      signal?.addEventListener("abort", cancel, { once: true }); state.requests.set(requestId, pending);
      if (signal?.aborted) cancel();
    });
  }
  status(id: string) {
    const state = this.#get(id);
    return { grantId: id, epoch: this.epoch, sessionId: state.sessionId, expiresAt: state.grant.expiresAt,
      pending: [...state.requests.values()].map(request => ({ id: request.requestId, delivered: request.delivered, headers: request.headers, receivedBytes: request.received, bufferedBytes: request.buffered, ageMs: Math.max(0, Date.now() - request.startedAt) })), cancelledCount: state.cancelled.length };
  }
  poll(id: string) {
    const state = this.#get(id);
    // The authenticated local pump keeps its existing exact account/model grant
    // alive. A disconnected pump still loses authority after 30 minutes idle.
    state.grant.expiresAt = new Date(Date.now() + GRANT_IDLE_MS).toISOString();
    const requests = [...state.requests.values()];
    const next = requests.find(request => !request.delivered) ?? requests.find(request => !request.headers && Date.now() - (request.deliveredAt ?? request.startedAt) >= REDELIVER_UNACKNOWLEDGED_MS);
    if (next) { next.delivered = true; next.deliveredAt = Date.now(); }
    const cancelled = state.cancelled.splice(0);
    return { grantId: id, epoch: this.epoch, sessionId: state.sessionId, expiresAt: state.grant.expiresAt, requests: next ? [{ requestId: next.requestId, grantId: id, epoch: this.epoch, sessionId: next.sessionId, provider: next.provider, model: next.model, body: next.body }] : [], cancelled };
  }
  #finish(state: GrantState, request: Pending, error?: Error) {
    if (request.ended) return;
    request.ended = true; clearTimeout(request.timer); request.cleanup(); state.requests.delete(request.requestId);
    if (error) { state.cancelled.push(request.requestId); state.cancelled = state.cancelled.slice(-64); if (!request.headers) request.reject(error); request.controller?.error(error); }
    else if (!request.headers) request.reject(new Error("Provider relay ended without response headers."));
    else if (request.queue.length === 0) request.controller?.close();
  }
  events(id: string, requestId: string, input: unknown) {
    if (Buffer.byteLength(JSON.stringify(input)) > 512 * 1024) throw new ProviderRelayError("Provider event batch exceeds 512 KiB.", 413);
    const state = this.#get(id); const value = eventsInput.parse(input);
    if (value.epoch !== this.epoch || value.sessionId !== state.sessionId) throw new ProviderRelayError("Provider relay ownership or epoch changed.", 409);
    const pending = state.requests.get(requestId); if (!pending) throw new ProviderRelayError("Provider request is no longer pending.", 410);
    for (const event of value.events) {
      if (pending.ended) throw new ProviderRelayError("Provider response has ended.", 409);
      if (event.kind === "headers") {
        if (pending.headers) throw new ProviderRelayError("Duplicate provider response headers.", 409);
        pending.headers = true;
        const stream = new ReadableStream<Uint8Array>({ start: controller => { pending.controller = controller; }, pull: controller => { const chunk = pending.queue.shift(); if (chunk) { pending.buffered -= chunk.byteLength; controller.enqueue(chunk); } else if (pending.ended) controller.close(); }, cancel: () => this.#finish(state, pending, new Error("Provider response reader cancelled.")) });
        pending.resolve(new Response(stream, { status: event.status, headers: { "content-type": event.contentType } }));
      } else if (event.kind === "chunk") {
        if (!pending.headers) throw new ProviderRelayError("Provider headers must precede body chunks.", 409);
        const bytes = Buffer.from(event.data, "base64");
        if (bytes.toString("base64") !== event.data || bytes.byteLength > 49152) throw new ProviderRelayError("Invalid provider body chunk.");
        pending.received += bytes.byteLength;
        if (pending.received > 16 * 1024 * 1024 || pending.buffered + bytes.byteLength > 2 * 1024 * 1024) { this.#finish(state, pending, new Error("Provider response exceeded relay limits.")); throw new ProviderRelayError("Provider response exceeded relay limits.", 413); }
        if ((pending.controller?.desiredSize ?? 0) > 0 && pending.queue.length === 0) pending.controller!.enqueue(bytes);
        else { pending.queue.push(bytes); pending.buffered += bytes.byteLength; }
      } else this.#finish(state, pending, event.kind === "error" ? new Error("Local model source disconnected or failed.") : undefined);
    }
    return { accepted: true };
  }
  close(id: string): void { const state = this.#grants.get(id); if (!state) return; for (const pending of [...state.requests.values()]) this.#finish(state, pending, new Error("Local model source disconnected.")); this.#grants.delete(id); }
  dispose(): void { for (const id of [...this.#grants.keys()]) this.close(id); this.#disposed = true; }
}

/** Call only after the normal authenticated engine/team authorization boundary. */
export async function handleRemoteProviderRelayRequest(req: IncomingMessage, res: ServerResponse, url: URL, broker: RemoteProviderRelayBroker, readBody: () => Promise<unknown>): Promise<boolean> {
  const base = "/api/console/provider-relays";
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
  const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  try {
    if (url.pathname === base && req.method === "POST") { send(201, { grant: broker.create(await readBody()) }); return true; }
    const status = /^\/api\/console\/provider-relays\/([a-f0-9-]{36})\/status$/.exec(url.pathname);
    if (status) { if (req.method !== "GET") throw new ProviderRelayError("Method not allowed.", 405); send(200, broker.status(status[1]!)); return true; }
    const match = /^\/api\/console\/provider-relays\/([a-f0-9-]{36})(?:\/requests(?:\/([a-f0-9-]{36})\/events)?)?$/.exec(url.pathname);
    if (!match) throw new ProviderRelayError("Unknown provider relay route.", 404);
    if (req.method === "DELETE" && !url.pathname.endsWith("/requests") && !match[2]) { broker.close(match[1]!); send(200, { closed: true }); }
    else if (req.method === "GET" && url.pathname.endsWith("/requests")) send(200, broker.poll(match[1]!));
    else if (req.method === "POST" && match[2]) send(200, broker.events(match[1]!, match[2], await readBody()));
    else throw new ProviderRelayError("Method not allowed.", 405);
  } catch (error) { send(error instanceof ProviderRelayError ? error.statusCode : 400, { error: error instanceof ProviderRelayError ? error.message : "Invalid provider relay request." }); }
  return true;
}

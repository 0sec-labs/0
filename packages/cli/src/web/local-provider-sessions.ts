import { z } from "zod";
import type { ConsoleRuntimeSelection, DesktopConsoleSession } from "@0/shared";
import { createLocalProviderRelay, type LocalProviderRelayOptions, type RelayRegistry } from "./local-provider-relay.js";

export class LocalProviderSessionError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }
const resourceId = z.string().min(1).max(160).regex(/^[^\x00-\x20\x7f]+$/);
const runtimeSchema = z.object({ providerId: z.string().min(1).max(256).optional(), model: z.string().min(1).max(256).optional(), reasoningEffort: z.string().min(1).max(256).optional(), agentModels: z.record(z.string().min(1).max(64), z.string().min(1).max(256)).refine(value => Object.keys(value).length <= 32).optional(), singleModel: z.boolean().optional(), autoRoute: z.boolean().optional() }).strict();
const createSchema = z.object({ workflowId: z.string().min(1).max(128).optional(), target: z.string().max(4096).optional(), title: z.string().max(200).optional(), role: z.enum(["discovery", "attack", "verify", "report", "audit", "review"]).optional(), autonomyMode: z.enum(["standard", "recon", "copilot", "yolo"]).optional(), scope: z.record(z.string(), z.unknown()).nullable().optional(), runtime: runtimeSchema.optional(), findingId: z.string().max(256).optional(), findingIntent: z.enum(["investigate", "verify", "draft_fix", "impact"]).optional() }).strict();
type Relay = Awaited<ReturnType<typeof createLocalProviderRelay>>;
interface Managed { owner: string; relay: Relay; selection: ConsoleRuntimeSelection; configuring: boolean }
export interface LocalProviderSessionsOptions { registry: RelayRegistry; signal?: AbortSignal; createRelay?: (options: LocalProviderRelayOptions) => Promise<Relay> }

/** Local ownership map contains capabilities; none of its grant IDs are browser input. */
export class LocalProviderSessions {
  private sessions = new Map<string, Managed>();
  private lifetime = new AbortController();
  private creating = 0;
  private reconnecting = new Set<string>();
  constructor(private readonly options: LocalProviderSessionsOptions) {}
  private key(backendId: string, sessionId: string) { return JSON.stringify([backendId, sessionId]); }
  private signal() { return this.options.signal ? AbortSignal.any([this.lifetime.signal, this.options.signal]) : this.lifetime.signal; }
  private assertBackend(backendId: string) { if (!resourceId.safeParse(backendId).success || backendId === "local") throw new LocalProviderSessionError("Choose a registered remote host."); this.signal().throwIfAborted(); }
  private async request(backendId: string, path: string, method: string, body: unknown) {
    const response = await this.options.registry.request(backendId, path, { method, body, signal: this.signal() });
    if (!response.ok) { await response.body?.cancel(); throw new LocalProviderSessionError("The remote host rejected this conversation change.", response.status); }
    const value = await response.json() as { session?: DesktopConsoleSession };
    if (!value?.session || !resourceId.safeParse(value.session.id).success) throw new LocalProviderSessionError("The remote host returned an invalid conversation.", 502);
    return value.session;
  }
  async create(backendId: string, input: unknown, ownerId = "local"): Promise<{ session: DesktopConsoleSession }> {
    this.assertBackend(backendId);
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw new LocalProviderSessionError("Invalid remote conversation configuration; model grants are issued locally.");
    if (this.sessions.size + this.creating >= 32) throw new LocalProviderSessionError("Close a local model connection before creating another remote conversation.", 429);
    this.creating++;
    let relay: Relay | undefined;
    try {
      relay = await (this.options.createRelay ?? createLocalProviderRelay)({ registry: this.options.registry, backendId, selection: parsed.data.runtime, signal: this.signal() });
      const session = await this.request(backendId, "/api/console/sessions", "POST", { ...parsed.data, runtime: { ...parsed.data.runtime, providerId: relay.info.providerId, model: relay.info.model }, modelSource: { kind: "local", grantId: relay.grant.id } });
      this.signal().throwIfAborted();
      const key = this.key(backendId, session.id);
      if (this.sessions.has(key)) throw new LocalProviderSessionError("The host reused an existing conversation ID.", 409);
      relay.start(session.id);
      this.sessions.set(key, { owner: ownerId, relay, selection: parsed.data.runtime ?? {}, configuring: false });
      return { session };
    } catch (error) { await relay?.close(); throw error; }
    finally { this.creating--; }
  }
  async configure(backendId: string, sessionId: string, runtime: unknown, ownerId = "local"): Promise<{ session: DesktopConsoleSession }> {
    this.assertBackend(backendId);
    if (!resourceId.safeParse(sessionId).success) throw new LocalProviderSessionError("Invalid conversation ID.");
    const managed = this.sessions.get(this.key(backendId, sessionId));
    if (!managed) return this.reconnect(backendId, sessionId, runtime, ownerId);
    if (managed.owner !== ownerId) throw new LocalProviderSessionError("This local model connection does not belong to the current workspace.", 404);
    const parsed = runtimeSchema.safeParse(runtime);
    if (!parsed.success) throw new LocalProviderSessionError("Invalid local model selection.");
    if (managed.configuring) throw new LocalProviderSessionError("Wait for the current model change.", 409);
    managed.configuring = true;
    let replacement: Relay | undefined;
    try {
      const selection = { ...managed.selection, ...parsed.data };
      replacement = await (this.options.createRelay ?? createLocalProviderRelay)({ registry: this.options.registry, backendId, selection, signal: this.signal() });
      const session = await this.request(backendId, `/api/console/sessions/${encodeURIComponent(sessionId)}/configuration`, "PATCH", { runtime: { ...selection, providerId: replacement.info.providerId, model: replacement.info.model }, modelSource: { kind: "local", grantId: replacement.grant.id } });
      if (session.id !== sessionId) throw new LocalProviderSessionError("The host returned a different conversation.", 409);
      this.signal().throwIfAborted();
      replacement.start(sessionId);
      const previous = managed.relay; managed.relay = replacement; managed.selection = selection; replacement = undefined;
      await previous.close();
      return { session };
    } finally { managed.configuring = false; await replacement?.close(); }
  }
  /** Explicitly restore a saved local-model marker after either engine restarted. */
  async reconnect(backendId: string, sessionId: string, runtime: unknown, ownerId = "local"): Promise<{ session: DesktopConsoleSession }> {
    this.assertBackend(backendId);
    if (!resourceId.safeParse(sessionId).success) throw new LocalProviderSessionError("Invalid conversation ID.");
    const key = this.key(backendId, sessionId), existing = this.sessions.get(key);
    if (existing) return this.configure(backendId, sessionId, runtime, ownerId);
    const parsed = runtimeSchema.safeParse(runtime);
    if (!parsed.success) throw new LocalProviderSessionError("Invalid local model selection.");
    if (this.reconnecting.has(key)) throw new LocalProviderSessionError("Wait for this conversation to reconnect.", 409);
    if (this.sessions.size + this.creating >= 32) throw new LocalProviderSessionError("Close a local model connection before reconnecting another conversation.", 429);
    this.reconnecting.add(key); this.creating++;
    let replacement: Relay | undefined;
    try {
      const response = await this.options.registry.request(backendId, `/api/console/sessions/${encodeURIComponent(sessionId)}`, { method: "GET", signal: this.signal() });
      if (!response.ok) { await response.body?.cancel(); throw new LocalProviderSessionError("This remote conversation could not be reopened.", response.status); }
      const snapshot = (await response.json() as { snapshot?: { session?: { id?: string; status?: string }; runtime?: { modelSource?: string; model?: string } } }).snapshot;
      if (snapshot?.session?.id !== sessionId || snapshot.runtime?.modelSource !== "local") throw new LocalProviderSessionError("Only an existing local-model conversation can reconnect through this route.", 409);
      if (snapshot.session.status !== "ready") throw new LocalProviderSessionError("Wait until this remote conversation is idle before reconnecting its model.", 409);
      const selection = runtimeSchema.parse({ providerId: "chatgpt-codex", ...(snapshot.runtime.model ? { model: snapshot.runtime.model } : {}), ...parsed.data });
      replacement = await (this.options.createRelay ?? createLocalProviderRelay)({ registry: this.options.registry, backendId, selection, signal: this.signal() });
      const session = await this.request(backendId, `/api/console/sessions/${encodeURIComponent(sessionId)}/configuration`, "PATCH", { runtime: { ...selection, providerId: replacement.info.providerId, model: replacement.info.model }, modelSource: { kind: "local", grantId: replacement.grant.id } });
      if (session.id !== sessionId) throw new LocalProviderSessionError("The host returned a different conversation.", 409);
      this.signal().throwIfAborted();
      replacement.start(sessionId);
      this.sessions.set(key, { owner: ownerId, relay: replacement, selection, configuring: false });
      replacement = undefined;
      return { session };
    } finally { this.creating--; this.reconnecting.delete(key); await replacement?.close(); }
  }
  async status(backendId: string, sessionId: string, ownerId = "local") {
    this.assertBackend(backendId);
    const managed = this.sessions.get(this.key(backendId, sessionId));
    if (!managed || managed.owner !== ownerId) throw new LocalProviderSessionError("This local model connection does not belong to the current workspace.", 404);
    const local = managed.relay.status();
    try {
      const response = await this.options.registry.request(backendId, `/api/console/provider-relays/${encodeURIComponent(managed.relay.grant.id)}/status`, { method: "GET", signal: AbortSignal.any([this.signal(), AbortSignal.timeout(5000)]) });
      if (!response.ok) { await response.body?.cancel(); return { local, remote: { available: false, status: response.status } }; }
      const body = await response.json() as Record<string, unknown>;
      if (body.grantId !== managed.relay.grant.id || body.epoch !== managed.relay.grant.epoch || body.sessionId !== sessionId) throw new Error("scope");
      const pending = z.array(z.object({ delivered: z.boolean(), headers: z.boolean(), receivedBytes: z.number().finite().nonnegative(), bufferedBytes: z.number().finite().nonnegative(), ageMs: z.number().finite().nonnegative() }).strip()).max(4).parse(body.pending);
      const cancelledCount = z.number().int().nonnegative().parse(body.cancelledCount);
      return { local, remote: { available: true, pending, cancelledCount } };
    } catch { return { local, remote: { available: false } }; }
  }
  async release(backendId: string, sessionId: string, ownerId = "local") {
    const key = this.key(backendId, sessionId), managed = this.sessions.get(key);
    if (!managed || managed.owner !== ownerId) return;
    this.sessions.delete(key); await managed.relay.close();
  }
  async dispose() { this.lifetime.abort(); const entries = [...this.sessions.values()]; this.sessions.clear(); await Promise.allSettled(entries.map(entry => entry.relay.close())); }
}

import type { ConsoleRuntimeSelection, ConsoleRuntimeSnapshot } from "@0/shared";
import type { WorkbenchProviderGrant } from "@0/core";
import type { WorkbenchProviderTransport } from "../workbench-console-session.js";

export interface LocalRelayProvider {
  info: ConsoleRuntimeSnapshot;
  grant: WorkbenchProviderGrant;
  transport: WorkbenchProviderTransport;
}

/** Resolve the selected local account without exporting credentials or host resources. */
export async function createLocalRelayProvider(selection: ConsoleRuntimeSelection = {}, signal?: AbortSignal): Promise<LocalRelayProvider> {
  const [{ createWebConsoleRuntime }, { createWorkbenchProviderBroker }] = await Promise.all([
    import("./operator-services.js"), import("@0/core"),
  ]);
  signal?.throwIfAborted();
  if (selection.providerId && selection.providerId !== "chatgpt-codex") throw new Error("Local model relay currently supports ChatGPT Codex only. Choose the local ChatGPT connection.");
  const { runtime, info } = await createWebConsoleRuntime({ ...selection, providerId: "chatgpt-codex" });
  signal?.throwIfAborted();
  const provider = runtime.resolvedProvider();
  const model = runtime.resolvedModel();
  if (provider !== "chatgpt-codex" || !model || !info.configured || !info.diagnostics.valid) throw new Error("Local model relay requires a connected ChatGPT Codex account and an explicit model.");
  const routing = runtime.modelSelection();
  const models = [...new Set([model, ...Object.values(routing.agentModels).filter(value => value !== "auto")])];
  const broker = createWorkbenchProviderBroker({ provider, models, resolveCredentials: runtime.workbenchCredentialResolver(), signal });
  return { info, grant: broker.grant, transport: { provider, models: broker.grant.models, request: (request, requestSignal) => broker.request(request, requestSignal), close: broker.close } };
}

export interface RelayRegistry {
  handshake(id: string): Promise<{ backend: { status: string }; handshake?: { serverInstanceId?: string } }>;
  request(id: string, path: string, options: { method: string; body?: unknown; signal: AbortSignal }): Promise<Response>;
}
export interface LocalProviderRelayGrant { id: string; epoch: string; provider: "chatgpt-codex"; models: string[]; model: string; expiresAt: string }
interface RelayRequest { requestId: string; grantId: string; epoch: string; sessionId: string; provider: "chatgpt-codex"; model: string; body: string }
export interface LocalProviderRelayStatus {
  phase: "registered" | "polling" | "reconnecting" | "requesting" | "streaming" | "failed" | "closed";
  lastPollAt: string | null;
  seenRequests: number;
  activeRequests: number;
  error?: "poll_rejected" | "scope_changed" | "request_rejected" | "upstream_failed" | "response_rejected";
  lastUpstreamStatus?: number;
  lastTransportStatus?: number;
  lastFailureStage?: "provider_request" | "headers_post" | "reader_read" | "chunk_post" | "sse_parse" | "end_post" | "poll";
  lastFailureName?: string;
  lastFailureCode?: string;
  lastFailureTransportStatus?: number;
  bytesForwarded: number;
  consecutivePollFailures?: number;
}
export interface LocalProviderRelayOptions {
  registry: RelayRegistry;
  backendId: string;
  selection?: ConsoleRuntimeSelection;
  signal?: AbortSignal;
  onError?: (message: string) => void;
  /** Trusted local injection for tests; never accepted from a browser/remote host. */
  createProvider?: (selection: ConsoleRuntimeSelection, signal: AbortSignal) => Promise<LocalRelayProvider>;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x20\x7f]/.test(value); }
class RelayResponseError extends Error { constructor(readonly code: string, readonly status: number) { super("Provider relay transport failed."); this.name = "RelayResponseError"; } }
export function safeRelayFailure(error: unknown): { name: string; code: string } {
  if (error instanceof RelayResponseError) return { name: error.name, code: error.code };
  const name = error instanceof Error && ["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError", "BackendConnectionError"].includes(error.name) ? error.name : "OtherError";
  const known: Record<string, string> = {
    "Provider request cancelled or timed out": "provider_timeout_or_cancel",
    "Provider response stream failed": "provider_stream_failed",
    "Host provider request failed": "provider_request_failed",
    "Provider broker concurrency limit reached": "provider_concurrency",
    "Provider broker session budget exhausted": "provider_budget",
    "Provider broker is closed": "provider_closed",
    "Provider or model is not granted to this workbench": "provider_grant_rejected",
    "Provider request exceeds its byte limit": "provider_input_limit",
    "Invalid provider request JSON": "provider_input_json",
    "Provider broker permits only stateless streamed Responses requests": "provider_body_shape",
    "Provider broker refuses hosted tools and external tool destinations": "provider_tool_destination",
    "Unsupported provider input item": "provider_input_type",
    "Provider broker permits text input only": "provider_text_only",
    "Remote provider relay scope changed.": "remote_scope_changed",
    "Invalid provider cancellation.": "remote_cancel_invalid",
    "Remote provider request exceeds its approval.": "remote_request_not_approved",
    "Remote provider relay exceeded its request budget.": "relay_budget",
    "Provider output exceeds approval.": "provider_output_limit",
    "Provider SSE event exceeds response limit.": "provider_sse_limit",
    "Backend response identity does not match the registered engine.": "remote_identity_changed",
    "Backend response exceeds the transport limit.": "remote_response_limit",
    "Backend request timed out.": "remote_timeout",
    "Backend transport failed.": "remote_transport_failed",
    "Backend request capacity exceeded.": "remote_capacity",
  };
  return { name, code: error instanceof Error ? Object.hasOwn(known, error.message) ? known[error.message]! : "unclassified" : "unclassified" };
}
async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) { await response.body?.cancel(); throw new RelayResponseError("remote_http_rejected", response.status); }
  try { return object(await response.json()); } catch { throw new RelayResponseError("remote_invalid_json", response.status); }
}
async function pause(signal: AbortSignal, delayMs = 500): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const abort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Polls are reads: a transient host outage must not revoke an account grant. */
function retryablePollFailure(error: unknown): boolean {
  if (error instanceof RelayResponseError) return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
  if (!(error instanceof Error) || error.name !== "BackendConnectionError") return false;
  const status = (error as Error & { statusCode?: number }).statusCode;
  return (status === 504 && error.message === "Backend request timed out.") ||
    (status === 502 && error.message === "Backend transport failed.") ||
    (status === 429 && error.message === "Backend request capacity exceeded.");
}
function failureTransportStatus(error: unknown, fallback?: number): number | undefined {
  if (error instanceof RelayResponseError) return error.status;
  if (error instanceof Error && error.name === "BackendConnectionError" && typeof (error as Error & { statusCode?: number }).statusCode === "number") return (error as Error & { statusCode: number }).statusCode;
  return fallback;
}

/** Responses SSE can finish semantically while the HTTP socket remains open. */
export function providerSseCompletion(maximumBytes = 8 * 1024 * 1024) {
  const decoder = new TextDecoder();
  let buffer = "", completed = false;
  return (chunk: Uint8Array): boolean => {
    if (completed) return true;
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index);
      if (Buffer.byteLength(block) > maximumBytes) throw new Error("Provider SSE event exceeds response limit.");
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { completed = true; break; }
      try {
        const event = JSON.parse(data) as { type?: unknown } | null;
        if (event && ["response.completed", "response.failed", "response.incomplete", "error"].includes(String(event.type))) { completed = true; break; }
      } catch { /* Non-JSON/comment events cannot terminate a response. */ }
    }
    if (Buffer.byteLength(buffer) > maximumBytes) throw new Error("Provider SSE event exceeds response limit.");
    return completed;
  };
}

/** Authenticated pull relay. Remote inference input never chooses a URL, headers or credentials. */
export async function createLocalProviderRelay(options: LocalProviderRelayOptions) {
  if (options.backendId === "local" || !id(options.backendId)) throw new Error("Provider relay requires a registered remote host.");
  const lifetime = new AbortController();
  const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
  signal.throwIfAborted();
  const peer = await options.registry.handshake(options.backendId);
  const epoch = peer.handshake?.serverInstanceId;
  if (peer.backend.status !== "connected" || !id(epoch)) throw new Error("Provider relay requires a connected, identified host.");
  const local = await (options.createProvider ?? createLocalRelayProvider)(options.selection ?? {}, signal);
  const base = "/api/console/provider-relays";
  let grant: LocalProviderRelayGrant;
  try {
    const response = await json(await options.registry.request(options.backendId, base, { method: "POST", body: { epoch, provider: local.grant.provider, models: local.grant.models, model: local.info.model }, signal }));
    const candidate = object(response.grant);
    if (!id(candidate.id) || candidate.epoch !== epoch || candidate.provider !== local.grant.provider || !Array.isArray(candidate.models) || candidate.models.length !== local.grant.models.length || new Set(candidate.models).size !== candidate.models.length || candidate.models.some(model => typeof model !== "string" || !local.grant.models.includes(model)) || candidate.model !== local.info.model || typeof candidate.expiresAt !== "string" || !Number.isFinite(Date.parse(candidate.expiresAt))) throw new Error("Remote provider relay grant does not match the local approval.");
    grant = candidate as unknown as LocalProviderRelayGrant;
  } catch (error) { await local.transport.close?.(); throw error; }
  const diagnostic: LocalProviderRelayStatus = { phase: "registered", lastPollAt: null, seenRequests: 0, activeRequests: 0, bytesForwarded: 0 };
  const grantPath = `${base}/${encodeURIComponent(grant.id)}`;
  let revocation: Promise<void> | undefined;
  const revokeGrant = () => revocation ??= options.registry.request(options.backendId, grantPath, { method: "DELETE", signal: AbortSignal.timeout(5000) }).then(async response => { await response.body?.cancel(); }).catch(() => {});
  const active = new Map<string, AbortController>();
  const seen = new Set<string>();
  const tasks = new Set<Promise<void>>();
  let boundSession: string | undefined, polling: Promise<void> | undefined, closing: Promise<void> | undefined;
  const abortActive = () => { for (const controller of active.values()) controller.abort(); };
  signal.addEventListener("abort", abortActive, { once: true });
  const remoteRequest = async (path: string, optionsValue: { method: string; body?: unknown; signal: AbortSignal }) => {
    const response = await options.registry.request(options.backendId, path, optionsValue);
    diagnostic.lastTransportStatus = response.status; return response;
  };
  const send = (request: RelayRequest, events: unknown[], callerSignal: AbortSignal) => remoteRequest(`${grantPath}/requests/${encodeURIComponent(request.requestId)}/events`, { method: "POST", body: { epoch, sessionId: boundSession, events }, signal: callerSignal }).then(json);
  async function service(request: RelayRequest) {
    const controller = new AbortController();
    active.set(request.requestId, controller);
    diagnostic.phase = "requesting"; diagnostic.activeRequests = active.size; delete diagnostic.error;
    const requestSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(local.grant.limits.timeoutMs)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => { void reader?.cancel().catch(() => {}); };
    requestSignal.addEventListener("abort", cancelReader, { once: true });
    let stage: NonNullable<LocalProviderRelayStatus["lastFailureStage"]> = "provider_request";
    try {
      const response = await local.transport.request({ provider: request.provider, model: request.model, body: request.body }, requestSignal);
      diagnostic.lastUpstreamStatus = response.status;
      stage = "headers_post";
      await send(request, [{ kind: "headers", status: response.status, contentType: response.headers.get("content-type") || "text/event-stream" }], requestSignal);
      diagnostic.phase = "streaming";
      if (response.body) {
        reader = response.body.getReader();
        let bytes = 0;
        const completed = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ? providerSseCompletion(local.grant.limits.maxResponseBytes) : undefined;
        while (!requestSignal.aborted) {
          stage = "reader_read";
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > local.grant.limits.maxResponseBytes) throw new Error("Provider output exceeds approval.");
          stage = "chunk_post";
          for (let offset = 0; offset < chunk.value.byteLength; offset += 32 * 1024) {
            const portion = chunk.value.subarray(offset, offset + 32 * 1024);
            await send(request, [{ kind: "chunk", data: Buffer.from(portion).toString("base64") }], requestSignal);
            diagnostic.bytesForwarded += portion.byteLength;
          }
          stage = "sse_parse";
          if (completed?.(chunk.value)) break;
        }
        requestSignal.throwIfAborted();
      }
      stage = "end_post";
      await send(request, [{ kind: "end" }], requestSignal);
    } catch (error) {
      // A poll failure aborts every reader. Keep that primary failure instead of
      // replacing it with the secondary stream cancellation it caused.
      if (!signal.aborted && !controller.signal.aborted) {
        const failure = safeRelayFailure(error);
        diagnostic.lastFailureStage = stage; diagnostic.lastFailureName = failure.name; diagnostic.lastFailureCode = failure.code;
        diagnostic.lastFailureTransportStatus = failureTransportStatus(error, diagnostic.lastTransportStatus);
        diagnostic.error = diagnostic.phase === "requesting" ? "upstream_failed" : "response_rejected";
        // No local exception text, auth details or host paths cross this boundary.
        await send(request, [{ kind: "error" }], AbortSignal.any([signal, AbortSignal.timeout(5000)])).catch(() => {});
      }
    } finally {
      requestSignal.removeEventListener("abort", cancelReader);
      controller.abort();
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      active.delete(request.requestId);
      diagnostic.activeRequests = active.size;
      if (!signal.aborted && !active.size) diagnostic.phase = "polling";
    }
  }
  async function poll() {
    let failureCategory: NonNullable<LocalProviderRelayStatus["error"]> = "poll_rejected";
    try {
      if (!active.size) diagnostic.phase = "polling";
      while (!signal.aborted) {
        failureCategory = "poll_rejected";
        let body: Record<string, unknown>;
        try {
          body = await json(await remoteRequest(`${grantPath}/requests`, { method: "GET", signal }));
        } catch (error) {
          if (signal.aborted || !retryablePollFailure(error)) throw error;
          const failure = safeRelayFailure(error);
          diagnostic.phase = "reconnecting"; diagnostic.error = "poll_rejected";
          diagnostic.lastFailureStage = "poll"; diagnostic.lastFailureName = failure.name; diagnostic.lastFailureCode = failure.code;
          diagnostic.lastFailureTransportStatus = failureTransportStatus(error, diagnostic.lastTransportStatus);
          diagnostic.consecutivePollFailures = (diagnostic.consecutivePollFailures ?? 0) + 1;
          await pause(signal, Math.min(5000, 500 * 2 ** Math.min(diagnostic.consecutivePollFailures - 1, 4)));
          continue;
        }
        diagnostic.consecutivePollFailures = 0;
        if (diagnostic.error === "poll_rejected") delete diagnostic.error;
        diagnostic.phase = active.size ? "streaming" : "polling";
        diagnostic.lastPollAt = new Date().toISOString(); failureCategory = "scope_changed";
        if (body.grantId !== grant.id || body.epoch !== epoch || (body.sessionId !== undefined && body.sessionId !== boundSession) || !Array.isArray(body.requests) || !Array.isArray(body.cancelled) || body.requests.length > 4 || body.cancelled.length > 256) throw new Error("Remote provider relay scope changed.");
        for (const requestId of body.cancelled) { if (!id(requestId)) throw new Error("Invalid provider cancellation."); active.get(requestId)?.abort(); }
        for (const value of body.requests) {
          const request = object(value);
          failureCategory = "request_rejected";
          if (!id(request.requestId) || request.grantId !== grant.id || request.epoch !== epoch || request.sessionId !== boundSession || request.provider !== local.grant.provider || typeof request.model !== "string" || !local.grant.models.includes(request.model) || typeof request.body !== "string" || Buffer.byteLength(request.body) > local.grant.limits.maxRequestBytes) throw new Error("Remote provider request exceeds its approval.");
          if (seen.has(request.requestId)) continue;
          if (seen.size >= local.grant.limits.maxRequests || active.size >= Math.min(4, local.grant.limits.maxConcurrent)) throw new Error("Remote provider relay exceeded its request budget.");
          seen.add(request.requestId); diagnostic.seenRequests = seen.size;
          const task = service(request as unknown as RelayRequest);
          tasks.add(task); void task.finally(() => tasks.delete(task));
        }
        await pause(signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        diagnostic.phase = "failed"; diagnostic.error = failureCategory;
        const failure = safeRelayFailure(error);
        diagnostic.lastFailureStage = "poll"; diagnostic.lastFailureName = failure.name; diagnostic.lastFailureCode = failure.code;
        diagnostic.lastFailureTransportStatus = failureTransportStatus(error, diagnostic.lastTransportStatus);
      }
      if (!signal.aborted) options.onError?.("The local model connection to this host ended. Reconnect the host before continuing.");
      lifetime.abort();
    } finally { if (signal.aborted && diagnostic.phase !== "failed") diagnostic.phase = "closed"; abortActive(); await local.transport.close?.(); await revokeGrant(); }
  }
  return {
    grant, info: local.info,
    status: (): LocalProviderRelayStatus => ({ ...diagnostic }),
    start(sessionId: string) {
      if (!id(sessionId) || signal.aborted || boundSession) throw new Error("Provider relay must bind once to an active remote session.");
      boundSession = sessionId; polling = poll();
    },
    close() {
      return closing ??= (async () => {
        diagnostic.phase = "closed";
        lifetime.abort(); abortActive(); signal.removeEventListener("abort", abortActive);
        await local.transport.close?.();
        await Promise.allSettled([...tasks, ...(polling ? [polling] : [])]);
        await revokeGrant();
      })();
    },
  };
}

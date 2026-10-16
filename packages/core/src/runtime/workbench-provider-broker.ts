import { VERSION } from "@0/shared";
import { CODEX_PROTOCOL_HEADERS } from "./llm-api.js";

/** The guest supplies a request, never an endpoint, headers or credentials. */
export interface WorkbenchProviderRequest { provider: string; model: string; body: string; }
export interface WorkbenchProviderLimits {
  maxRequests: number;
  maxConcurrent: number;
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxTotalResponseBytes: number;
}
export interface WorkbenchProviderGrant {
  protocol: 1;
  provider: "chatgpt-codex";
  models: readonly string[];
  limits: Readonly<WorkbenchProviderLimits>;
}
export interface WorkbenchProviderBrokerOptions {
  provider: "chatgpt-codex";
  /** Host-selected exact models; guest requests cannot expand this list. */
  models: readonly string[];
  /** Host-only closure. Never serialize this or its result into admission. */
  resolveCredentials: () => Promise<{ accessToken: string; accountId?: string }>;
  limits?: Partial<WorkbenchProviderLimits>;
  signal?: AbortSignal;
  /** Dependency injection for qualification; never obtained from a guest. */
  fetchImpl?: typeof fetch;
}
export interface WorkbenchProviderBroker {
  readonly grant: WorkbenchProviderGrant;
  request(request: WorkbenchProviderRequest, signal?: AbortSignal): Promise<Response>;
  close(): Promise<void>;
}
export const DEFAULT_WORKBENCH_PROVIDER_LIMITS: Readonly<WorkbenchProviderLimits> = Object.freeze({
  maxRequests: 256, maxConcurrent: 8, timeoutMs: 120_000,
  maxRequestBytes: 4 * 1024 * 1024, maxResponseBytes: 8 * 1024 * 1024,
  maxTotalResponseBytes: 64 * 1024 * 1024,
});
const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const BODY_KEYS = new Set(["model", "input", "instructions", "store", "stream", "reasoning", "include", "tools", "tool_choice", "parallel_tool_calls", "context_management"]);

function checkedLimits(input: Partial<WorkbenchProviderLimits> = {}): Readonly<WorkbenchProviderLimits> {
  const limits = { ...DEFAULT_WORKBENCH_PROVIDER_LIMITS, ...input };
  for (const [key, ceiling] of Object.entries(DEFAULT_WORKBENCH_PROVIDER_LIMITS)) {
    const value = limits[key as keyof WorkbenchProviderLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error(`Invalid provider broker limit: ${key}`);
  }
  return Object.freeze(limits);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validateRequest(request: WorkbenchProviderRequest, grant: WorkbenchProviderGrant): void {
  if (!record(request) || Object.keys(request).some(key => !["provider", "model", "body"].includes(key)) ||
    request.provider !== grant.provider || !grant.models.includes(request.model) || typeof request.body !== "string") {
    throw new Error("Provider or model is not granted to this workbench");
  }
  if (Buffer.byteLength(request.body) > grant.limits.maxRequestBytes) throw new Error("Provider request exceeds its byte limit");
  let body: unknown;
  try { body = JSON.parse(request.body); } catch { throw new Error("Invalid provider request JSON"); }
  if (!record(body) || Object.keys(body).some(key => !BODY_KEYS.has(key)) || body.model !== request.model ||
    body.store !== false || body.stream !== true || typeof body.instructions !== "string" || !Array.isArray(body.input)) {
    throw new Error("Provider broker permits only stateless streamed Responses requests");
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(tool => !record(tool) || tool.type !== "function"))) {
    throw new Error("Provider broker refuses hosted tools and external tool destinations");
  }
  // Existing native runtime emits only text, local function calls and retained
  // reasoning. No guest-supplied remote files/images or provider-side actions.
  for (const item of body.input) {
    if (!record(item) || (item.type !== undefined && !["message", "function_call", "function_call_output", "reasoning", "compaction"].includes(String(item.type)))) {
      throw new Error("Unsupported provider input item");
    }
    if (item.content !== undefined && (!Array.isArray(item.content) || item.content.some(part => !record(part) || !["input_text", "output_text"].includes(String(part.type)) || typeof part.text !== "string"))) {
      throw new Error("Provider broker permits text input only");
    }
  }
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Provider request cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
/** Redact even when an upstream error echoes a token across chunk boundaries. */
class TokenRedactor {
  private tail = "";
  constructor(private readonly secret: string) {}
  push(text: string, final = false): string {
    const combined = (this.tail + text).replaceAll(this.secret, "[redacted]");
    this.tail = "";
    if (!final) {
      for (let length = Math.min(this.secret.length - 1, combined.length); length > 0; length--) {
        if (combined.endsWith(this.secret.slice(0, length))) {
          this.tail = combined.slice(-length);
          return combined.slice(0, -length);
        }
      }
    }
    return combined;
  }
}

/** No server/listener is opened here: the controller owns authenticated transport. */
export function createWorkbenchProviderBroker(options: WorkbenchProviderBrokerOptions): WorkbenchProviderBroker {
  if (options.provider !== "chatgpt-codex") throw new Error("Unsupported workbench provider; no fallback is permitted");
  if (!Array.isArray(options.models) || !options.models.length || options.models.length > 32 ||
    options.models.some(model => typeof model !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(model))) throw new Error("Invalid exact provider model grant");
  const grant: WorkbenchProviderGrant = Object.freeze({ protocol: 1, provider: options.provider,
    models: Object.freeze([...new Set(options.models)]), limits: checkedLimits(options.limits) });
  const lifetime = new AbortController();
  const active = new Set<AbortController>();
  const stopped = () => lifetime.abort();
  options.signal?.addEventListener("abort", stopped, { once: true });
  if (options.signal?.aborted) stopped();
  let requests = 0, totalBytes = 0, closed = false;
  return {
    grant,
    async request(request, callerSignal) {
      if (closed || lifetime.signal.aborted) throw new Error("Provider broker is closed");
      callerSignal?.throwIfAborted();
      validateRequest(request, grant);
      if (requests >= grant.limits.maxRequests || totalBytes >= grant.limits.maxTotalResponseBytes) throw new Error("Provider broker session budget exhausted");
      if (active.size >= grant.limits.maxConcurrent) throw new Error("Provider broker concurrency limit reached");
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
      const timeout = setTimeout(() => controller.abort(), grant.limits.timeoutMs);
      active.add(controller); requests++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true; clearTimeout(timeout); active.delete(controller);
      };
      try {
        const credentials = await abortable(options.resolveCredentials(), signal);
        if (!credentials.accessToken || credentials.accessToken.length > 16384 || /[\r\n\0]/.test(credentials.accessToken) ||
          (credentials.accountId && (credentials.accountId.length > 256 || /[\r\n\0]/.test(credentials.accountId)))) {
          throw new Error("Host provider credentials unavailable");
        }
        signal.throwIfAborted();
        const upstream = await abortable((options.fetchImpl ?? fetch)(ENDPOINT, {
          method: "POST", redirect: "error", signal, body: request.body,
          headers: { ...CODEX_PROTOCOL_HEADERS, "Content-Type": "application/json", Accept: "text/event-stream",
            Authorization: `Bearer ${credentials.accessToken}`, "User-Agent": `0/${VERSION}`,
            "x-codex-routing-hint": `model=${request.model}`,
            ...(credentials.accountId ? { "ChatGPT-Account-Id": credentials.accountId } : {}),
          },
        }), signal);
        if (!upstream.body) { release(); return new Response(null, { status: upstream.status }); }
        const reader = upstream.body.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder();
        const redactor = new TokenRedactor(credentials.accessToken);
        let bytes = 0;
        let abortListener: (() => void) | undefined;
        const finish = () => { if (abortListener) signal.removeEventListener("abort", abortListener); release(); };
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            abortListener = () => {
              void reader.cancel().catch(() => {});
              finish(); stream.error(new Error("Provider request cancelled or timed out"));
            };
            signal.addEventListener("abort", abortListener, { once: true });
            if (signal.aborted) abortListener();
          },
          async pull(stream) {
            try {
              const chunk = await abortable(reader.read(), signal);
              if (chunk.done) {
                const tail = redactor.push(decoder.decode(), true);
                if (tail) stream.enqueue(encoder.encode(tail));
                finish(); stream.close(); return;
              }
              bytes += chunk.value.byteLength; totalBytes += chunk.value.byteLength;
              if (bytes > grant.limits.maxResponseBytes || totalBytes > grant.limits.maxTotalResponseBytes) {
                controller.abort(); return;
              }
              const safe = redactor.push(decoder.decode(chunk.value, { stream: true }));
              if (safe) stream.enqueue(encoder.encode(safe));
            } catch {
              void reader.cancel().catch(() => {}); finish();
              if (!signal.aborted) stream.error(new Error("Provider response stream failed"));
            }
          },
          async cancel() { controller.abort(); finish(); await reader.cancel().catch(() => {}); },
        });
        return new Response(body, { status: upstream.status,
          headers: { "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream" } });
      } catch {
        const wasAborted = signal.aborted;
        release(); controller.abort();
        // Exception text can contain credentials or host paths; never return it.
        throw new Error(wasAborted ? "Provider request cancelled or timed out" : "Host provider request failed");
      }
    },
    async close() {
      closed = true; lifetime.abort();
      options.signal?.removeEventListener("abort", stopped);
      for (const controller of active) controller.abort();
    },
  };
}

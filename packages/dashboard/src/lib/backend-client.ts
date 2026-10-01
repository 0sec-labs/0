import { BackendResourceRefSchema, requireBackendCapability, backendCapabilitiesForApiPath, type BackendDescriptor } from "@0/shared/dist/backend-protocol.js";
/** A request facade permanently bound to its owning engine, never a mutable selection. */
export class BackendClient {
  readonly backendId: string;
  #lifetime = new AbortController();
  constructor(backendId: string, private readonly transport: (path: string, init?: RequestInit) => Promise<Response>, private readonly descriptor?: BackendDescriptor) {
    BackendResourceRefSchema.parse({ backendId, id: "client" });
    if (descriptor && descriptor.id !== backendId) throw new Error("Backend descriptor belongs to another engine.");
    this.backendId = backendId;
  }
  get signal(): AbortSignal { return this.#lifetime.signal; }
  route(path: string): string {
    const parsed = new URL(path, "http://backend.invalid");
    if (!path.startsWith("/api/") || path.includes("\\") || parsed.origin !== "http://backend.invalid" || !parsed.pathname.startsWith("/api/") || path.startsWith("/api/backends")) throw new Error("Backend requests require an engine API path.");
    return this.backendId === "local" ? path : `/api/backends/${encodeURIComponent(this.backendId)}/proxy${path}`;
  }
  async request(path: string, init?: RequestInit): Promise<Response> {
    this.signal.throwIfAborted();
    const capabilities = backendCapabilitiesForApiPath(new URL(path, "http://backend.invalid").pathname);
    for (const capability of capabilities) if (this.descriptor) requireBackendCapability(this.descriptor, capability);
    const signal = init?.signal ? AbortSignal.any([this.signal, init.signal]) : this.signal;
    const response = await this.transport(this.route(path), { ...init, signal });
    // A late response cannot revive a disposed UI scope or trigger its follow-up actions.
    this.signal.throwIfAborted();
    return response;
  }
  dispose(): void { this.#lifetime.abort(new DOMException("Backend view disconnected.", "AbortError")); }
}

export function backendStorageKey(backendId: string, key: string): string {
  return `0-backend:${JSON.stringify([backendId, key])}`;
}
export function backendRoute(pathname: string): { backendId: string; basename: string } {
  const match = /^\/b\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})(?:\/|$)/.exec(pathname);
  if (match) { BackendResourceRefSchema.parse({ backendId: match[1], id: "route" }); return { backendId: match[1]!, basename: `/b/${match[1]}` }; }
  return { backendId: "local", basename: "" };
}

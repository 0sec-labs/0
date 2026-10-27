export interface ChatResourceRef { backendId: string; id: string }
const segment = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Dock identifiers must include the owner: session IDs can collide across hosts. */
export function chatResourceKey(ref: ChatResourceRef): string {
  if (!segment.test(ref.backendId) || !segment.test(ref.id)) throw new Error("Invalid host or conversation identifier");
  return `${ref.backendId}~${ref.id}`;
}
export function parseChatResourceKey(key: string, defaultBackendId: string): ChatResourceRef | undefined {
  const split = key.indexOf("~");
  const backendId = split < 0 ? defaultBackendId : key.slice(0, split);
  const id = split < 0 ? key : key.slice(split + 1);
  return segment.test(backendId) && segment.test(id) ? { backendId, id } : undefined;
}
export function backendRouteHref(backendId: string, path: string): string {
  if (!segment.test(backendId) || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("Invalid host route");
  return backendId === "local" ? path : `/b/${encodeURIComponent(backendId)}${path}`;
}

/** Include the authenticated account in every host transport/cache lifetime. */
export function chatHostScopeKey(backendId: string, workspaceId?: string, userId?: string): string {
  return JSON.stringify([backendId, workspaceId ?? null, userId ?? null]);
}

/** A chat selector may create another chat, but never falls back to global selection. */
export function boundChatHostSelection(registry: import("../backend-context").BackendSelection | null, backendId: string, onSelectHost?: (id: string) => void, reconnect?: () => void) {
  return { backends: registry?.backends ?? [], backendId, status: registry?.backendId === backendId ? registry.status : registry?.backends.find(host => host.id === backendId)?.status ?? "disconnected", select: onSelectHost ?? (() => {}), reconnect: reconnect ?? (() => {}) };
}

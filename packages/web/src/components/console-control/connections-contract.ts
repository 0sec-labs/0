
/** Pure client for the connection routes (/api/console/connections/*). Every call takes an injected fetch so it is testable without a DOM. */
export type FetchJson = <T>(path: string, init?: RequestInit) => Promise<T>;
const asString = (value: unknown) => typeof value === "string" && value !== "" ? value : undefined;
const asNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown) => list(value).filter((entry): entry is string => typeof entry === "string");

/** The host answered "no such route": an older build, not an application failure. */
export const isUnsupported = (error: unknown) => error instanceof Error && /^(404\b|not found|unknown route|no such route)/i.test(error.message.trim());

const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
const enc = encodeURIComponent;

export interface ConnectionUsage { available?: boolean; window?: unknown }
export interface ConnectionEntry { id: string; providerId: string; accountId: string; kind: string; label: string; defaultLabel: string; active: boolean; order: number; disabledModels: string[]; usage: ConnectionUsage | null }
/** `GET connections/:id/usage` -> `{ usage }`. Only OpenRouter reports real numbers; everything else says why not. Never invent values. */
export interface ConnectionUsageResult { available: boolean; window: unknown; reason: string | null }
export function normalizeConnectionUsage(raw: unknown): ConnectionUsageResult {
  const usage = asRecord(asRecord(raw).usage);
  const available = usage.available === true && Object.keys(asRecord(usage.window)).length > 0;
  return { available, window: available ? usage.window : null, reason: available ? null : asString(usage.reason) ?? "not_exposed" };
}
const USAGE_NOTES: Record<string, string> = {
  not_exposed: "Usage isn't available for this provider.",
  no_saved_key: "Save a key for this connection to see usage.",
  credentials_rejected: "The provider rejected this key, so usage can't be shown.",
  provider_error: "The provider didn't return usage right now.",
  provider_unreachable: "Couldn't reach the provider to check usage.",
};
/** Muted one-liner for an unavailable usage result. */
export const usageUnavailableNote = (reason: string | null | undefined): string => USAGE_NOTES[reason ?? "not_exposed"] ?? USAGE_NOTES.not_exposed!;

export interface ConnectionsState { connections: ConnectionEntry[]; spread: Record<string, boolean> }
export function normalizeConnections(raw: unknown): ConnectionsState {
  const root = asRecord(raw);
  const connections = list(root.connections).flatMap((entry): ConnectionEntry[] => {
    const item = asRecord(entry); const id = asString(item.id); const providerId = asString(item.providerId); const accountId = asString(item.accountId);
    if (!id || !providerId || !accountId) return [];
    const usage = asRecord(item.usage);
    return [{ id, providerId, accountId, kind: asString(item.kind) ?? "api_key", label: asString(item.label) ?? asString(item.defaultLabel) ?? accountId, defaultLabel: asString(item.defaultLabel) ?? accountId, active: item.active === true, order: asNumber(item.order) ?? 0, disabledModels: strings(item.disabledModels), usage: Object.keys(usage).length ? { available: usage.available === true, window: usage.window } : null }];
  });
  const spread = Object.fromEntries(Object.entries(asRecord(root.spread)).map(([key, value]) => [key, value === true]));
  return { connections, spread };
}
export const connectionsClient = (fetchJson: FetchJson) => ({
  list: async (signal?: AbortSignal) => normalizeConnections(await fetchJson("/api/console/connections", { signal })),
  rename: async (id: string, label: string | null) => normalizeConnections(await fetchJson(`/api/console/connections/${enc(id)}`, send("PATCH", { label }))),
  reorder: async (providerId: string, accountIds: string[]) => normalizeConnections(await fetchJson("/api/console/connections/order", send("PUT", { providerId, accountIds }))),
  spread: async (providerId: string, enabled: boolean) => normalizeConnections(await fetchJson("/api/console/connections/spread", send("PUT", { providerId, enabled }))),
  usage: async (id: string, signal?: AbortSignal) => normalizeConnectionUsage(await fetchJson(`/api/console/connections/${enc(id)}/usage`, { signal })),
  setDisabledModels: (id: string, disabled: string[]) => fetchJson<unknown>(`/api/console/connections/${enc(id)}/models`, send("PUT", { disabled })),
});

import type { ModelsResponse } from "@/components/console-control/contracts";

export const MODEL_CATALOG_STALE_MS = 60_000;
export const MODEL_CATALOG_CACHE_MS = 600_000;
const MAX_CACHE_CHARS = 2_000_000;
const PREFIX = "0:model-catalog:v1:";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export interface ModelCatalogScope {
  backendId: string;
  teamMode?: boolean;
  workspaceId?: string;
  userId?: string;
  connectionIdentity?: string | null;
  providerId?: string;
}
export function modelCatalogKey(scope: ModelCatalogScope) {
  return ["console-models", scope.providerId ?? "all", scope.backendId, scope.workspaceId ?? null, scope.userId ?? null, scope.connectionIdentity ?? null, scope.teamMode ?? false] as const;
}
function browserStorage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; }
}
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max; }
/** Whitelist catalog metadata: never retain credentials, diagnostics, or arbitrary server fields. */
function metadata(value: unknown): ModelsResponse | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.models) || data.models.length > 5000 || !Array.isArray(data.roles) || data.roles.length > 64) return;
  const models: ModelsResponse["models"] = [];
  for (const row of data.models) {
    if (!row || typeof row !== "object") return;
    const model = row as Record<string, unknown>;
    if (!text(model.id, 1024) || !model.id || !text(model.provider, 128) || !model.provider || !text(model.price, 256) || !["account", "public-catalog"].includes(String(model.source))) return;
    if (model.contextWindowTokens !== null && (typeof model.contextWindowTokens !== "number" || !Number.isFinite(model.contextWindowTokens) || model.contextWindowTokens <= 0)) return;
    models.push({ id: model.id, provider: model.provider, price: model.price, contextWindowTokens: model.contextWindowTokens as number | null, source: model.source as "account" | "public-catalog" });
  }
  if (!data.roles.every(role => text(role, 64)) || !(data.providerId === null || text(data.providerId, 128))) return;
  return { models, roles: [...data.roles], providerId: data.providerId as string | null, diagnostics: [] };
}
function storageKey(scope: ModelCatalogScope) { return PREFIX + JSON.stringify(modelCatalogKey(scope)); }
export function readModelCatalog(scope: ModelCatalogScope, storage = browserStorage(), now = Date.now()): ModelsResponse | undefined {
  if (!storage) return;
  const key = storageKey(scope);
  try {
    const raw = storage.getItem(key);
    if (!raw) return;
    if (raw.length > MAX_CACHE_CHARS) { storage.removeItem(key); return; }
    const cached = JSON.parse(raw);
    if (!cached || typeof cached.savedAt !== "number" || cached.savedAt > now || now - cached.savedAt >= MODEL_CATALOG_CACHE_MS) { storage.removeItem(key); return; }
    const result = metadata(cached.data);
    if (!result) storage.removeItem(key);
    return result;
  } catch { try { storage.removeItem(key); } catch { /* Storage may be unavailable. */ } return; }
}
export function writeModelCatalog(scope: ModelCatalogScope, value: ModelsResponse, storage = browserStorage(), now = Date.now()): void {
  const data = metadata(value);
  if (!storage || !data) return;
  try {
    const raw = JSON.stringify({ savedAt: now, data });
    if (raw.length <= MAX_CACHE_CHARS) storage.setItem(storageKey(scope), raw);
  } catch { /* Restricted/quota-limited storage leaves the in-memory query usable. */ }
}
/** Restored catalogs render immediately but always revalidate in the background. */
export function modelCatalogQueryOptions(scope: ModelCatalogScope, load: (signal: AbortSignal) => Promise<ModelsResponse>, storage = browserStorage()) {
  const restored = readModelCatalog(scope, storage);
  return {
    queryKey: modelCatalogKey(scope), staleTime: MODEL_CATALOG_STALE_MS, gcTime: MODEL_CATALOG_CACHE_MS,
    initialData: restored, initialDataUpdatedAt: restored ? 0 : undefined,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const data = await load(signal);
      signal.throwIfAborted();
      writeModelCatalog(scope, data, storage);
      return data;
    },
  };
}

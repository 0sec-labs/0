import { storage } from "./storage";
/** Remembers the operator's last model pick per backend so a new mission starts with it. */
export interface ModelChoice { providerId: string; model: string }
const key = (backendId: string) => `0-last-model:${backendId}`;

export function readLastModelChoice(backendId: string): ModelChoice | undefined {
  const value = storage.readJson<Partial<ModelChoice> | null>(key(backendId), null);
  return value && typeof value.providerId === "string" && typeof value.model === "string" && value.providerId && value.model ? { providerId: value.providerId, model: value.model } : undefined;
}

export function rememberModelChoice(backendId: string, choice: ModelChoice): void {
  storage.writeJson(key(backendId), { providerId: choice.providerId, model: choice.model }); // private mode: silently skipped
  recordRecentModel(backendId, choice);
}

/**
 * The remembered pick only stands in for the model while its provider can still serve it. Until a catalog has loaded
 * (`models` undefined) it is trusted so Home never flashes "Choose model"; afterwards it must be a listed, enabled row.
 */
export function usableModelChoice(choice: ModelChoice | undefined, models: readonly ChoiceCandidate[] | undefined): ModelChoice | undefined {
  if (!choice || !models) return choice;
  return models.some(model => model.provider === choice.providerId && model.id === choice.model && model.enabled !== false) ? choice : undefined;
}

interface ChoiceCandidate { id: string; provider: string; enabled?: boolean }
export const RECENT_MODEL_LIMIT = 3;
const recentKey = (backendId: string) => `0-recent-models:${backendId}`;

/** Last distinct models the operator picked on this backend, most recent first. */
export function readRecentModels(backendId: string): ModelChoice[] {
  const value = storage.readJson<unknown>(recentKey(backendId), []);
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: ModelChoice[] = [];
  for (const item of value as Partial<ModelChoice>[]) {
    if (!item || typeof item.providerId !== "string" || typeof item.model !== "string" || !item.providerId || !item.model) continue;
    const id = `${item.providerId}\u0000${item.model}`;
    if (seen.has(id)) continue;
    seen.add(id); out.push({ providerId: item.providerId, model: item.model });
  }
  return out.slice(0, RECENT_MODEL_LIMIT);
}

export function recordRecentModel(backendId: string, choice: ModelChoice): void {
  const next = [choice, ...readRecentModels(backendId).filter(item => item.providerId !== choice.providerId || item.model !== choice.model)];
  storage.writeJson(recentKey(backendId), next.slice(0, RECENT_MODEL_LIMIT).map(item => ({ providerId: item.providerId, model: item.model })));
}

/** Recent picks that still exist (enabled) in the catalog, resolved to catalog rows; stale ids are dropped. */
export function resolveRecentModels<T extends ChoiceCandidate>(recents: readonly ModelChoice[], models: readonly T[]): T[] {
  const rows = new Map(models.map(model => [`${model.provider}\u0000${model.id}`, model]));
  return recents.flatMap(choice => { const row = rows.get(`${choice.providerId}\u0000${choice.model}`); return row && row.enabled !== false ? [row] : []; }).slice(0, RECENT_MODEL_LIMIT);
}

/** Only plain missions inherit the remembered model; bound editors and relayed sessions keep their own. */
export function withRememberedModel<T extends object>(backendId: string, input: T): T {
  const bag = input as { runtime?: unknown; workflowId?: string; skillId?: string; modelSource?: unknown };
  if (bag.runtime !== undefined || bag.workflowId || bag.skillId || bag.modelSource) return input;
  const choice = readLastModelChoice(backendId);
  return choice ? { ...input, runtime: choice } : input;
}

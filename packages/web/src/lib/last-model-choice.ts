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

/**
 * The recommended orchestrator for each backend, published by the composer once the catalog loads. Kept in memory so a
 * changed recommendation is never frozen into storage; a remembered pick always wins over it.
 */
const recommendedDefaults = new Map<string, ModelChoice>();
export function setRecommendedDefault(backendId: string, choice: ModelChoice | undefined): void {
  if (choice) recommendedDefaults.set(backendId, choice); else recommendedDefaults.delete(backendId);
}

/**
 * The host's saved global default (PATCH /api/console/models/preference), published by the composer once the providers
 * load. It stands in when this browser has no remembered pick, so the choice survives a cleared or different browser.
 */
const savedPreferences = new Map<string, ModelChoice>();
export function setSavedPreference(backendId: string, choice: ModelChoice | undefined): void {
  if (choice) savedPreferences.set(backendId, choice); else savedPreferences.delete(backendId);
}

/** What Home resolved for each backend. `undefined` choice with a loaded catalog means nothing usable: the engine default applies. */
const resolvedStarts = new Map<string, { choice: ModelChoice | undefined }>();
export function setResolvedStartModel(backendId: string, resolved: { choice: ModelChoice | undefined } | undefined): void {
  if (resolved) resolvedStarts.set(backendId, resolved); else resolvedStarts.delete(backendId);
}

/** The model a plain mission starts on when none is bound yet: exactly what Home resolved, else (catalog not loaded) the unchecked chain. */
export function startingModelChoice(backendId: string): ModelChoice | undefined {
  const bad = unusableProviders.get(backendId);
  const usable = (choice: ModelChoice | undefined) => (choice && !bad?.has(choice.providerId) ? choice : undefined);
  const resolved = resolvedStarts.get(backendId);
  if (resolved) return usable(resolved.choice);
  return usable(readLastModelChoice(backendId)) ?? usable(savedPreferences.get(backendId)) ?? usable(recommendedDefaults.get(backendId));
}

/** Providers whose key was rejected or that cannot be reached, published with the provider list; never a start choice. */
const unusableProviders = new Map<string, ReadonlySet<string>>();
export function setUnusableProviders(backendId: string, ids: ReadonlySet<string>): void { unusableProviders.set(backendId, ids); }

/** Only plain missions inherit the remembered model; bound editors and relayed sessions keep their own. */
export function withRememberedModel<T extends object>(backendId: string, input: T): T {
  const bag = input as { runtime?: unknown; workflowId?: string; skillId?: string; modelSource?: unknown };
  if (bag.runtime !== undefined || bag.workflowId || bag.skillId || bag.modelSource) return input;
  const choice = startingModelChoice(backendId);
  return choice ? { ...input, runtime: choice } : input;
}

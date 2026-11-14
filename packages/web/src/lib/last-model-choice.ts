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
}

/** Only plain missions inherit the remembered model; bound editors and relayed sessions keep their own. */
export function withRememberedModel<T extends object>(backendId: string, input: T): T {
  const bag = input as { runtime?: unknown; workflowId?: string; skillId?: string; modelSource?: unknown };
  if (bag.runtime !== undefined || bag.workflowId || bag.skillId || bag.modelSource) return input;
  const choice = readLastModelChoice(backendId);
  return choice ? { ...input, runtime: choice } : input;
}

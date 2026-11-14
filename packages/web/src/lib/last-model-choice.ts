/** Remembers the operator's last model pick per backend so a new mission starts with it. */
export interface ModelChoice { providerId: string; model: string }
const key = (backendId: string) => `0-last-model:${backendId}`;
const storage = (): Pick<Storage, "getItem" | "setItem"> | undefined => { try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; } };

export function readLastModelChoice(backendId: string): ModelChoice | undefined {
  try {
    const value = JSON.parse(storage()?.getItem(key(backendId)) ?? "null") as Partial<ModelChoice> | null;
    return value && typeof value.providerId === "string" && typeof value.model === "string" && value.providerId && value.model ? { providerId: value.providerId, model: value.model } : undefined;
  } catch { return undefined; }
}

export function rememberModelChoice(backendId: string, choice: ModelChoice): void {
  try { storage()?.setItem(key(backendId), JSON.stringify({ providerId: choice.providerId, model: choice.model })); } catch { /* private mode */ }
}

/** Only plain missions inherit the remembered model; bound editors and relayed sessions keep their own. */
export function withRememberedModel<T extends object>(backendId: string, input: T): T {
  const bag = input as { runtime?: unknown; workflowId?: string; skillId?: string; modelSource?: unknown };
  if (bag.runtime !== undefined || bag.workflowId || bag.skillId || bag.modelSource) return input;
  const choice = readLastModelChoice(backendId);
  return choice ? { ...input, runtime: choice } : input;
}

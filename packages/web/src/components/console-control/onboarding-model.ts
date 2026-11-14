type ModelPreference = { providerId?: string | null; model?: string | null };
/** Keep an account's existing choice; only use its own catalog as a fallback. */
export function chooseOnboardingModel(providerId: string, runtime: ModelPreference | null | undefined, preference: ModelPreference | null | undefined, catalog: Array<{ id: string }> = []): string {
  if (runtime?.providerId === providerId && runtime.model) return runtime.model;
  if (preference?.providerId === providerId && preference.model) return preference.model;
  return catalog.find(item => Boolean(item.id.trim()))?.id ?? "";
}

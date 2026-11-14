/** Unsaved automation edits survive navigating away or reloading, per tab. */
export type AutomationDraft = { name: string; target: string; instructions: string };

const key = (id: string) => `0:automation-draft:${id}`;

export function readAutomationDraft(id: string): AutomationDraft | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key(id)) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const { name, target, instructions } = parsed as Record<string, unknown>;
    return typeof name === "string" && typeof target === "string" && typeof instructions === "string" ? { name, target, instructions } : null;
  } catch { return null; }
}

export function writeAutomationDraft(id: string, draft: AutomationDraft | null): void {
  try {
    if (draft) sessionStorage.setItem(key(id), JSON.stringify(draft));
    else sessionStorage.removeItem(key(id));
  } catch { /* storage unavailable: the draft just is not kept */ }
}

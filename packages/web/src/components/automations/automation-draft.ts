import type { SecurityWorkflow, SecurityWorkflowInput } from "@0/engine/shared";
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

export function workflowInput(definition: SecurityWorkflow): SecurityWorkflowInput {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = definition;
  return input;
}
export function workflowDraftHasConflict(base: Pick<SecurityWorkflow, "id" | "revision">, latest: Pick<SecurityWorkflow, "id" | "revision">): boolean {
  return base.id === latest.id && base.revision !== latest.revision;
}
export function advanceWorkflowDraftBase(base: SecurityWorkflow, submitted: SecurityWorkflowInput): SecurityWorkflow {
  if (submitted.id !== base.id || submitted.revision !== base.revision) throw new Error("Automation save does not match the draft revision.");
  return { ...structuredClone(submitted), id: base.id, revision: base.revision + 1, createdAt: base.createdAt, updatedAt: new Date().toISOString() };
}

import { queryKeys } from "@/queries";
import { useBreadcrumbLabel } from "@/lib/breadcrumbs";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SecurityWorkflow, SecurityWorkflowInput } from "@0/engine/shared";
import { parseSecurityWorkflowInput } from "@0/engine/shared/security-workflows";
import { useBackendApi } from "@/api";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { AutomationForm } from "@/components/automations/automation-form";
import { AUTOMATION_DEFINITIONS as DEFINITIONS, useAutomationDefinitions } from "@/components/automations/use-automations";
import { duplicateName } from "@/components/automations/automation-model";
import { useTeamAccess } from "@/components/team-access";
import { ErrorState, LoadingState } from "@/components/state-panel";
import { NotFound } from "@/ui/components/not-found";
import { errorText } from "@/lib/api-error";
import { workflowInput } from "@/components/automations/automation-draft";

/** One automation, edited in place: the form, duplicate and delete. Opens from the Sentinels page. */
export function AutomationEditor({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const { webFetchJson } = useBackendApi();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<SecurityWorkflow | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const { key: definitionKey, query: definitions, definitions: all } = useAutomationDefinitions(1000);
  const selected = all.find(item => item.id === workflowId);
  useBreadcrumbLabel(selected?.name);
  const performing = useRef(false);
  const perform = async (action: () => Promise<void>) => {
    if (busy || performing.current) throw new Error("Wait for the current update to finish.");
    performing.current = true; setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(errorText(cause, "Unable to update the automation.")); throw cause; } finally { performing.current = false; setBusy(false); }
  };
  const save = (input: SecurityWorkflowInput) => perform(async () => {
    const validated = parseSecurityWorkflowInput(input);
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(`${DEFINITIONS}/${encodeURIComponent(validated.id!)}`, { method: "PATCH", body: JSON.stringify(validated) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(definitionKey, current => ({ definitions: (current?.definitions ?? []).map(item => item.id === result.definition.id ? result.definition : item) }));
    await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() });
  });
  const duplicate = (workflow: SecurityWorkflow) => void perform(async () => {
    const input = { ...workflowInput(workflow), id: undefined, revision: undefined, name: duplicateName(workflow.name, all.map(item => item.name)) };
    await webFetchJson(DEFINITIONS, { method: "POST", body: JSON.stringify(parseSecurityWorkflowInput(input)) });
    await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() });
  }).catch(() => {});

  return <div className="outline-none" ref={page} tabIndex={-1}>
    {error && <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
    {definitions.isError && !definitions.data ? <ErrorState error={definitions.error} onRetry={() => void definitions.refetch()} /> : definitions.isLoading || (!selected && definitions.isFetching) ? <LoadingState label="Loading automation" variant="detail" /> : !selected ? <NotFound section="automations" /> :
      <AutomationForm key={selected.id} workflow={selected} readOnly={readOnly} busy={busy} menuButtonRef={deleteTrigger}
        onSave={save} onDuplicate={() => duplicate(selected)} onDelete={() => { setError(""); setDeleteCandidate(structuredClone(selected)); }} />}
    <ConfirmDialog open={deleteCandidate !== null} onOpenChange={open => { if (!open) setDeleteCandidate(null); }} pending={busy} destructive className="sm:max-w-sm"
      onCloseAutoFocus={event => { event.preventDefault(); if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus(); else page.current?.focus(); }}
      title={`Delete ${deleteCandidate?.name}?`}
      error={error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      confirmLabel="Delete automation" onConfirm={() => { if (!deleteCandidate) return; const reviewed = deleteCandidate; void perform(async () => { await webFetchJson(`${DEFINITIONS}/${reviewed.id}?revision=${reviewed.revision}`, { method: "DELETE" }); setDeleteCandidate(null); onClose(); await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() }); }).catch(() => {}); }} />
  </div>;
}

import { queryKeys } from "@/queries";
import { usePersistentState } from "@/lib/use-persistent-state";
import { STORAGE_KEYS } from "@/lib/storage";
import { useBreadcrumbLabel } from "@/lib/breadcrumbs";
import { v } from "@/lib/vocabulary";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecurityWorkflow, SecurityWorkflowInput, SecurityWorkflowNode } from "@0/engine/shared";
import { createSecurityWorkflowTemplate, securityWorkflowScopeKind } from "@0/engine/shared/security-workflow-templates";
import { parseSecurityWorkflowInput, isSecurityWorkflowOperation } from "@0/engine/shared/security-workflows";
import { useBackendApi } from "@/api";
import { PageContent } from "@/components/page-header";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { workflowOperationLabel } from "@/components/workflow-labels";
import { WorkflowLibrary } from "@/components/workflow-library";
import { WorkflowPhaseEditor } from "@/components/workflow-phase-editor";
import { AutomationForm } from "@/components/automations/automation-form";
import { automationRuntime, blankAutomationInput, duplicateName, sentinelOwnership } from "@/components/automations/automation-model";
import { addWorkflowPhase, linearWorkflowNodes, removeWorkflowPhase, workflowInput } from "@/components/workflow-editing";
import { useTeamAccess } from "@/components/team-access";
import { TeamCollaboration } from "@/console/team-collaboration";
import { useTeamOverview } from "@/console/team-overview";
import { ErrorState, LoadingState } from "@/components/state-panel";
import { toast } from "@/ui/components/toast";
import { NotFound } from "@/ui/components/not-found";
import { errorText } from "@/lib/api-error";
import { readAutomationDraft } from "@/components/automations/automation-draft";
import type { ProjectResponse } from "@/components/console-control/contracts";
import { Button } from "@/components/ui/button";
import { folderLabel } from "@/console/file-path-picker";

const DEFINITIONS = "/api/console/workflow-definitions";

/** One line a person can approve: what runs, where, and the caps. Step detail sits behind Details. */
function runSummary(workflow: SecurityWorkflow | null, steps: readonly SecurityWorkflowNode[], workspace: string): string {
  if (!workflow) return "";
  const minutes = Math.round(steps.reduce((sum, node) => sum + (node.plan?.timeCapMs ?? 0), 0) / 60000);
  const cost = steps.reduce((sum, node) => sum + (node.plan?.costCapUsd ?? 0), 0);
  const where = workflow.target === workspace || !workflow.target ? (workspace ? `Runs in ${folderLabel(workspace)}` : "Runs in the current folder") : workflow.target;
  return [where, `${steps.length} ${steps.length === 1 ? "step" : "steps"}`, minutes ? `up to ${minutes} min` : "", cost ? `up to $${cost}` : "", workflow.model ? workflow.model.model : ""].filter(Boolean).join(" · ");
}

export function WorkflowsPage() {
  const { client, teamClient, createConsoleSession, deleteConsoleSession, sendConsoleMessage, webFetchJson } = useBackendApi();
  const team = useTeamAccess();
  const teamEnabled = team.enabled && client.backendId === "local";
  const livePresence = useTeamOverview(teamClient, { enabled: teamEnabled });
  const readOnly = team.enabled && team.user?.role === "viewer";
  const [typingSignal, setTypingSignal] = useState("");
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get("workflow");
  const [nodeId, setNodeId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runCandidate, setRunCandidate] = useState<SecurityWorkflow | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<SecurityWorkflow | null>(null);
  const runTrigger = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const definitionKey = queryKeys.workflowDefinitions(client.backendId, team.user?.workspaceId, team.user?.userId);
  const definitions = useQuery({ queryKey: definitionKey, queryFn: ({ signal }) => webFetchJson<{ definitions: SecurityWorkflow[] }>(DEFINITIONS, { signal }), refetchInterval: selectedId ? 1000 : 30_000, retry: false });
  // The current folder is implicit: automations that review code run in it.
  const project = useQuery({ queryKey: queryKeys.consoleProject(), queryFn: ({ signal }) => webFetchJson<ProjectResponse>("/api/console/project", { signal }), staleTime: 60_000, retry: false });
  const workspace = project.data?.path ?? "";
  const selected = definitions.data?.definitions.find(item => item.id === selectedId);
  useBreadcrumbLabel(selected?.name);
  const selectedNode = selected?.nodes.find(node => node.id === nodeId);
  const isPristine = (item: SecurityWorkflow) => item.revision === 1 && item.name === "Untitled automation" && (!item.target || item.target === workspace) && !item.instructions && !item.ownerSentinelId;
  // A blank automation nobody touched is not worth keeping, however the person left it (Back, sidebar, reload).
  const swept = useRef(new Set<string>());
  const [sweepTick, setSweepTick] = useState(0);
  useEffect(() => {
    if (selectedId || readOnly || !definitions.data) return;
    let wait = Infinity;
    for (const item of definitions.data.definitions) {
      const pristine = isPristine(item);
      if (!pristine || swept.current.has(item.id) || readAutomationDraft(item.id)) continue;
      const remaining = 3000 - (Date.now() - Date.parse(item.updatedAt));
      if (remaining > 0) { wait = Math.min(wait, remaining); continue; }
      swept.current.add(item.id);
      void webFetchJson(`${DEFINITIONS}/${encodeURIComponent(item.id)}?revision=${item.revision}`, { method: "DELETE" }).then(() => cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() })).catch(() => {});
    }
    if (wait === Infinity) return;
    const timer = window.setTimeout(() => setSweepTick(tick => tick + 1), wait + 50);
    return () => window.clearTimeout(timer);
  }, [selectedId, readOnly, definitions.data, sweepTick]);
  const selectStep = (id: string) => { setNodeId(id); };
  // Leaving a Sentinel "Set up" URL replaces it, so history never holds a link that would create the automation again.
  const select = (id: string | null) => { const setup = search.has("template") || search.has("owner"); setSearch(previous => { const next = new URLSearchParams(previous); if (id) next.set("workflow", id); else next.delete("workflow"); for (const key of ["template", "owner", "runIn"]) next.delete(key); return next; }, setup ? { replace: true } : undefined); setNodeId(null); setError(""); };
  const performing = useRef(false);
  const perform = async (action: () => Promise<void>) => {
    if (busy || performing.current) throw new Error("Wait for the current update to finish.");
    performing.current = true; setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(errorText(cause, "Unable to update the workflow.")); throw cause; } finally { performing.current = false; setBusy(false); }
  };
  const save = (input: SecurityWorkflowInput) => perform(async () => {
    const validated = parseSecurityWorkflowInput(input);
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(`${DEFINITIONS}/${encodeURIComponent(validated.id!)}`, { method: "PATCH", body: JSON.stringify(validated) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(definitionKey, current => ({ definitions: (current?.definitions ?? []).map(item => item.id === result.definition.id ? result.definition : item) }));
    await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() });
  });
  const useTemplate = (id: string, ownership?: ReturnType<typeof sentinelOwnership>) => perform(async () => {
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(DEFINITIONS, { method: "POST", body: JSON.stringify({ ...createSecurityWorkflowTemplate(id, workspace && securityWorkflowScopeKind(id) === "workspace" ? { target: workspace } : {}), ...(ownership ?? {}) }) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(definitionKey, current => ({ definitions: [result.definition, ...(current?.definitions ?? [])] }));
    select(result.definition.id);
    await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() });
  });
  // A Sentinel's "Set up" link: create the owned automation from its suggested template and open its form.
  const ownedSetup = useRef(false);
  const requestedOwnership = sentinelOwnership(search);
  const requestedTemplate = search.get("template");
  useEffect(() => {
    if (!requestedOwnership || !requestedTemplate || readOnly || ownedSetup.current || definitions.isLoading) return;
    ownedSetup.current = true;
    void useTemplate(requestedTemplate, requestedOwnership).catch(() => setSearch(previous => { const next = new URLSearchParams(previous); for (const key of ["template", "owner", "runIn"]) next.delete(key); return next; }, { replace: true }));
  });
  const importDefinition = (input: SecurityWorkflowInput) => perform(async () => {
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(DEFINITIONS, { method: "POST", body: JSON.stringify(parseSecurityWorkflowInput(input)) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(definitionKey, current => ({ definitions: [result.definition, ...(current?.definitions ?? [])] }));
    select(result.definition.id);
    await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() });
  });
  const create = (input: SecurityWorkflowInput) => perform(async () => {
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(DEFINITIONS, { method: "POST", body: JSON.stringify(parseSecurityWorkflowInput(input)) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(definitionKey, current => ({ definitions: [result.definition, ...(current?.definitions ?? [])] }));
    select(result.definition.id);
    await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() });
  });
  const createBlank = () => create(blankAutomationInput({ target: workspace }));
  // Older automations that review code were saved without a target; they take the current folder the first time they open.
  const filled = useRef(new Set<string>());
  useEffect(() => {
    if (!selected || readOnly || busy || !workspace || selected.target.trim() || filled.current.has(selected.id) || securityWorkflowScopeKind(selected.template?.id) === "url") return;
    filled.current.add(selected.id);
    void save({ ...workflowInput(selected), target: workspace }).catch(() => {});
  });
  const duplicate = (workflow: SecurityWorkflow) => void create({ ...workflowInput(workflow), id: undefined, revision: undefined, name: duplicateName(workflow.name, definitions.data?.definitions.map(item => item.name)) }).catch(() => {});
  const enabledAudits = selected?.nodes.filter(node => isSecurityWorkflowOperation(node) && node.enabled) ?? [];
  const canRun = Boolean(selected?.target.trim() && enabledAudits.length);
  const reviewedAudits = runCandidate?.nodes.filter(node => isSecurityWorkflowOperation(node) && node.enabled) ?? [];
  const run = () => { if (!runCandidate) return; const reviewed = runCandidate; void perform(async () => {
    const session = await createConsoleSession({ title: reviewed.name, target: reviewed.target, ...(automationRuntime(reviewed.model) ? { runtime: automationRuntime(reviewed.model)! } : {}) });
    // A run the Computer rejects must not leave an empty Mission behind.
    try { await webFetchJson(`${DEFINITIONS}/${encodeURIComponent(reviewed.id)}/run`, { method: "POST", body: JSON.stringify({ sessionId: session.id, revision: reviewed.revision, approval: "launch-authorized-run" }) }); }
    catch (cause) { await deleteConsoleSession(session.id).catch(() => {}); await cache.invalidateQueries({ queryKey: queryKeys.consoleSessions() }); throw cause; }
    setRunCandidate(null);
    toast({ title: v("Run started"), description: reviewed.name, kind: "success", action: { label: v("Open {mission}"), href: `/chats/${encodeURIComponent(session.id)}` } });
    requestAnimationFrame(() => document.getElementById("workflow-runs")?.scrollIntoView({ block: "start", behavior: "smooth" }));
    await cache.invalidateQueries({ queryKey: queryKeys.workflowExecutions(client.backendId, reviewed.id) });
    await cache.invalidateQueries({ queryKey: queryKeys.consoleSessions() });
  }).catch(() => {}); };
  const linear = selected ? linearWorkflowNodes(selected) !== null : false;



  return <PageContent width="wide" className="outline-none" ref={page} tabIndex={-1} onChangeCapture={() => { if (teamEnabled && selected) setTypingSignal(String(Date.now())); }}>
    {error && <p role="alert" className="rounded-[var(--radius-menu,12px)] bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
    {definitions.isError && !definitions.data ? <ErrorState error={definitions.error} onRetry={() => void definitions.refetch()} /> : definitions.isLoading ? <LoadingState label="Loading automations…" variant="cards" /> : !selected && selectedId && !definitions.isFetching ? <NotFound section="automations" /> : !selected ? <WorkflowLibrary readOnly={readOnly} shared={teamEnabled} presenceById={Object.fromEntries((livePresence.isError ? [] : livePresence.data?.rooms ?? []).filter(room => room.kind === "workflow").map(room => [room.id, room.presence]))} definitions={definitions.data?.definitions ?? []} busy={busy} onSelect={select} onBlank={createBlank} onTemplate={useTemplate} onImport={importDefinition} onRun={(workflow, trigger) => { runTrigger.current = trigger; setError(""); setRunCandidate(structuredClone(workflow)); }} onDuplicate={duplicate} onDelete={(workflow, trigger) => { deleteTrigger.current = trigger; setError(""); setDeleteCandidate(structuredClone(workflow)); }} /> : <>
      <AutomationForm key={selected.id} workflow={selected} readOnly={readOnly} busy={busy} linear={linear} nodeId={nodeId}
        teamCollaboration={teamEnabled ? <TeamCollaboration room={{ kind: "workflow", id: selected.id }} client={teamClient} draft={typingSignal} /> : undefined}
        runButtonRef={runTrigger} menuButtonRef={deleteTrigger}
        onBack={() => { const pristine = isPristine(selected) && !readAutomationDraft(selected.id); select(null); if (pristine && !readOnly) void webFetchJson(`${DEFINITIONS}/${encodeURIComponent(selected.id)}?revision=${selected.revision}`, { method: "DELETE" }).then(() => cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() })).catch(() => {}); }} onSave={save} onRun={() => { setError(""); setRunCandidate(structuredClone(selected)); }} onDuplicate={() => duplicate(selected)} onDelete={() => { setError(""); setDeleteCandidate(structuredClone(selected)); }}
        onSelectStep={selectStep} onAddStep={() => void save(addWorkflowPhase(selected)).catch(() => {})}
        onRestore={revision => perform(async () => { await webFetchJson(`${DEFINITIONS}/${encodeURIComponent(selected.id)}/rollback`, { method: "POST", body: JSON.stringify({ revision, expectedRevision: selected.revision }) }); await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() }); })}
        onAction={perform} />
      <Dialog open={Boolean(selectedNode)} onOpenChange={open => { if (!open) setNodeId(null); }}><DialogContent className="sm:max-w-xl"><DialogTitle>{selectedNode?.label}</DialogTitle><DialogDescription>{v("Fine-tune this step, or describe a change in {a mission}.")}</DialogDescription>{selectedNode && <WorkflowPhaseEditor key={`${selected.id}:${selectedNode.id}`} definition={selected} phase={selectedNode} busy={busy || readOnly} onSave={save} canRemove={linear && selectedNode.type !== "trigger" && (!isSecurityWorkflowOperation(selectedNode) || selected.nodes.filter(isSecurityWorkflowOperation).length > 1)} onRemove={() => void save(removeWorkflowPhase(selected, selectedNode.id)).then(() => setNodeId(null)).catch(() => {})} />}</DialogContent></Dialog>
    </>}
    <ConfirmDialog open={runCandidate !== null} onOpenChange={open => { if (!open) { setRunCandidate(null); setShowDetails(false); } }} pending={busy} className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
      onCloseAutoFocus={event => { event.preventDefault(); runTrigger.current?.focus(); }}
      title={`Run ${runCandidate?.name}?`}
      confirmLabel={busy ? "Starting…" : "Run automation"} confirmDisabled={!reviewedAudits.length} onConfirm={run}>
      <div className="space-y-4 text-sm"><p>{runSummary(runCandidate, reviewedAudits, workspace)}</p><p className="text-xs text-muted-foreground">You confirm you are allowed to test this scope.</p>{error && <p role="alert" className="text-destructive">{error}</p>}<Button type="button" variant="ghost" size="sm" aria-expanded={showDetails} onClick={() => setShowDetails(open => !open)}>{showDetails ? "Hide details" : "Details"}</Button>{showDetails && <>{reviewedAudits.map(node => <div key={node.id} className="space-y-2"><p>{node.label}</p><p className="text-xs text-muted-foreground">{workflowOperationLabel(node, runCandidate!)}</p>{(node.input || node.inputs) && <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-menu,12px)] bg-muted/35 p-3 text-xs text-muted-foreground">{JSON.stringify({ ...(node.input ? { references: node.input } : {}), ...(node.inputs ? { inputs: node.inputs } : {}) }, null, 2)}</pre>}{node.type === "fix" && node.fix?.mode === "apply" && <p className="text-xs text-muted-foreground">Application requires separate permission and a reviewed candidate from the running host.</p>}{node.execution?.instructions && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{node.execution.instructions}</p>}{node.plan && <p className="text-xs text-muted-foreground">Up to {Math.round(node.plan.timeCapMs / 60000)} minutes and ${node.plan.costCapUsd} per step</p>}{node.execution?.allowedAgentTools !== undefined && <p className="text-xs text-muted-foreground">Agent tools: {node.execution.allowedAgentTools.join(", ") || "None"}. Built-in pipeline checks run separately.</p>}</div>)}</>}</div>
    </ConfirmDialog>
    <ConfirmDialog open={deleteCandidate !== null} onOpenChange={open => { if (!open) setDeleteCandidate(null); }} pending={busy} destructive className="sm:max-w-sm"
      onCloseAutoFocus={event => { event.preventDefault(); if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus(); else page.current?.focus(); }}
      title={`Delete ${deleteCandidate?.name}?`} description="Prior run records remain."
      error={error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      confirmLabel="Delete automation" onConfirm={() => { if (!deleteCandidate) return; const reviewed = deleteCandidate; void perform(async () => { await webFetchJson(`${DEFINITIONS}/${reviewed.id}?revision=${reviewed.revision}`, { method: "DELETE" }); setDeleteCandidate(null); select(null); await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() }); }).catch(() => {}); }} />
  </PageContent>;
}

import { queryKeys } from "@/queries";
import { v } from "@/lib/vocabulary";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecurityWorkflow, SecurityWorkflowInput } from "@0/engine/shared";
import { createSecurityWorkflowTemplate } from "@0/engine/dist/shared/security-workflow-templates.js";
import { parseSecurityWorkflowInput, isSecurityWorkflowOperation } from "@0/engine/dist/shared/security-workflows.js";
import { useBackendApi } from "@/api";
import { useBackendSelection } from "@/backend-context";
import { PageContent } from "@/components/page-header";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { workflowOperationLabel } from "@/components/workflow-labels";
import { WorkflowLibrary } from "@/components/workflow-library";
import { WorkflowPhaseEditor } from "@/components/workflow-phase-editor";
import { AutomationForm } from "@/components/automations/automation-form";
import { automationFromPrompt, blankAutomationInput, duplicateName, sentinelOwnership } from "@/components/automations/automation-model";
import { addWorkflowPhase, linearWorkflowNodes, removeWorkflowPhase, workflowInput } from "@/components/workflow-editing";
import { useTeamAccess } from "@/components/team-access";
import { TeamCollaboration } from "@/console/team-collaboration";
import { useTeamOverview } from "@/console/team-overview";
import { LoadingState } from "@/components/state-panel";
import { errorText } from "@/lib/api-error";

const DEFINITIONS = "/api/console/workflow-definitions";

export function WorkflowsPage() {
  const { client, teamClient, createConsoleSession, sendConsoleMessage, webFetchJson } = useBackendApi();
  const connection = useBackendSelection();
  const computerName = client.backendId === "local" ? "This computer" : connection?.backends.find(backend => backend.id === client.backendId)?.name ?? client.backendId;
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
  const [deleteCandidate, setDeleteCandidate] = useState<SecurityWorkflow | null>(null);
  const runTrigger = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const definitionKey = queryKeys.workflowDefinitions(client.backendId, team.user?.workspaceId, team.user?.userId);
  const definitions = useQuery({ queryKey: definitionKey, queryFn: ({ signal }) => webFetchJson<{ definitions: SecurityWorkflow[] }>(DEFINITIONS, { signal }), refetchInterval: selectedId ? 1000 : 30_000 });
  const selected = definitions.data?.definitions.find(item => item.id === selectedId);
  const selectedNode = selected?.nodes.find(node => node.id === nodeId);
  const selectStep = (id: string) => { setNodeId(id); };
  const select = (id: string | null) => { setSearch(previous => { const next = new URLSearchParams(previous); if (id) next.set("workflow", id); else next.delete("workflow"); for (const key of ["template", "owner", "runIn"]) next.delete(key); return next; }); setNodeId(null); setError(""); };
  const perform = async (action: () => Promise<void>) => {
    if (busy) throw new Error("Wait for the current update to finish.");
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(errorText(cause, "Unable to update the workflow.")); throw cause; } finally { setBusy(false); }
  };
  const save = (input: SecurityWorkflowInput) => perform(async () => {
    const validated = parseSecurityWorkflowInput(input);
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(`${DEFINITIONS}/${encodeURIComponent(validated.id!)}`, { method: "PATCH", body: JSON.stringify(validated) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(definitionKey, current => ({ definitions: (current?.definitions ?? []).map(item => item.id === result.definition.id ? result.definition : item) }));
    await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() });
  });
  const useTemplate = (id: string, ownership?: ReturnType<typeof sentinelOwnership>) => perform(async () => {
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(DEFINITIONS, { method: "POST", body: JSON.stringify({ ...createSecurityWorkflowTemplate(id), ...(ownership ?? {}) }) });
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
  const createBlank = () => create(blankAutomationInput());
  const createFromPrompt = (prompt: string) => create(blankAutomationInput(automationFromPrompt(prompt)));
  const duplicate = (workflow: SecurityWorkflow) => void create({ ...workflowInput(workflow), id: undefined, revision: undefined, name: duplicateName(workflow.name) }).catch(() => {});
  const discuss = (description: string, definition?: SecurityWorkflow) => void perform(async () => {
    const session = await createConsoleSession({ title: definition ? `Update ${definition.name}` : "Create a security automation" });
    const prompt = definition
      ? `Help me revise saved security automation ${definition.id}, revision ${definition.revision}, named ${definition.name}. Use the automation tools to read its current definition. Discuss the changes and save with console_save_workflow when ready. Do not execute it.\n\n${description}`
      : `Help me create a reusable security automation from this request. Ask for missing target or details. Use console_save_workflow to save a real definition with a manual trigger, typed review plans, per-step execution instructions and a result collection step. Automation descriptions are descriptive; step instructions guide assessments. Do not run it.\n\n${description}`;
    await sendConsoleMessage(session.id, { text: prompt });
    navigate(`/chats/${session.id}`);
  }).catch(() => {});
  const enabledAudits = selected?.nodes.filter(node => isSecurityWorkflowOperation(node) && node.enabled) ?? [];
  const canRun = Boolean(selected?.target.trim() && enabledAudits.length);
  const reviewedAudits = runCandidate?.nodes.filter(node => isSecurityWorkflowOperation(node) && node.enabled) ?? [];
  const run = () => { if (!runCandidate) return; const reviewed = runCandidate; void perform(async () => {
    const session = await createConsoleSession({ title: reviewed.name, target: reviewed.target });
    await webFetchJson(`${DEFINITIONS}/${encodeURIComponent(reviewed.id)}/run`, { method: "POST", body: JSON.stringify({ sessionId: session.id, revision: reviewed.revision, approval: "launch-authorized-run" }) });
    setRunCandidate(null);
    await cache.invalidateQueries({ queryKey: queryKeys.workflowExecutions(client.backendId, reviewed.id) });
  }).catch(() => {}); };
  const linear = selected ? linearWorkflowNodes(selected) !== null : false;



  return <PageContent width={selected ? "wide" : "readable"} className="outline-none" ref={page} tabIndex={-1} onChangeCapture={() => { if (teamEnabled && selected) setTypingSignal(String(Date.now())); }}>
    {error && <p role="alert" className="rounded-[var(--radius-menu,12px)] bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
    {definitions.isError && <p role="alert" className="text-sm text-destructive">{definitions.error.message}</p>}
    {definitions.isLoading ? <LoadingState label="Loading automations…" variant="cards" /> : !selected ? <WorkflowLibrary readOnly={readOnly} shared={teamEnabled} presenceById={Object.fromEntries((livePresence.isError ? [] : livePresence.data?.rooms ?? []).filter(room => room.kind === "workflow").map(room => [room.id, room.presence]))} definitions={definitions.data?.definitions ?? []} busy={busy} onSelect={select} onBlank={createBlank} onTemplate={useTemplate} onPrompt={createFromPrompt} onImport={importDefinition} onDescribe={discuss} onRun={(workflow, trigger) => { runTrigger.current = trigger; setError(""); setRunCandidate(structuredClone(workflow)); }} onDuplicate={duplicate} onDelete={(workflow, trigger) => { deleteTrigger.current = trigger; setError(""); setDeleteCandidate(structuredClone(workflow)); }} /> : <>
      <AutomationForm key={selected.id} workflow={selected} readOnly={readOnly} busy={busy} computerName={computerName} linear={linear} nodeId={nodeId}
        teamCollaboration={teamEnabled ? <TeamCollaboration room={{ kind: "workflow", id: selected.id }} client={teamClient} draft={typingSignal} /> : undefined}
        runButtonRef={runTrigger} menuButtonRef={deleteTrigger}
        onBack={() => { const pristine = selected.revision === 1 && selected.name === "Untitled automation" && !selected.target && !selected.instructions && !selected.ownerSentinelId; select(null); if (pristine && !readOnly) void webFetchJson(`${DEFINITIONS}/${encodeURIComponent(selected.id)}?revision=${selected.revision}`, { method: "DELETE" }).then(() => cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() })).catch(() => {}); }} onSave={save} onRun={() => { setError(""); setRunCandidate(structuredClone(selected)); }} onDuplicate={() => duplicate(selected)} onDelete={() => { setError(""); setDeleteCandidate(structuredClone(selected)); }}
        onSelectStep={selectStep} onAddStep={() => void save(addWorkflowPhase(selected)).catch(() => {})}
        onRestore={revision => perform(async () => { await webFetchJson(`${DEFINITIONS}/${encodeURIComponent(selected.id)}/rollback`, { method: "POST", body: JSON.stringify({ revision, expectedRevision: selected.revision }) }); await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() }); })}
        onAction={perform} />
      <Dialog open={Boolean(selectedNode)} onOpenChange={open => { if (!open) setNodeId(null); }}><DialogContent className="sm:max-w-xl"><DialogTitle>{selectedNode?.label}</DialogTitle><DialogDescription>{v("Fine-tune this step, or describe a change in {a mission}.")}</DialogDescription>{selectedNode && <WorkflowPhaseEditor key={`${selected.id}:${selectedNode.id}`} definition={selected} phase={selectedNode} busy={busy || readOnly} onSave={save} canRemove={linear && selectedNode.type !== "trigger" && (!isSecurityWorkflowOperation(selectedNode) || selected.nodes.filter(isSecurityWorkflowOperation).length > 1)} onRemove={() => void save(removeWorkflowPhase(selected, selectedNode.id)).then(() => setNodeId(null)).catch(() => {})} />}</DialogContent></Dialog>
    </>}
    <ConfirmDialog open={runCandidate !== null} onOpenChange={open => { if (!open) setRunCandidate(null); }} pending={busy} className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
      onCloseAutoFocus={event => { event.preventDefault(); runTrigger.current?.focus(); }}
      title={`Run ${runCandidate?.name}?`} description={v("Run these enabled steps in a new {mission}.")}
      confirmLabel={busy ? "Starting…" : "Run automation"} confirmDisabled={!reviewedAudits.length} onConfirm={run}>
      <div className="space-y-4 text-sm"><p><span className="text-muted-foreground">Computer: </span>{computerName}</p><p className="break-all"><span className="text-muted-foreground">Target: </span>{runCandidate?.target}</p><p className="text-xs text-muted-foreground">Reviewed revision {runCandidate?.revision}</p>{reviewedAudits.map(node => <div key={node.id} className="space-y-2"><p>{node.label}</p><p className="text-xs text-muted-foreground">{workflowOperationLabel(node, runCandidate!)}</p>{(node.input || node.inputs) && <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-menu,12px)] bg-muted/35 p-3 text-xs text-muted-foreground">{JSON.stringify({ ...(node.input ? { references: node.input } : {}), ...(node.inputs ? { inputs: node.inputs } : {}) }, null, 2)}</pre>}{node.type === "fix" && node.fix?.mode === "apply" && <p className="text-xs text-muted-foreground">Application requires separate permission and a reviewed candidate from the running host.</p>}{node.execution?.instructions && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{node.execution.instructions}</p>}{node.plan && <p className="text-xs text-muted-foreground">{node.type === "audit" && <>{node.plan.goal.replaceAll("-", " ")} · {node.plan.runCount} {node.plan.executionMode} attempts · {node.plan.depth} · </>} {Math.round(node.plan.timeCapMs / 60000)} minutes · ${node.plan.costCapUsd} per step</p>}{node.execution?.allowedAgentTools !== undefined && <p className="text-xs text-muted-foreground">Agent tools: {node.execution.allowedAgentTools.join(", ") || "None"}. Built-in pipeline checks run separately.</p>}</div>)}{error && <p role="alert" className="text-destructive">{error}</p>}</div>
    </ConfirmDialog>
    <ConfirmDialog open={deleteCandidate !== null} onOpenChange={open => { if (!open) setDeleteCandidate(null); }} pending={busy} destructive className="sm:max-w-sm"
      onCloseAutoFocus={event => { event.preventDefault(); if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus(); else page.current?.focus(); }}
      title={`Delete ${deleteCandidate?.name}?`} description="The saved automation will be removed. Prior run records remain available."
      error={error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      confirmLabel="Delete automation" onConfirm={() => { if (!deleteCandidate) return; const reviewed = deleteCandidate; void perform(async () => { await webFetchJson(`${DEFINITIONS}/${reviewed.id}?revision=${reviewed.revision}`, { method: "DELETE" }); setDeleteCandidate(null); select(null); await cache.invalidateQueries({ queryKey: queryKeys.workflowDefinitions() }); }).catch(() => {}); }} />
  </PageContent>;
}

import { Tooltip } from "@/components/ui/tooltip";
import { Disclosure } from "@/components/ui/disclosure";
import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, MoreHorizontal, Play, Plus, Trash2 } from "lucide-react";
import type { SecurityWorkflow, SecurityWorkflowInput } from "@0/shared";
import { createSecurityWorkflowTemplate } from "@0/shared/dist/security-workflow-templates.js";
import { parseSecurityWorkflowInput, isSecurityWorkflowOperation } from "@0/shared/dist/security-workflows.js";
import { useBackendApi } from "@/api";
import { useBackendSelection } from "@/backend-context";
import { Button } from "@/components/ui/button";
import { PageHeader, PageContent } from "@/components/page-header";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WorkflowChat } from "@/components/workflow-chat";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { workflowOperationLabel } from "@/components/workflow-labels";
import { WorkflowGraph } from "@/components/workflow-graph";
import { WorkflowLibrary } from "@/components/workflow-library";
import { WorkflowPhaseEditor, WorkflowSettingsEditor } from "@/components/workflow-phase-editor";
import { WorkflowDefinitionEditor } from "@/components/workflow-definition-editor";
import { LearningPanel, WorkflowVersions } from "@/components/learning-panel";
import { WorkflowRuns } from "@/components/workflow-runs";
import { WorkflowTriggers } from "@/components/workflow-triggers";
import { addWorkflowPhase, linearWorkflowNodes, removeWorkflowPhase } from "@/components/workflow-editing";
import { useTeamAccess } from "@/components/team-access";
import { TeamCollaboration } from "@/console/team-collaboration";
import { useTeamOverview } from "@/console/team-overview";
import { LoadingState } from "@/components/state-panel";

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

  const [activeSection, setActiveSection] = useState("steps");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runCandidate, setRunCandidate] = useState<SecurityWorkflow | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<SecurityWorkflow | null>(null);
  const runTrigger = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const definitionKey = ["workflow-definitions", client.backendId, team.user?.workspaceId, team.user?.userId] as const;
  const definitions = useQuery({ queryKey: definitionKey, queryFn: ({ signal }) => webFetchJson<{ definitions: SecurityWorkflow[] }>(DEFINITIONS, { signal }), refetchInterval: selectedId ? 1000 : 5000 });
  const selected = definitions.data?.definitions.find(item => item.id === selectedId);
  const selectedNode = selected?.nodes.find(node => node.id === nodeId);
  const selectStep = (id: string) => { setNodeId(id); };
  const select = (id: string | null) => { setSearch(previous => { const next = new URLSearchParams(previous); if (id) next.set("workflow", id); else next.delete("workflow"); return next; }); setNodeId(null); setActiveSection("steps"); setError(""); };
  const perform = async (action: () => Promise<void>) => {
    if (busy) throw new Error("Wait for the current update to finish.");
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update the workflow."); throw cause; } finally { setBusy(false); }
  };
  const save = (input: SecurityWorkflowInput) => perform(async () => {
    const validated = parseSecurityWorkflowInput(input);
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(`${DEFINITIONS}/${encodeURIComponent(validated.id!)}`, { method: "PATCH", body: JSON.stringify(validated) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(definitionKey, current => ({ definitions: (current?.definitions ?? []).map(item => item.id === result.definition.id ? result.definition : item) }));
    await cache.invalidateQueries({ queryKey: ["workflow-definitions"] });
  });
  const useTemplate = (id: string) => perform(async () => {
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(DEFINITIONS, { method: "POST", body: JSON.stringify(createSecurityWorkflowTemplate(id)) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(definitionKey, current => ({ definitions: [result.definition, ...(current?.definitions ?? [])] }));
    select(result.definition.id);
    await cache.invalidateQueries({ queryKey: ["workflow-definitions"] });
  });
  const importDefinition = (input: SecurityWorkflowInput) => perform(async () => {
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(DEFINITIONS, { method: "POST", body: JSON.stringify(parseSecurityWorkflowInput(input)) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(definitionKey, current => ({ definitions: [result.definition, ...(current?.definitions ?? [])] }));
    select(result.definition.id);
    await cache.invalidateQueries({ queryKey: ["workflow-definitions"] });
  });
  const discuss = (description: string, definition?: SecurityWorkflow) => void perform(async () => {
    const session = await createConsoleSession({ title: definition ? `Update ${definition.name}` : "Create a security workflow" });
    const prompt = definition
      ? `Help me revise saved security workflow ${definition.id}, revision ${definition.revision}, named ${definition.name}. Use the workflow tools to read its current definition. Discuss the changes and save with console_save_workflow when ready. Do not execute it.\n\n${description}`
      : `Help me create a reusable security workflow from this request. Ask for missing target or details. Use console_save_workflow to save a real definition with a manual trigger, typed review plans, per-step execution instructions and a result collection step. Workflow descriptions are descriptive; step instructions guide assessments. Do not run it.\n\n${description}`;
    await sendConsoleMessage(session.id, { text: prompt });
    navigate(`/console/${session.id}`);
  }).catch(() => {});
  const enabledAudits = selected?.nodes.filter(node => isSecurityWorkflowOperation(node) && node.enabled) ?? [];
  const canRun = Boolean(selected?.target.trim() && enabledAudits.length);
  const reviewedAudits = runCandidate?.nodes.filter(node => isSecurityWorkflowOperation(node) && node.enabled) ?? [];
  const run = () => { if (!runCandidate) return; const reviewed = runCandidate; void perform(async () => {
    const session = await createConsoleSession({ title: reviewed.name, target: reviewed.target });
    await webFetchJson(`${DEFINITIONS}/${encodeURIComponent(reviewed.id)}/run`, { method: "POST", body: JSON.stringify({ sessionId: session.id, revision: reviewed.revision, approval: "launch-authorized-run" }) });
    setRunCandidate(null); setActiveSection("runs");
    await cache.invalidateQueries({ queryKey: ["workflow-executions", reviewed.id] });
  }).catch(() => {}); };
  const linear = selected ? linearWorkflowNodes(selected) !== null : false;



  return <PageContent width="wide" className="outline-none" ref={page} tabIndex={-1} onChangeCapture={() => { if (teamEnabled && selected) setTypingSignal(String(Date.now())); }}>
    {error && <p role="alert" className="rounded-[var(--radius-menu,12px)] bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
    {definitions.isError && <p role="alert" className="text-sm text-destructive">{definitions.error.message}</p>}
    {definitions.isLoading ? <LoadingState label="Loading automations…" variant="cards" /> : !selected ? <WorkflowLibrary readOnly={readOnly} shared={teamEnabled} presenceById={Object.fromEntries((livePresence.isError ? [] : livePresence.data?.rooms ?? []).filter(room => room.kind === "workflow").map(room => [room.id, room.presence]))} definitions={definitions.data?.definitions ?? []} busy={busy} onSelect={select} onTemplate={useTemplate} onImport={importDefinition} onDescribe={discuss} onDelete={(workflow, trigger) => { deleteTrigger.current = trigger; setError(""); setDeleteCandidate(structuredClone(workflow)); }} /> : <>
      <Button variant="ghost" size="sm" onClick={() => select(null)}><ArrowLeft aria-hidden="true" />Back to automations</Button>
      <PageHeader title={selected.name} summary={selected.target || "Add a target in chat before running."} actions={<>{teamEnabled && <TeamCollaboration room={{ kind: "workflow", id: selected.id }} client={teamClient} draft={typingSignal} />}<span className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground"><Check className="size-3.5" />Saved</span><Button ref={runTrigger} size="default" disabled={busy || readOnly || !canRun} onClick={() => { setError(""); setRunCandidate(structuredClone(selected)); }}><Play aria-hidden="true" />Run</Button><Tooltip content={readOnly ? "This workspace is read-only" : busy ? "Wait for the current operation" : "Delete workflow"}><span className="inline-flex" tabIndex={busy || readOnly ? 0 : undefined}><Button ref={deleteTrigger} variant="ghost" size="icon" aria-label="Delete workflow" disabled={busy || readOnly} onClick={() => { setError(""); setDeleteCandidate(structuredClone(selected)); }}><Trash2 aria-hidden="true" /></Button></span></Tooltip></>} />
      <div className="grid min-h-[620px] gap-3 lg:h-[calc(100dvh-240px)] lg:grid-cols-[minmax(340px,0.85fr)_minmax(0,1.15fr)]">
        <section className="order-1 flex min-h-[500px] min-w-0 flex-col overflow-hidden rounded-[var(--radius-panel)] bg-background lg:order-1 lg:min-h-0" aria-label="Workflow editor">
          <div className="flex h-12 shrink-0 items-center border-b border-border/40 px-5 text-sm font-medium">Chat<span className="ml-auto text-xs font-normal text-muted-foreground">Editing this workflow</span></div>
          <WorkflowChat key={`${client.backendId}:${selected.id}`} definition={selected} readOnly={readOnly} />
        </section>
        <div className="order-2 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius-panel)] bg-muted/20">
          <nav aria-label="Workflow sections" className="flex h-12 shrink-0 items-center gap-1 border-b border-border/40 px-3">
            {[{ id: "steps", label: "Preview" }, { id: "triggers", label: "Schedules" }, { id: "runs", label: "Runs" }].map(section => <Button key={section.id} size="sm" variant="ghost" aria-current={activeSection === section.id ? "page" : undefined} onClick={() => setActiveSection(section.id)} className={activeSection === section.id ? "bg-muted text-foreground" : "text-muted-foreground"}>{section.label}</Button>)}
            <div className="ml-auto"><DropdownMenu><DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="More workflow settings" />}><MoreHorizontal className="size-4" /></DropdownMenu.Trigger><DropdownMenu.Content align="end" className="ui-menu-surface">{[{ id: "details", label: "Settings" }, { id: "learning", label: "Memory" }, { id: "versions", label: "Version history" }, { id: "definition", label: "Edit definition" }].map(section => <DropdownMenu.Item key={section.id} onClick={() => setActiveSection(section.id)}>{section.label}</DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu></div>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">
          <section hidden={activeSection !== "steps"} id="workflow-steps" className="space-y-3"><div className="flex items-center justify-between px-1"><span className="text-xs text-muted-foreground">{selected.nodes.length} steps · Revision {selected.revision}</span><Button variant="ghost" size="sm" disabled={busy || readOnly || !linear || selected.nodes.length >= 16} onClick={() => void save(addWorkflowPhase(selected)).catch(() => {})}><Plus aria-hidden="true" />Add step</Button></div><WorkflowGraph definition={selected} selectedId={nodeId} onSelect={selectStep} /></section>
          <section hidden={activeSection !== "details"} id="workflow-details" data-workflow-section="details" className="space-y-4"><h3 className="text-sm font-medium">Settings</h3><WorkflowSettingsEditor key={selected.id} definition={selected} busy={busy || readOnly} onSave={save} /></section>
          <section hidden={activeSection !== "triggers"} id="workflow-triggers" data-workflow-section="triggers" className="scroll-mt-20 space-y-4"><WorkflowTriggers workflow={selected} disabled={busy || readOnly} /></section>
          <section hidden={activeSection !== "runs"} id="workflow-runs" data-workflow-section="runs" className="scroll-mt-20 space-y-4"><h3 className="text-sm font-medium">Runs</h3><WorkflowRuns workflowId={selected.id} busy={busy || readOnly} onAction={perform} /></section>
          <section hidden={activeSection !== "learning"} id="workflow-learning" data-workflow-section="learning" className="scroll-mt-20 space-y-4"><h3 className="text-sm font-medium">Memory</h3><LearningPanel workflowId={selected.id} /></section>
          <section hidden={activeSection !== "versions"} id="workflow-versions" data-workflow-section="versions" className="scroll-mt-20 space-y-4"><h3 className="text-sm font-medium">Versions</h3><WorkflowVersions disabled={busy || readOnly} workflowId={selected.id} revision={selected.revision} onRestore={revision => perform(async () => { await webFetchJson(`${DEFINITIONS}/${encodeURIComponent(selected.id)}/rollback`, { method: "POST", body: JSON.stringify({ revision, expectedRevision: selected.revision }) }); await cache.invalidateQueries({ queryKey: ["workflow-definitions"] }); })} /></section>
          <section hidden={activeSection !== "definition"} id="workflow-definition" data-workflow-section="definition" className="scroll-mt-20"><Disclosure className="rounded-[var(--radius-panel,16px)] bg-muted/20 p-4" summary={<> Definition · JSON </>} triggerClassName="cursor-pointer text-sm font-medium"><div className="mt-4"><WorkflowDefinitionEditor key={selected.id} definition={selected} busy={busy || readOnly} onSave={save} /></div></Disclosure></section>
          </div>
        </div>
      </div>
      <Dialog open={Boolean(selectedNode)} onOpenChange={open => { if (!open) setNodeId(null); }}><DialogContent className="sm:max-w-xl"><DialogTitle>{selectedNode?.label}</DialogTitle><DialogDescription>Fine-tune this step, or describe a change in chat.</DialogDescription>{selectedNode && <WorkflowPhaseEditor key={`${selected.id}:${selectedNode.id}`} definition={selected} phase={selectedNode} busy={busy || readOnly} onSave={save} canRemove={linear && selectedNode.type !== "trigger" && (!isSecurityWorkflowOperation(selectedNode) || selected.nodes.filter(isSecurityWorkflowOperation).length > 1)} onRemove={() => void save(removeWorkflowPhase(selected, selectedNode.id)).then(() => setNodeId(null)).catch(() => {})} />}</DialogContent></Dialog>
    </>}
    <Dialog open={runCandidate !== null} onOpenChange={open => { if (!open && !busy) setRunCandidate(null); }}><DialogContent showCloseButton={!busy} onCloseAutoFocus={event => { event.preventDefault(); runTrigger.current?.focus(); }} className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>Run {runCandidate?.name}?</DialogTitle><DialogDescription>Run these enabled steps in a new conversation.</DialogDescription></DialogHeader><div className="space-y-4 text-sm"><p><span className="text-muted-foreground">Computer: </span>{computerName}</p><p className="break-all"><span className="text-muted-foreground">Target: </span>{runCandidate?.target}</p><p className="text-xs text-muted-foreground">Reviewed revision {runCandidate?.revision}</p>{reviewedAudits.map(node => <div key={node.id} className="space-y-2"><p>{node.label}</p><p className="text-xs text-muted-foreground">{workflowOperationLabel(node, runCandidate!)}</p>{(node.input || node.inputs) && <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-menu,12px)] bg-muted/35 p-3 text-xs text-muted-foreground">{JSON.stringify({ ...(node.input ? { references: node.input } : {}), ...(node.inputs ? { inputs: node.inputs } : {}) }, null, 2)}</pre>}{node.type === "fix" && node.fix?.mode === "apply" && <p className="text-xs text-muted-foreground">Application requires separate permission and a reviewed candidate from the running host.</p>}{node.execution?.instructions && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{node.execution.instructions}</p>}{node.plan && <p className="text-xs text-muted-foreground">{node.type === "audit" && <>{node.plan.goal.replaceAll("-", " ")} · {node.plan.runCount} {node.plan.executionMode} attempts · {node.plan.depth} · </>} {Math.round(node.plan.timeCapMs / 60000)} minutes · ${node.plan.costCapUsd} per step</p>}{node.execution?.allowedAgentTools !== undefined && <p className="text-xs text-muted-foreground">Agent tools: {node.execution.allowedAgentTools.join(", ") || "None"}. Built-in pipeline checks run separately.</p>}</div>)}{error && <p role="alert" className="text-destructive">{error}</p>}</div><DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setRunCandidate(null)}>Cancel</Button><Button disabled={busy || !reviewedAudits.length} onClick={run}>{busy ? "Starting…" : "Run workflow"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={deleteCandidate !== null} onOpenChange={open => { if (!open && !busy) setDeleteCandidate(null); }}><DialogContent showCloseButton={!busy} onCloseAutoFocus={event => { event.preventDefault(); if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus(); else page.current?.focus(); }} className="sm:max-w-sm"><DialogHeader><DialogTitle>Delete {deleteCandidate?.name}?</DialogTitle><DialogDescription>The saved workflow will be removed. Prior run records remain available.</DialogDescription></DialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setDeleteCandidate(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => { if (!deleteCandidate) return; const reviewed = deleteCandidate; void perform(async () => { await webFetchJson(`${DEFINITIONS}/${reviewed.id}?revision=${reviewed.revision}`, { method: "DELETE" }); setDeleteCandidate(null); select(null); await cache.invalidateQueries({ queryKey: ["workflow-definitions"] }); }).catch(() => {}); }}>Delete workflow</Button></DialogFooter></DialogContent></Dialog>
  </PageContent>;
}

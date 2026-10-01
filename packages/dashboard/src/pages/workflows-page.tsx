import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, Play, Plus, Trash2 } from "lucide-react";
import type { SecurityWorkflow, SecurityWorkflowInput } from "@0/shared";
import { createSecurityWorkflowTemplate } from "@0/shared/dist/security-workflow-templates.js";
import { parseSecurityWorkflowInput } from "@0/shared/dist/security-workflows.js";
import { createConsoleSession, sendConsoleMessage, webFetchJson } from "@/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WorkflowGraph } from "@/components/workflow-graph";
import { WorkflowAutomationControl } from "@/components/workflow-automation-control";
import { WorkflowLibrary } from "@/components/workflow-library";
import { WorkflowPhaseEditor, WorkflowSettingsEditor } from "@/components/workflow-phase-editor";
import { WorkflowDefinitionEditor } from "@/components/workflow-definition-editor";
import { WorkflowRuns } from "@/components/workflow-runs";
import { WorkflowTriggers } from "@/components/workflow-triggers";
import { addWorkflowPhase, linearWorkflowNodes, removeWorkflowPhase } from "@/components/workflow-editing";
import { ActivityIndicator } from "@/console/loading-state";

const DEFINITIONS = "/api/console/workflow-definitions";

export function WorkflowsPage() {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get("workflow");
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [tab, setTab] = useState("graph");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runCandidate, setRunCandidate] = useState<SecurityWorkflow | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<SecurityWorkflow | null>(null);
  const runTrigger = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const definitions = useQuery({ queryKey: ["workflow-definitions"], queryFn: ({ signal }) => webFetchJson<{ definitions: SecurityWorkflow[] }>(DEFINITIONS, { signal }), refetchInterval: 5000 });
  const selected = definitions.data?.definitions.find(item => item.id === selectedId);
  const selectedNode = selected?.nodes.find(node => node.id === nodeId);
  const select = (id: string | null) => { setSearch(previous => { const next = new URLSearchParams(previous); if (id) next.set("workflow", id); else next.delete("workflow"); return next; }); setNodeId(null); setTab("graph"); setError(""); };
  const perform = async (action: () => Promise<void>) => {
    if (busy) throw new Error("Wait for the current update to finish.");
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update the workflow."); throw cause; } finally { setBusy(false); }
  };
  const save = (input: SecurityWorkflowInput) => perform(async () => {
    const validated = parseSecurityWorkflowInput(input);
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(`${DEFINITIONS}/${encodeURIComponent(validated.id!)}`, { method: "PATCH", body: JSON.stringify(validated) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(["workflow-definitions"], current => ({ definitions: (current?.definitions ?? []).map(item => item.id === result.definition.id ? result.definition : item) }));
    await cache.invalidateQueries({ queryKey: ["workflow-definitions"] });
  });
  const useTemplate = (id: string) => perform(async () => {
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(DEFINITIONS, { method: "POST", body: JSON.stringify(createSecurityWorkflowTemplate(id)) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(["workflow-definitions"], current => ({ definitions: [result.definition, ...(current?.definitions ?? [])] }));
    select(result.definition.id);
    await cache.invalidateQueries({ queryKey: ["workflow-definitions"] });
  });
  const importDefinition = (input: SecurityWorkflowInput) => perform(async () => {
    const result = await webFetchJson<{ definition: SecurityWorkflow }>(DEFINITIONS, { method: "POST", body: JSON.stringify(parseSecurityWorkflowInput(input)) });
    cache.setQueryData<{ definitions: SecurityWorkflow[] }>(["workflow-definitions"], current => ({ definitions: [result.definition, ...(current?.definitions ?? [])] }));
    select(result.definition.id);
    await cache.invalidateQueries({ queryKey: ["workflow-definitions"] });
  });
  const discuss = (description: string, definition?: SecurityWorkflow) => void perform(async () => {
    const session = await createConsoleSession({ title: definition ? `Update ${definition.name}` : "Create a security workflow" });
    const prompt = definition
      ? `Help me revise saved security workflow ${definition.id}, revision ${definition.revision}, named ${definition.name}. Use the workflow tools to read its current definition. Discuss the changes and save with console_save_workflow when ready. Do not execute it.\n\n${description}`
      : `Help me create a reusable security workflow from this request. Ask for missing target or details. Use console_save_workflow to save a real definition with a manual trigger, typed review plans, per-phase execution instructions and a report. Workflow notes are descriptive; phase instructions guide actual reviews. Do not run it.\n\n${description}`;
    await sendConsoleMessage(session.id, { text: prompt });
    navigate(`/console/${session.id}`);
  }).catch(() => {});
  const enabledAudits = selected?.nodes.filter(node => node.type === "audit" && node.enabled) ?? [];
  const canRun = Boolean(selected?.target.trim() && enabledAudits.length);
  const reviewedAudits = runCandidate?.nodes.filter(node => node.type === "audit" && node.enabled) ?? [];
  const run = () => { if (!runCandidate) return; const reviewed = runCandidate; void perform(async () => {
    const session = await createConsoleSession({ title: reviewed.name, target: reviewed.target });
    await webFetchJson(`${DEFINITIONS}/${encodeURIComponent(reviewed.id)}/run`, { method: "POST", body: JSON.stringify({ sessionId: session.id, revision: reviewed.revision, approval: "launch-authorized-run" }) });
    setRunCandidate(null); setTab("runs");
    await cache.invalidateQueries({ queryKey: ["workflow-executions", reviewed.id] });
  }).catch(() => {}); };
  const linear = selected ? linearWorkflowNodes(selected) !== null : false;

  return <div ref={page} tabIndex={-1} className="min-w-0 w-full space-y-6 outline-none">
    {error && <p role="alert" className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
    {definitions.isError && <p role="alert" className="text-sm text-destructive">{definitions.error.message}</p>}
    {definitions.isLoading ? <div className="py-16"><ActivityIndicator label="Loading workflows…" /></div> : !selected ? <WorkflowLibrary definitions={definitions.data?.definitions ?? []} busy={busy} onSelect={select} onTemplate={useTemplate} onImport={importDefinition} onDescribe={discuss} /> : <>
      <Button variant="ghost" size="sm" onClick={() => select(null)}><ArrowLeft aria-hidden="true" />Back to workflows</Button>
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-2xl font-medium">{selected.name}</h2><p className="mt-2 break-all text-sm text-muted-foreground">{selected.target || "Choose a target below before running."}</p></div><div className="flex gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => discuss("I want to update this workflow.", selected)}><MessageSquare aria-hidden="true" />Edit in chat</Button><Button ref={runTrigger} size="sm" disabled={busy || !canRun} onClick={() => { setError(""); setRunCandidate(structuredClone(selected)); }}><Play aria-hidden="true" />Run</Button><Button ref={deleteTrigger} variant="ghost" size="icon-sm" aria-label="Delete workflow" disabled={busy} onClick={() => { setError(""); setDeleteCandidate(structuredClone(selected)); }}><Trash2 aria-hidden="true" /></Button></div></div>
      <div className="max-w-md rounded-2xl bg-muted/35 p-4"><WorkflowAutomationControl workflow={selected} disabled={busy} onConfigureTarget={() => setTab("graph")} /></div>
      <Tabs value={tab} onValueChange={setTab} className="gap-6"><TabsList aria-label="Workflow editor"><TabsTrigger value="graph">Graph</TabsTrigger><TabsTrigger value="definition">Definition</TabsTrigger><TabsTrigger value="triggers">Triggers</TabsTrigger><TabsTrigger value="runs">Runs</TabsTrigger></TabsList>
        <TabsContent value="graph" className="space-y-5"><WorkflowSettingsEditor key={`${selected.id}:${selected.revision}`} definition={selected} busy={busy} onSave={save} /><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-medium">Phases</h3><Button variant="ghost" size="sm" disabled={busy || !linear || selected.nodes.length >= 16} onClick={() => void save(addWorkflowPhase(selected)).catch(() => {})}><Plus aria-hidden="true" />Add phase</Button></div>{!linear && <p className="text-xs text-muted-foreground">This graph has branches. Add or remove phases in Definition to keep its connections intact.</p>}<WorkflowGraph definition={selected} selectedId={nodeId} onSelect={setNodeId} />{selectedNode ? <WorkflowPhaseEditor key={`${selected.id}:${selected.revision}:${selectedNode.id}`} definition={selected} phase={selectedNode} busy={busy} onSave={save} canRemove={linear && selectedNode.type !== "trigger" && (selectedNode.type !== "audit" || selected.nodes.filter(node => node.type === "audit").length > 1)} onRemove={() => void save(removeWorkflowPhase(selected, selectedNode.id)).then(() => setNodeId(null)).catch(() => {})} /> : <p className="text-center text-xs text-muted-foreground">Select a phase to edit its instructions, tools and review settings.</p>}</TabsContent>
        <TabsContent value="definition"><WorkflowDefinitionEditor key={`${selected.id}:${selected.revision}`} definition={selected} busy={busy} onSave={save} /></TabsContent>
        <TabsContent value="triggers"><WorkflowTriggers workflow={selected} disabled={busy} /></TabsContent>
        <TabsContent value="runs"><WorkflowRuns workflowId={selected.id} busy={busy} onAction={perform} /></TabsContent>
      </Tabs>
    </>}
    <Dialog open={runCandidate !== null} onOpenChange={open => { if (!open && !busy) setRunCandidate(null); }}><DialogContent showCloseButton={!busy} onCloseAutoFocus={event => { event.preventDefault(); runTrigger.current?.focus(); }} className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>Run {runCandidate?.name}?</DialogTitle><DialogDescription>Run these enabled phases in a new conversation.</DialogDescription></DialogHeader><div className="space-y-4 text-sm"><p className="break-all"><span className="text-muted-foreground">Target: </span>{runCandidate?.target}</p><p className="text-xs text-muted-foreground">Reviewed revision {runCandidate?.revision}</p>{reviewedAudits.map(node => <div key={node.id} className="space-y-2"><p>{node.label}</p>{node.execution?.instructions && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{node.execution.instructions}</p>}{node.plan && <p className="text-xs text-muted-foreground">{node.plan.goal.replaceAll("-", " ")} · {node.plan.runCount} {node.plan.executionMode} runs · {node.plan.depth} · {Math.round(node.plan.timeCapMs / 60000)} minutes · ${node.plan.costCapUsd} per phase</p>}{node.execution?.allowedAgentTools !== undefined && <p className="text-xs text-muted-foreground">Agent tools: {node.execution.allowedAgentTools.join(", ") || "None"}. Built-in pipeline checks run separately.</p>}</div>)}{error && <p role="alert" className="text-destructive">{error}</p>}</div><DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setRunCandidate(null)}>Cancel</Button><Button disabled={busy || !reviewedAudits.length} onClick={run}>{busy ? "Starting…" : "Run workflow"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={deleteCandidate !== null} onOpenChange={open => { if (!open && !busy) setDeleteCandidate(null); }}><DialogContent showCloseButton={!busy} onCloseAutoFocus={event => { event.preventDefault(); if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus(); else page.current?.focus(); }} className="sm:max-w-sm"><DialogHeader><DialogTitle>Delete {deleteCandidate?.name}?</DialogTitle><DialogDescription>The saved workflow will be removed. Prior run records remain available.</DialogDescription></DialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setDeleteCandidate(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => { if (!deleteCandidate) return; const reviewed = deleteCandidate; void perform(async () => { await webFetchJson(`${DEFINITIONS}/${reviewed.id}?revision=${reviewed.revision}`, { method: "DELETE" }); setDeleteCandidate(null); select(null); await cache.invalidateQueries({ queryKey: ["workflow-definitions"] }); }).catch(() => {}); }}>Delete workflow</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

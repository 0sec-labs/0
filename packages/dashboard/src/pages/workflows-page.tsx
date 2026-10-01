import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, Play, Plus, Trash2 } from "lucide-react";
import type { SecurityWorkflow, SecurityWorkflowInput } from "@0/shared";
import { createSecurityWorkflowTemplate } from "@0/shared/dist/security-workflow-templates.js";
import { parseSecurityWorkflowInput, isSecurityWorkflowOperation } from "@0/shared/dist/security-workflows.js";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WorkflowGraph } from "@/components/workflow-graph";
import { WorkflowLibrary } from "@/components/workflow-library";
import { WorkflowPhaseEditor, WorkflowSettingsEditor } from "@/components/workflow-phase-editor";
import { WorkflowDefinitionEditor } from "@/components/workflow-definition-editor";
import { WorkflowRuns } from "@/components/workflow-runs";
import { WorkflowTriggers } from "@/components/workflow-triggers";
import { addWorkflowPhase, linearWorkflowNodes, removeWorkflowPhase } from "@/components/workflow-editing";
import { ActivityIndicator } from "@/console/loading-state";

const DEFINITIONS = "/api/console/workflow-definitions";

export function WorkflowsPage() {
  const { createConsoleSession, sendConsoleMessage, webFetchJson } = useBackendApi();
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
  const definitions = useQuery({ queryKey: ["workflow-definitions"], queryFn: ({ signal }) => webFetchJson<{ definitions: SecurityWorkflow[] }>(DEFINITIONS, { signal }), refetchInterval: 5000 });
  const selected = definitions.data?.definitions.find(item => item.id === selectedId);
  const selectedNode = selected?.nodes.find(node => node.id === nodeId);
  const select = (id: string | null) => { setSearch(previous => { const next = new URLSearchParams(previous); if (id) next.set("workflow", id); else next.delete("workflow"); return next; }); setNodeId(null); setActiveSection("steps"); setError(""); };
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
    setRunCandidate(null); document.getElementById("workflow-runs")?.scrollIntoView({ block: "start" });
    await cache.invalidateQueries({ queryKey: ["workflow-executions", reviewed.id] });
  }).catch(() => {}); };
  const linear = selected ? linearWorkflowNodes(selected) !== null : false;
  useEffect(() => {
    if (!selectedId || !page.current) return;
    const sections = [...page.current.querySelectorAll<HTMLElement>("[data-workflow-section]")];
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActiveSection(visible.target.getAttribute("data-workflow-section")!);
    }, { root: page.current.closest("main"), rootMargin: "-8% 0px -60% 0px", threshold: 0 });
    sections.forEach(section => observer.observe(section));
    return () => observer.disconnect();
  }, [selectedId, Boolean(selected)]);


  return <div ref={page} tabIndex={-1} className="min-w-0 w-full space-y-6 outline-none">
    {error && <p role="alert" className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
    {definitions.isError && <p role="alert" className="text-sm text-destructive">{definitions.error.message}</p>}
    {definitions.isLoading ? <div className="py-16"><ActivityIndicator label="Loading workflows…" /></div> : !selected ? <WorkflowLibrary definitions={definitions.data?.definitions ?? []} busy={busy} onSelect={select} onTemplate={useTemplate} onImport={importDefinition} onDescribe={discuss} onDelete={(workflow, trigger) => { deleteTrigger.current = trigger; setError(""); setDeleteCandidate(structuredClone(workflow)); }} /> : <>
      <Button variant="ghost" size="sm" onClick={() => select(null)}><ArrowLeft aria-hidden="true" />Back to workflows</Button>
      <PageHeader title={selected.name} summary={selected.target || "Choose a target in Details before running."} actions={<><Button variant="ghost" size="default" disabled={busy} onClick={() => discuss("I want to update this workflow.", selected)}><MessageSquare aria-hidden="true" />Edit in chat</Button><Button ref={runTrigger} size="default" disabled={busy || !canRun} onClick={() => { setError(""); setRunCandidate(structuredClone(selected)); }}><Play aria-hidden="true" />Run</Button><Button ref={deleteTrigger} variant="ghost" size="icon" aria-label="Delete workflow" disabled={busy} onClick={() => { setError(""); setDeleteCandidate(structuredClone(selected)); }}><Trash2 aria-hidden="true" /></Button></>} />
      <div className="grid items-start gap-6 lg:grid-cols-[9rem_minmax(0,1fr)]">
        <nav aria-label="Workflow sections" className="sticky top-0 z-10 flex gap-1 overflow-x-auto bg-background py-2 lg:top-4 lg:flex-col lg:rounded-2xl lg:bg-muted/20 lg:p-2">
          {[{ id: "steps", label: "Steps" }, { id: "details", label: "Details" }, { id: "triggers", label: "Triggers" }, { id: "runs", label: "Runs" }, { id: "definition", label: "Definition" }].map(section => <a key={section.id} href={`#workflow-${section.id}`} aria-current={activeSection === section.id ? "location" : undefined} onClick={event => { event.preventDefault(); setActiveSection(section.id); document.getElementById(`workflow-${section.id}`)?.scrollIntoView({ block: "start" }); }} className={`shrink-0 rounded-xl px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary ${activeSection === section.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}>{section.label}</a>)}
        </nav>
        <div className="min-w-0 space-y-10 pb-[60dvh]">
          <section id="workflow-steps" data-workflow-section="steps" className="scroll-mt-20 space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-medium">Steps</h3><Button variant="ghost" size="sm" disabled={busy || !linear || selected.nodes.length >= 16} onClick={() => void save(addWorkflowPhase(selected)).catch(() => {})}><Plus aria-hidden="true" />Add step</Button></div>{!linear && <p className="text-xs text-muted-foreground">This graph has branches, which execute sequentially. Edit connections in Definition.</p>}<WorkflowGraph definition={selected} selectedId={nodeId} onSelect={setNodeId} />{selectedNode ? <WorkflowPhaseEditor key={`${selected.id}:${selected.revision}:${selectedNode.id}`} definition={selected} phase={selectedNode} busy={busy} onSave={save} canRemove={linear && selectedNode.type !== "trigger" && (!isSecurityWorkflowOperation(selectedNode) || selected.nodes.filter(isSecurityWorkflowOperation).length > 1)} onRemove={() => void save(removeWorkflowPhase(selected, selectedNode.id)).then(() => setNodeId(null)).catch(() => {})} /> : <p className="text-center text-xs text-muted-foreground">Select a step to edit its instructions, tools and review settings.</p>}</section>
          <section id="workflow-details" data-workflow-section="details" className="scroll-mt-20 space-y-4"><h3 className="text-sm font-medium">Details</h3><WorkflowSettingsEditor key={`${selected.id}:${selected.revision}`} definition={selected} busy={busy} onSave={save} /></section>
          <section id="workflow-triggers" data-workflow-section="triggers" className="scroll-mt-20 space-y-4"><WorkflowTriggers workflow={selected} disabled={busy} /></section>
          <section id="workflow-runs" data-workflow-section="runs" className="scroll-mt-20 space-y-4"><h3 className="text-sm font-medium">Runs</h3><WorkflowRuns workflowId={selected.id} busy={busy} onAction={perform} /></section>
          <section id="workflow-definition" data-workflow-section="definition" className="scroll-mt-20"><details className="rounded-2xl bg-muted/20 p-4"><summary className="cursor-pointer text-sm font-medium">Definition · JSON</summary><div className="mt-4"><WorkflowDefinitionEditor key={`${selected.id}:${selected.revision}`} definition={selected} busy={busy} onSave={save} /></div></details></section>
        </div>
      </div>
    </>}
    <Dialog open={runCandidate !== null} onOpenChange={open => { if (!open && !busy) setRunCandidate(null); }}><DialogContent showCloseButton={!busy} onCloseAutoFocus={event => { event.preventDefault(); runTrigger.current?.focus(); }} className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>Run {runCandidate?.name}?</DialogTitle><DialogDescription>Run these enabled steps in a new conversation.</DialogDescription></DialogHeader><div className="space-y-4 text-sm"><p className="break-all"><span className="text-muted-foreground">Target: </span>{runCandidate?.target}</p><p className="text-xs text-muted-foreground">Reviewed revision {runCandidate?.revision}</p>{reviewedAudits.map(node => <div key={node.id} className="space-y-2"><p>{node.label}</p><p className="text-xs text-muted-foreground">{node.type === "audit" ? "Security assessment" : node.type === "verify" ? "Finding verification" : node.type === "fix" ? `Fix ${node.fix?.mode ?? "candidate"}` : node.type === "research" ? "Security research" : "Deep source review"}</p>{(node.input || node.inputs) && <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/35 p-3 text-xs text-muted-foreground">{JSON.stringify({ ...(node.input ? { references: node.input } : {}), ...(node.inputs ? { inputs: node.inputs } : {}) }, null, 2)}</pre>}{node.type === "fix" && node.fix?.mode === "apply" && <p className="text-xs text-muted-foreground">Application requires separate permission and a reviewed candidate from the running host.</p>}{node.execution?.instructions && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{node.execution.instructions}</p>}{node.plan && <p className="text-xs text-muted-foreground">{node.type === "audit" && <>{node.plan.goal.replaceAll("-", " ")} · {node.plan.runCount} {node.plan.executionMode} attempts · {node.plan.depth} · </>} {Math.round(node.plan.timeCapMs / 60000)} minutes · ${node.plan.costCapUsd} per step</p>}{node.execution?.allowedAgentTools !== undefined && <p className="text-xs text-muted-foreground">Agent tools: {node.execution.allowedAgentTools.join(", ") || "None"}. Built-in pipeline checks run separately.</p>}</div>)}{error && <p role="alert" className="text-destructive">{error}</p>}</div><DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setRunCandidate(null)}>Cancel</Button><Button disabled={busy || !reviewedAudits.length} onClick={run}>{busy ? "Starting…" : "Run workflow"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={deleteCandidate !== null} onOpenChange={open => { if (!open && !busy) setDeleteCandidate(null); }}><DialogContent showCloseButton={!busy} onCloseAutoFocus={event => { event.preventDefault(); if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus(); else page.current?.focus(); }} className="sm:max-w-sm"><DialogHeader><DialogTitle>Delete {deleteCandidate?.name}?</DialogTitle><DialogDescription>The saved workflow will be removed. Prior run records remain available.</DialogDescription></DialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setDeleteCandidate(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => { if (!deleteCandidate) return; const reviewed = deleteCandidate; void perform(async () => { await webFetchJson(`${DEFINITIONS}/${reviewed.id}?revision=${reviewed.revision}`, { method: "DELETE" }); setDeleteCandidate(null); select(null); await cache.invalidateQueries({ queryKey: ["workflow-definitions"] }); }).catch(() => {}); }}>Delete workflow</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

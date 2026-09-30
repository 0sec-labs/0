import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ArrowLeft, MessageSquare, Play, Trash2, Package, CodeXml, SlidersHorizontal } from "lucide-react";
import { DEFAULT_SECURITY_WORKFLOW_PLAN, type ScanPlan, type SecurityWorkflow, type SecurityWorkflowExecution } from "@0/shared";
import { createConsoleSession, sendConsoleMessage, webFetchJson } from "@/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WorkflowGraph } from "@/components/workflow-graph";
import { ActivityIndicator } from "@/console/loading-state";

const TEMPLATES = [
  { name: "Dependency review", description: "Find known vulnerabilities in dependencies.", goal: "known-vulnerabilities", icon: Package },
  { name: "Code review", description: "Review application code for security issues.", goal: "unknown-vulnerabilities", icon: CodeXml },
  { name: "Configuration review", description: "Check a target for security misconfigurations.", goal: "misconfigurations", icon: SlidersHorizontal },
] satisfies Array<{ name: string; description: string; goal: ScanPlan["goal"]; icon: typeof Package }>;
const DEFINITIONS = "/api/console/workflow-definitions";

export function WorkflowsPage() {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get("workflow");
  const setSelectedId = (id: string | null) => setSearch(previous => { const next = new URLSearchParams(previous); if (id) next.set("workflow", id); else next.delete("workflow"); return next; });
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [activityLabel, setActivityLabel] = useState("Saving workflow…");
  const [error, setError] = useState("");
  const [runCandidate, setRunCandidate] = useState<SecurityWorkflow | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<SecurityWorkflow | null>(null);
  const runTrigger = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const stepSwitch = useRef<HTMLButtonElement | null>(null);
  const definitions = useQuery({ queryKey: ["workflow-definitions"], queryFn: ({ signal }) => webFetchJson<{ definitions: SecurityWorkflow[] }>(DEFINITIONS, { signal }), refetchInterval: 5000 });
  const selected = definitions.data?.definitions.find(item => item.id === selectedId);
  const selectedNode = selected?.nodes.find(node => node.id === nodeId);
  const executions = useQuery({ queryKey: ["workflow-executions", selectedId], queryFn: ({ signal }) => webFetchJson<{ executions: SecurityWorkflowExecution[] }>(`/api/console/workflow-executions?workflowId=${encodeURIComponent(selectedId!)}`, { signal }), enabled: Boolean(selectedId), refetchInterval: 3000 });
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update the workflow."); } finally { setBusy(false); }
  };
  const createFromTemplate = (template: typeof TEMPLATES[number]) => {
    setActivityLabel("Creating your workflow…");
    void perform(async () => {
      const result = await webFetchJson<{ definition: SecurityWorkflow }>(DEFINITIONS, { method: "POST", body: JSON.stringify({
        name: template.name, instructions: template.description, target: "",
        nodes: [
          { id: "start", type: "trigger", label: "Manual trigger", enabled: true },
          { id: "review", type: "audit", label: template.name, enabled: true, plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN, goal: template.goal } },
          { id: "results", type: "report", label: "Results", enabled: true },
        ],
        edges: [{ source: "start", target: "review" }, { source: "review", target: "results" }],
      }) });
      cache.setQueryData<{ definitions: SecurityWorkflow[] }>(["workflow-definitions"], current => ({ definitions: [result.definition, ...(current?.definitions ?? []).filter(item => item.id !== result.definition.id)] }));
      setSelectedId(result.definition.id);
      setNodeId("review");
      await cache.invalidateQueries({ queryKey: ["workflow-definitions"] });
    });
  };
  const discuss = (description: string, workflow?: SecurityWorkflow) => { setActivityLabel("Opening your conversation…"); void perform(async () => {
    const session = await createConsoleSession({ title: workflow ? `Update ${workflow.name}` : "Create a security workflow" });
    const prompt = workflow
      ? `Help me revise saved security workflow ${workflow.id}, revision ${workflow.revision}, named ${workflow.name}. Use the workflow tools to read its current definition. Discuss the changes and save the definition with console_save_workflow when ready. Do not execute it.\n\n${description}`
      : `Help me create a reusable security workflow from this request. Ask for any missing target or important details. Use console_save_workflow to save a real definition with a manual trigger, typed security review plans and a report when ready. Put descriptive context in workflow notes; only the typed review plans execute, so do not promise arbitrary notes will run as additional actions. Do not run it or claim scheduling is available.\n\n${description}`;
    await sendConsoleMessage(session.id, { text: prompt });
    navigate(`/console/${session.id}`);
  }); };
  const toggleNode = (enabled: boolean) => { if (!selected || !selectedNode) return; const toggle = stepSwitch.current; void perform(async () => {
    await webFetchJson(`${DEFINITIONS}/${encodeURIComponent(selected.id)}`, { method: "PATCH", body: JSON.stringify({ id: selected.id, revision: selected.revision, name: selected.name, instructions: selected.instructions, target: selected.target, edges: selected.edges, nodes: selected.nodes.map(node => node.id === selectedNode.id ? { ...node, enabled } : node) }) });
    await cache.invalidateQueries({ queryKey: ["workflow-definitions"] });
  }).finally(() => { if (toggle?.isConnected) requestAnimationFrame(() => toggle.focus()); }); };
  const enabledAudits = selected?.nodes.filter(node => node.type === "audit" && node.enabled) ?? [];
  const canRun = Boolean(selected?.target.trim() && selected.nodes.some(node => node.type === "trigger" && node.enabled) && enabledAudits.length);
  const reviewedAudits = runCandidate?.nodes.filter(node => node.type === "audit" && node.enabled) ?? [];
  const run = () => { if (!runCandidate) return; const reviewed = runCandidate; void perform(async () => {
    const session = await createConsoleSession({ title: reviewed.name, target: reviewed.target });
    await webFetchJson(`${DEFINITIONS}/${encodeURIComponent(reviewed.id)}/run`, { method: "POST", body: JSON.stringify({ sessionId: session.id, revision: reviewed.revision, approval: "launch-authorized-run" }) });
    setRunCandidate(null);
    await cache.invalidateQueries({ queryKey: ["workflow-executions", reviewed.id] });
  }); };

  return <div className="flex min-h-full flex-col px-4 py-5 sm:px-8">
    {selected && <div className="flex justify-end"><Button variant="ghost" size="sm" onClick={() => { setSelectedId(null); setNodeId(null); }}><ArrowLeft aria-hidden="true" />New workflow</Button></div>}
    <div className="mx-auto mt-8 flex w-full max-w-6xl flex-1 gap-8">
      {(definitions.data?.definitions.length ?? 0) > 0 && <aside aria-label="Saved workflows" className="hidden w-56 shrink-0 space-y-1 md:block"><p className="px-3 pb-2 text-xs text-muted-foreground">Your workflows</p>{definitions.data!.definitions.map(definition => <button type="button" key={definition.id} aria-current={selectedId === definition.id ? "page" : undefined} onClick={() => { setSelectedId(definition.id); setNodeId(null); }} className={`w-full rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted ${selectedId === definition.id ? "bg-muted" : ""}`}><span className="block truncate">{definition.name}</span></button>)}</aside>}
      <main className="min-w-0 flex-1">
        {error && <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
        {definitions.isError && <p role="alert" className="mb-4 text-sm text-destructive">{definitions.error.message}</p>}
        {definitions.isLoading ? <div className="mx-auto max-w-3xl py-16"><ActivityIndicator label="Loading workflows…" /></div> : !selected ? <div className="mx-auto flex max-w-3xl flex-col pt-6 sm:pt-10">
          <h2 className="text-2xl font-medium tracking-tight">Create a workflow</h2>
          <p className="mt-3 text-sm text-muted-foreground">Start with a template or describe your own.</p>
          <div className="mt-7 grid gap-3 sm:grid-cols-3">{TEMPLATES.map(template => { const Icon = template.icon; return <button type="button" key={template.name} disabled={busy} onClick={() => createFromTemplate(template)} className="flex flex-col items-start gap-3 rounded-2xl bg-muted/40 p-5 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary disabled:opacity-50"><Icon aria-hidden="true" className="size-5 text-primary" /><span className="text-sm font-medium">{template.name}</span><span className="text-xs leading-5 text-muted-foreground">{template.description}</span></button>; })}</div>
          <form className="mt-8 flex items-end gap-3 rounded-[28px] bg-muted px-4 py-3" onSubmit={event => { event.preventDefault(); if (draft.trim()) discuss(draft.trim()); }}>
            <textarea ref={textArea} rows={1} aria-label="Describe your security workflow" placeholder="Describe a custom workflow…" value={draft} disabled={busy} className="max-h-48 min-h-7 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground" onChange={event => { setDraft(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 192)}px`; }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.trim()) discuss(draft.trim()); } }} />
            <Button type="submit" size="icon-sm" disabled={busy || !draft.trim()} aria-label="Create workflow in chat"><ArrowUp aria-hidden="true" /></Button>
          </form>
          {busy && <div className="mt-3"><ActivityIndicator label={activityLabel} /></div>}
          <div className="mt-6 space-y-1 md:hidden">{definitions.data?.definitions.map(definition => <Button key={definition.id} variant="ghost" className="w-full justify-start" onClick={() => setSelectedId(definition.id)}>{definition.name}</Button>)}</div>
        </div> : <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-medium">{selected.name}</h2><p className="mt-2 break-all text-sm text-muted-foreground">{selected.target}</p></div><div className="flex gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => discuss("I want to update this workflow.", selected)}><MessageSquare aria-hidden="true" />Edit in chat</Button><Button ref={runTrigger} size="sm" disabled={busy || !canRun} onClick={() => { setError(""); setRunCandidate(structuredClone(selected)); }}><Play aria-hidden="true" />Run</Button><Button ref={deleteTrigger} variant="ghost" size="icon-sm" aria-label="Delete workflow" disabled={busy} onClick={() => { setError(""); setDeleteCandidate(structuredClone(selected)); }}><Trash2 aria-hidden="true" /></Button></div></div>
          <div><p className="mb-1 text-xs text-muted-foreground">Workflow notes</p><p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{selected.instructions}</p></div>{!selected.target.trim() && <p className="text-sm text-muted-foreground">Add a target in chat before running this workflow.</p>}
          <WorkflowGraph definition={selected} selectedId={nodeId} onSelect={setNodeId} execution={executions.data?.executions.find(execution => execution.workflowRevision === selected.revision)} />
          {selectedNode && <section className="rounded-2xl bg-muted/30 p-4" aria-label="Selected step"><div className="flex items-center justify-between gap-4"><h3 className="text-sm font-medium">{selectedNode.label}</h3>{selectedNode.type === "audit" && <label className="flex items-center gap-3 text-xs text-muted-foreground">Enabled<Switch ref={stepSwitch} aria-label={`Enable ${selectedNode.label}`} checked={selectedNode.enabled} disabled={busy} onCheckedChange={toggleNode} /></label>}</div>{selectedNode.type === "trigger" ? <p className="mt-3 text-sm text-muted-foreground">{selectedNode.enabled ? "Start this workflow manually with Run." : "The manual trigger is disabled. Enable it by editing the workflow in chat."}</p> : selectedNode.type === "report" ? <p className="mt-3 text-sm text-muted-foreground">{selectedNode.enabled ? "Collect the completed review results." : "This report step is disabled and will be skipped."}</p> : selectedNode.plan && <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground"><span>{selectedNode.plan.goal.replaceAll("-", " ")}</span><span>{selectedNode.plan.depth} depth</span><span>{selectedNode.plan.runCount} runs · {selectedNode.plan.executionMode}</span><span>{Math.round(selectedNode.plan.timeCapMs / 60000)} min · ${selectedNode.plan.costCapUsd} limit</span></div>}</section>}
          <section aria-label="Workflow run history"><h3 className="mb-3 text-sm font-medium">Runs</h3>{executions.isError ? <p role="alert" className="text-sm text-destructive">{executions.error.message}</p> : executions.isLoading ? <ActivityIndicator label="Loading runs…" /> : !executions.data?.executions.length ? <p className="text-sm text-muted-foreground">No runs yet.</p> : <div className="space-y-2">{executions.data.executions.map(execution => <div key={execution.id} className="rounded-xl bg-muted/25 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><span className="text-sm capitalize">{execution.status}</span><span className="ml-3 text-xs text-muted-foreground">{new Date(execution.createdAt).toLocaleString()} · v{execution.workflowRevision}</span></div><div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => navigate(`/console/${execution.sessionId}`)}>Open conversation</Button>{["queued", "running"].includes(execution.status) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void perform(async () => { await webFetchJson(`/api/console/workflow-executions/${execution.id}/cancel`, { method: "POST", body: JSON.stringify({ sessionId: execution.sessionId }) }); await executions.refetch(); })}>Stop</Button>}</div></div>{execution.error && <p className="mt-2 text-xs text-destructive">{execution.error}</p>}<div className="mt-2 space-y-1">{Object.entries(execution.nodeResults).map(([id, result]) => <p key={id} className="text-xs text-muted-foreground">{execution.workflow.nodes.find(node => node.id === id)?.label ?? id} · {result.status}{result.error ? ` · ${result.error}` : ""}</p>)}</div></div>)}</div>}</section>
        </div>}
      </main>
    </div>
    <Dialog open={runCandidate !== null} onOpenChange={open => { if (!open && !busy) setRunCandidate(null); }}><DialogContent showCloseButton={!busy} onCloseAutoFocus={event => { event.preventDefault(); runTrigger.current?.focus(); }} className="sm:max-w-lg"><DialogHeader><DialogTitle>Run {runCandidate?.name}?</DialogTitle><DialogDescription>Run these enabled steps in a new conversation.</DialogDescription></DialogHeader><div className="space-y-4 text-sm"><p className="break-all"><span className="text-muted-foreground">Target: </span>{runCandidate?.target}</p><p className="text-xs text-muted-foreground">Reviewed revision {runCandidate?.revision}</p>{reviewedAudits.map(node => <div key={node.id}><p>{node.label}</p>{node.plan && <p className="mt-1 text-xs text-muted-foreground">{node.plan.goal.replaceAll("-", " ")} · {node.plan.runCount} {node.plan.executionMode} runs · {node.plan.depth} · {Math.round(node.plan.timeCapMs / 60000)} minutes · ${node.plan.costCapUsd} per step</p>}</div>)}{error && <p role="alert" className="text-destructive">{error}</p>}</div><DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setRunCandidate(null)}>Cancel</Button><Button disabled={busy || !reviewedAudits.length} onClick={run}>{busy ? "Starting…" : "Run workflow"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={deleteCandidate !== null} onOpenChange={open => { if (!open && !busy) setDeleteCandidate(null); }}><DialogContent showCloseButton={!busy} onCloseAutoFocus={event => { event.preventDefault(); if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus(); else textArea.current?.focus(); }} className="sm:max-w-sm"><DialogHeader><DialogTitle>Delete {deleteCandidate?.name}?</DialogTitle><DialogDescription>The saved workflow will be removed. Prior run records remain available.</DialogDescription></DialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setDeleteCandidate(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => { if (!deleteCandidate) return; const reviewed = deleteCandidate; void perform(async () => { await webFetchJson(`${DEFINITIONS}/${reviewed.id}?revision=${reviewed.revision}`, { method: "DELETE" }); setDeleteCandidate(null); setSelectedId(null); await cache.invalidateQueries({ queryKey: ["workflow-definitions"] }); }); }}>Delete workflow</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

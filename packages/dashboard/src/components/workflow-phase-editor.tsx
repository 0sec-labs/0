import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Save, Trash2 } from "lucide-react";
import type { ScanPlan, SecurityWorkflow, SecurityWorkflowInput, SecurityWorkflowNode } from "@0/shared";
import { DEFAULT_SECURITY_WORKFLOW_PLAN, parseSecurityWorkflowInput } from "@0/shared/dist/security-workflows.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { workflowInput } from "./workflow-editing";
import { webFetchJson } from "@/api";

const GOALS: Record<ScanPlan["goal"], string> = { "known-vulnerabilities": "Known vulnerabilities", "unknown-vulnerabilities": "Code vulnerabilities", misconfigurations: "Misconfigurations" };

export function WorkflowSettingsEditor({ definition, busy, onSave }: { definition: SecurityWorkflow; busy: boolean; onSave: (input: SecurityWorkflowInput) => Promise<void> }) {
  const [name, setName] = useState(definition.name);
  const [target, setTarget] = useState(definition.target);
  const [notes, setNotes] = useState(definition.instructions);
  const [error, setError] = useState("");
  const changed = name !== definition.name || target !== definition.target || notes !== definition.instructions;
  return <form className="space-y-4 rounded-2xl bg-muted/20 p-5" onSubmit={event => { event.preventDefault(); setError(""); try { const input = parseSecurityWorkflowInput({ ...workflowInput(definition), name, target, instructions: notes }); void onSave(input).catch(cause => setError(cause instanceof Error ? cause.message : "Unable to save.")); } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid workflow."); } }}>
    <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-xs text-muted-foreground"><span>Workflow name</span><Input value={name} maxLength={160} required disabled={busy} onChange={event => setName(event.target.value)} /></label><label className="space-y-2 text-xs text-muted-foreground"><span>Target</span><Input value={target} maxLength={4096} placeholder="Repository path, package, or website" disabled={busy} onChange={event => setTarget(event.target.value)} /></label></div>
    <label className="block space-y-2 text-xs text-muted-foreground"><span>Notes</span><Textarea value={notes} maxLength={16000} rows={2} disabled={busy} onChange={event => setNotes(event.target.value)} /></label>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}<Button type="submit" size="sm" disabled={busy || !changed}><Save aria-hidden="true" />Save details</Button>
  </form>;
}

export function WorkflowPhaseEditor({ definition, phase, busy, canRemove, onRemove, onSave }: { definition: SecurityWorkflow; phase: SecurityWorkflowNode; busy: boolean; canRemove: boolean; onRemove: () => void; onSave: (input: SecurityWorkflowInput) => Promise<void> }) {
  const [label, setLabel] = useState(phase.label);
  const [enabled, setEnabled] = useState(phase.enabled);
  const [plan, setPlan] = useState<ScanPlan>({ ...(phase.plan ?? DEFAULT_SECURITY_WORKFLOW_PLAN) });
  const [instructions, setInstructions] = useState(phase.execution?.instructions ?? "");
  const [customTools, setCustomTools] = useState(phase.execution?.allowedAgentTools !== undefined);
  const [allowedTools, setAllowedTools] = useState<string[]>(phase.execution?.allowedAgentTools ?? []);
  const tools = useQuery({ queryKey: ["workflow-tool-catalog"], queryFn: ({ signal }) => webFetchJson<{ tools: { name: string; description: string }[] }>("/api/console/workflow-tool-catalog", { signal }), enabled: phase.type === "audit" });
  const [error, setError] = useState("");
  const changed = label !== phase.label || enabled !== phase.enabled || phase.type === "audit" && (JSON.stringify(plan) !== JSON.stringify(phase.plan) || instructions !== (phase.execution?.instructions ?? "") || customTools !== (phase.execution?.allowedAgentTools !== undefined) || JSON.stringify(allowedTools) !== JSON.stringify(phase.execution?.allowedAgentTools ?? []));
  const setField = <K extends keyof ScanPlan>(key: K, value: ScanPlan[K]) => setPlan(previous => ({ ...previous, [key]: value }));
  return <form aria-label="Phase settings" className="space-y-4 rounded-2xl bg-muted/20 p-5" onSubmit={event => { event.preventDefault(); setError(""); try {
    const updated = { ...phase, label, enabled, ...(phase.type === "audit" ? { plan, execution: { instructions, ...(customTools ? { allowedAgentTools: allowedTools } : {}) } } : {}) };
    const input = parseSecurityWorkflowInput({ ...workflowInput(definition), nodes: definition.nodes.map(node => node.id === phase.id ? updated : node) });
    void onSave(input).catch(cause => setError(cause instanceof Error ? cause.message : "Unable to save phase."));
  } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid phase."); } }}>
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Phase settings</h3>{phase.type !== "trigger" && <label className="flex items-center gap-3 text-xs text-muted-foreground">Enabled<Switch aria-label="Enable phase" checked={enabled} disabled={busy} onCheckedChange={setEnabled} /></label>}</div>
    <label className="block space-y-2 text-xs text-muted-foreground"><span>Phase name</span><Input value={label} required maxLength={160} disabled={busy} onChange={event => setLabel(event.target.value)} /></label>
    {phase.type === "audit" ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <label className="space-y-2 text-xs text-muted-foreground"><span>Review goal</span><Select aria-label="Review goal" disabled={busy} value={plan.goal} onValueChange={value => setField("goal", value as ScanPlan["goal"])} options={Object.entries(GOALS).map(([value, label]) => ({ value, label }))} /></label>
      <label className="space-y-2 text-xs text-muted-foreground"><span>Depth</span><Select aria-label="Depth" disabled={busy} value={plan.depth} onValueChange={value => setField("depth", value as ScanPlan["depth"])} options={["quick", "default", "deep"].map(value => ({ value, label: value }))} /></label>
      <label className="space-y-2 text-xs text-muted-foreground"><span>Runs</span><Input type="number" value={plan.runCount} min={1} max={16} required disabled={busy} onChange={event => setField("runCount", event.target.valueAsNumber)} /></label>
      <label className="space-y-2 text-xs text-muted-foreground"><span>Run execution</span><Select aria-label="Run execution" disabled={busy} value={plan.executionMode} onValueChange={value => setField("executionMode", value as ScanPlan["executionMode"])} options={[{ value: "sequential", label: "Sequential" }, { value: "parallel", label: "Parallel" }]} /></label>
      <label className="space-y-2 text-xs text-muted-foreground"><span>Time limit (minutes)</span><Input type="number" value={plan.timeCapMs / 60000} min={1 / 60000} max={1440} step="any" required disabled={busy} onChange={event => setField("timeCapMs", Math.round(event.target.valueAsNumber * 60000))} /></label>
      <label className="space-y-2 text-xs text-muted-foreground"><span>Cost limit (USD)</span><Input type="number" value={plan.costCapUsd} min={0.01} max={1000} step="any" required disabled={busy} onChange={event => setField("costCapUsd", event.target.valueAsNumber)} /></label>
    </div> : <p className="text-sm text-muted-foreground">{phase.type === "trigger" ? "Start this workflow manually with Run." : "Collect the completed review results."}</p>}
    {phase.type === "audit" && <><label className="block space-y-2 text-xs text-muted-foreground"><span>Phase instructions</span><Textarea rows={4} maxLength={16000} value={instructions} placeholder="What should the review focus on?" disabled={busy} onChange={event => setInstructions(event.target.value)} /></label><details className="rounded-2xl bg-background/40 p-4"><summary className="cursor-pointer text-xs font-medium">Advanced · Agent tools</summary><div className="mt-4 space-y-3"><label className="block space-y-2 text-xs text-muted-foreground"><span>Agent tools</span><Select aria-label="Agent tools" disabled={busy} value={customTools ? "custom" : "default"} onValueChange={value => setCustomTools(value === "custom")} options={[{ value: "default", label: "Use default tools" }, { value: "custom", label: "Choose allowed tools" }]} /></label><p className="text-xs text-muted-foreground">Built-in pipeline checks run separately.</p>{customTools && <><p className="text-xs text-muted-foreground">{allowedTools.length ? `${allowedTools.length} agent tools allowed` : "No agent tool calls allowed."}</p>{tools.isError && <p role="alert" className="text-xs text-destructive">{tools.error.message}</p>}<div className="grid max-h-56 gap-2 overflow-y-auto rounded-xl bg-background/60 p-3 sm:grid-cols-2">{tools.data?.tools.map(tool => <label key={tool.name} title={tool.description} className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={busy} checked={allowedTools.includes(tool.name)} onChange={event => setAllowedTools(previous => event.target.checked ? [...previous, tool.name] : previous.filter(name => name !== tool.name))} className="accent-primary" /><span>{tool.name}</span></label>)}</div></>}</div></details></>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}<div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || !changed}><Save aria-hidden="true" />Save phase</Button>{canRemove && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}><Trash2 aria-hidden="true" />Remove phase</Button>}</div>
  </form>;
}

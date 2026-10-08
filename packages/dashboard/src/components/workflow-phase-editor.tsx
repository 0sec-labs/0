import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Save, Trash2 } from "lucide-react";
import type { ScanPlan, SecurityWorkflow, SecurityWorkflowInput, SecurityWorkflowNode } from "@0/shared";
import { DEFAULT_SECURITY_WORKFLOW_PLAN, parseSecurityWorkflowInput, isSecurityWorkflowOperation } from "@0/shared/dist/security-workflows.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { workflowInput } from "./workflow-editing";
import { useBackendApi } from "@/api";
import { advanceWorkflowDraftBase, workflowDraftHasConflict } from "./workflow-definition-editor";

const GOALS: Record<ScanPlan["goal"], string> = { "known-vulnerabilities": "Known vulnerabilities", "unknown-vulnerabilities": "Code vulnerabilities", misconfigurations: "Misconfigurations" };

export function WorkflowSettingsEditor({ definition, busy, onSave }: { definition: SecurityWorkflow; busy: boolean; onSave: (input: SecurityWorkflowInput) => Promise<void> }) {
  const [base, setBase] = useState(() => structuredClone(definition));
  const [name, setName] = useState(definition.name);
  const [target, setTarget] = useState(definition.target);
  const [notes, setNotes] = useState(definition.instructions);
  const [error, setError] = useState("");
  const changed = name !== base.name || target !== base.target || notes !== base.instructions;
  return <form className="space-y-4 rounded-2xl bg-muted/20 p-5" onSubmit={event => { event.preventDefault(); setError(""); try { const input = parseSecurityWorkflowInput({ ...workflowInput(base), name, target, instructions: notes }); void onSave(input).then(() => setBase(advanceWorkflowDraftBase(base, input))).catch(cause => setError(cause instanceof Error ? cause.message : "Unable to save.")); } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid workflow."); } }}>
    {workflowDraftHasConflict(base, definition) && <div role="status" className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>Workflow changed. Your draft is kept.</span><Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => { setBase(structuredClone(definition)); setName(definition.name); setTarget(definition.target); setNotes(definition.instructions); setError(""); }}>Reload latest</Button></div>}
    <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-xs text-muted-foreground"><span>Workflow name</span><Input value={name} maxLength={160} required disabled={busy} onChange={event => setName(event.target.value)} /></label><label className="space-y-2 text-xs text-muted-foreground"><span>Target</span><Input value={target} maxLength={4096} placeholder="Repository path, package, or website" disabled={busy} onChange={event => setTarget(event.target.value)} /></label></div>
    <label className="block space-y-2 text-xs text-muted-foreground"><span>Description</span><Textarea value={notes} maxLength={16000} rows={2} disabled={busy} onChange={event => setNotes(event.target.value)} /></label>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}<Button type="submit" size="sm" disabled={busy || !changed}><Save aria-hidden="true" />Save details</Button>
  </form>;
}

export function WorkflowPhaseEditor({ definition, phase, busy, canRemove, onRemove, onSave }: { definition: SecurityWorkflow; phase: SecurityWorkflowNode; busy: boolean; canRemove: boolean; onRemove: () => void; onSave: (input: SecurityWorkflowInput) => Promise<void> }) {
  const { webFetchJson } = useBackendApi();
  const [baseDefinition, setBaseDefinition] = useState(() => structuredClone(definition));
  const [basePhase, setBasePhase] = useState(() => structuredClone(phase));
  const [type, setType] = useState(phase.type);
  const operation = isSecurityWorkflowOperation({ type });
  const [inputOptions, setInputOptions] = useState(() => JSON.stringify(phase.inputs ?? {}, null, 2));
  const [inputReferences, setInputReferences] = useState(() => ({ ...phase.input }));
  const [label, setLabel] = useState(phase.label);
  const [enabled, setEnabled] = useState(phase.enabled);
  const [plan, setPlan] = useState<ScanPlan>({ ...(phase.plan ?? DEFAULT_SECURITY_WORKFLOW_PLAN) });
  const [instructions, setInstructions] = useState(phase.execution?.instructions ?? "");
  const [customTools, setCustomTools] = useState(phase.execution?.allowedAgentTools !== undefined);
  const [allowedTools, setAllowedTools] = useState<string[]>(phase.execution?.allowedAgentTools ?? []);
  const tools = useQuery({ queryKey: ["workflow-tool-catalog"], queryFn: ({ signal }) => webFetchJson<{ tools: { name: string; description: string }[] }>("/api/console/workflow-tool-catalog", { signal }), enabled: operation });
  const [error, setError] = useState("");
  const changed = type !== basePhase.type || inputOptions !== JSON.stringify(basePhase.inputs ?? {}, null, 2) || JSON.stringify(inputReferences) !== JSON.stringify(basePhase.input ?? {}) || label !== basePhase.label || enabled !== basePhase.enabled || operation && (JSON.stringify(plan) !== JSON.stringify(basePhase.plan ?? DEFAULT_SECURITY_WORKFLOW_PLAN) || instructions !== (basePhase.execution?.instructions ?? "") || customTools !== (basePhase.execution?.allowedAgentTools !== undefined) || JSON.stringify(allowedTools) !== JSON.stringify(basePhase.execution?.allowedAgentTools ?? []));
  const setField = <K extends keyof ScanPlan>(key: K, value: ScanPlan[K]) => setPlan(previous => ({ ...previous, [key]: value }));
  return <form aria-label="Step settings" className="space-y-4 rounded-2xl bg-muted/20 p-5" onSubmit={event => { event.preventDefault(); setError(""); try {
    const { fix, inputs: _inputs, input: _input, ...base } = basePhase;
    const inputs: unknown = JSON.parse(inputOptions);
    const input = Object.fromEntries(Object.entries(inputReferences).filter(([, value]) => value?.trim()));
    const updated = { ...base, type, label, enabled, ...(operation ? { plan, execution: { instructions, ...(customTools ? { allowedAgentTools: allowedTools } : {}) }, inputs, ...(Object.keys(input).length ? { input } : {}), ...(type === "fix" ? { fix: fix ?? { mode: "candidate" } } : {}) } : {}) };
    const savedInput = parseSecurityWorkflowInput({ ...workflowInput(baseDefinition), nodes: baseDefinition.nodes.map(node => node.id === basePhase.id ? updated : node) });
    void onSave(savedInput).then(() => { setBaseDefinition(advanceWorkflowDraftBase(baseDefinition, savedInput)); setBasePhase(structuredClone(savedInput.nodes.find(node => node.id === basePhase.id)!)); }).catch(cause => setError(cause instanceof Error ? cause.message : "Unable to save step."));
  } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid step."); } }}>
    {workflowDraftHasConflict(baseDefinition, definition) && <div role="status" className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>Workflow changed. Your draft is kept.</span><Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => { setBaseDefinition(structuredClone(definition)); setBasePhase(structuredClone(phase)); setType(phase.type); setInputOptions(JSON.stringify(phase.inputs ?? {}, null, 2)); setInputReferences({ ...phase.input }); setLabel(phase.label); setEnabled(phase.enabled); setPlan({ ...(phase.plan ?? DEFAULT_SECURITY_WORKFLOW_PLAN) }); setInstructions(phase.execution?.instructions ?? ""); setCustomTools(phase.execution?.allowedAgentTools !== undefined); setAllowedTools(phase.execution?.allowedAgentTools ?? []); setError(""); }}>Reload latest</Button></div>}
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Step settings</h3>{phase.type !== "trigger" && <label className="flex items-center gap-3 text-xs text-muted-foreground">Enabled<Switch aria-label="Enable step" checked={enabled} disabled={busy} onCheckedChange={setEnabled} /></label>}</div>
    <label className="block space-y-2 text-xs text-muted-foreground"><span>Step name</span><Input value={label} required maxLength={160} disabled={busy} onChange={event => setLabel(event.target.value)} /></label>
    {operation && <label className="block space-y-2 text-xs text-muted-foreground"><span>Operation</span><Select aria-label="Step operation" disabled={busy} value={type} onValueChange={value => setType(value as SecurityWorkflowNode["type"])} options={[{ value: "audit", label: "Security assessment" }, { value: "verify", label: "Finding verification" }, { value: "fix", label: "Fix candidate and validation" }, { value: "research", label: "Security research" }, { value: "deep-review", label: "Deep source review" }]} /></label>}
    {operation ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {type === "audit" && <><label className="space-y-2 text-xs text-muted-foreground"><span>Review goal</span><Select aria-label="Review goal" disabled={busy} value={plan.goal} onValueChange={value => setField("goal", value as ScanPlan["goal"])} options={Object.entries(GOALS).map(([value, label]) => ({ value, label }))} /></label>
      <label className="space-y-2 text-xs text-muted-foreground"><span>Depth</span><Select aria-label="Depth" disabled={busy} value={plan.depth} onValueChange={value => setField("depth", value as ScanPlan["depth"])} options={["quick", "default", "deep"].map(value => ({ value, label: value }))} /></label>
      <label className="space-y-2 text-xs text-muted-foreground"><span>Attempts</span><Input type="number" value={plan.runCount} min={1} max={16} required disabled={busy} onChange={event => setField("runCount", event.target.valueAsNumber)} /></label>
      <label className="space-y-2 text-xs text-muted-foreground"><span>Attempt execution</span><Select aria-label="Attempt execution" disabled={busy} value={plan.executionMode} onValueChange={value => setField("executionMode", value as ScanPlan["executionMode"])} options={[{ value: "sequential", label: "Sequential" }, { value: "parallel", label: "Parallel" }]} /></label>
      </>}<label className="space-y-2 text-xs text-muted-foreground"><span>Time limit (minutes)</span><Input type="number" value={plan.timeCapMs / 60000} min={1 / 60000} max={1440} step="any" required disabled={busy} onChange={event => setField("timeCapMs", Math.round(event.target.valueAsNumber * 60000))} /></label>
      <label className="space-y-2 text-xs text-muted-foreground"><span>Cost limit (USD)</span><Input type="number" value={plan.costCapUsd} min={0.01} max={1000} step="any" required disabled={busy} onChange={event => setField("costCapUsd", event.target.valueAsNumber)} /></label>
    </div> : <p className="text-sm text-muted-foreground">{phase.type === "trigger" ? "Start this workflow manually with Run." : "Collect findings and artifact references into a combined report, preserving the original evidence and verification status."}</p>}
    {operation && <>
      <div className="grid gap-4 sm:grid-cols-2">{(["findingId", "scanId", "dbPath", "fromStep", "artifactId"] as const).map(key => <label key={key} className="space-y-2 text-xs text-muted-foreground"><span>{{ findingId: "Existing finding ID", scanId: "Source scan ID", dbPath: "Finding database path", fromStep: "Evidence from earlier step ID", artifactId: "Artifact reference" }[key]}</span><Input value={inputReferences[key] ?? ""} disabled={busy} maxLength={key === "dbPath" ? 4096 : 128} onChange={event => setInputReferences(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}</div>
      <label className="block space-y-2 text-xs text-muted-foreground"><span>Operation inputs (JSON)</span><Textarea rows={4} value={inputOptions} disabled={busy} maxLength={32768} spellCheck={false} onChange={event => setInputOptions(event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">{type === "verify" ? "Supply finding evidence and an explicit runner: local, smolvm, docker, or qemu." : type === "fix" ? "Supply finding evidence and a testCommand. Candidate mode proposes and validates a fix; applying requires separate permission from the running host." : type === "research" ? "Select the supported research engine and its inputs. Each engine validates its own prerequisites." : type === "deep-review" ? "Review source with the deep review engine. Optional inputs select its profile and review limits." : "Earlier connected steps provide evidence. Input bindings do not grant additional access."}</p>
<label className="block space-y-2 text-xs text-muted-foreground"><span>Step instructions</span><Textarea rows={4} maxLength={16000} value={instructions} placeholder="What should the review focus on?" disabled={busy} onChange={event => setInstructions(event.target.value)} /></label><details className="rounded-2xl bg-background/40 p-4"><summary className="cursor-pointer text-xs font-medium">Advanced · Agent tools</summary><div className="mt-4 space-y-3"><label className="block space-y-2 text-xs text-muted-foreground"><span>Agent tools</span><Select aria-label="Agent tools" disabled={busy} value={customTools ? "custom" : "default"} onValueChange={value => setCustomTools(value === "custom")} options={[{ value: "default", label: "Use default tools" }, { value: "custom", label: "Choose allowed tools" }]} /></label><p className="text-xs text-muted-foreground">Built-in pipeline checks run separately.</p>{customTools && <><p className="text-xs text-muted-foreground">{allowedTools.length ? `${allowedTools.length} agent tools allowed` : "No agent tool calls allowed."}</p>{tools.isError && <p role="alert" className="text-xs text-destructive">{tools.error.message}</p>}<div className="grid max-h-56 gap-2 overflow-y-auto rounded-xl bg-background/60 p-3 sm:grid-cols-2">{tools.data?.tools.map(tool => <label key={tool.name} title={tool.description} className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={busy} checked={allowedTools.includes(tool.name)} onChange={event => setAllowedTools(previous => event.target.checked ? [...previous, tool.name] : previous.filter(name => name !== tool.name))} className="accent-primary" /><span>{tool.name}</span></label>)}</div></>}</div></details></>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}<div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || !changed}><Save aria-hidden="true" />Save step</Button>{canRemove && <Button type="button" variant="ghost" size="sm" disabled={busy || workflowDraftHasConflict(baseDefinition, definition)} onClick={onRemove}><Trash2 aria-hidden="true" />Remove step</Button>}</div>
  </form>;
}

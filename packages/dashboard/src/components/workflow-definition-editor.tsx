import { useState } from "react";
import { Download, Save } from "lucide-react";
import type { SecurityWorkflow, SecurityWorkflowInput } from "@0/shared";
import { exportSecurityWorkflowCode, parseSecurityWorkflowCode } from "@0/shared/dist/security-workflows.js";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function workflowDraftHasConflict(base: Pick<SecurityWorkflow, "id" | "revision">, latest: Pick<SecurityWorkflow, "id" | "revision">): boolean {
  return base.id === latest.id && base.revision !== latest.revision;
}
export function advanceWorkflowDraftBase(base: SecurityWorkflow, submitted: SecurityWorkflowInput): SecurityWorkflow {
  if (submitted.id !== base.id || submitted.revision !== base.revision) throw new Error("Workflow save does not match the draft revision.");
  return { ...structuredClone(submitted), id: base.id, revision: base.revision + 1, createdAt: base.createdAt, updatedAt: new Date().toISOString() };
}

export function WorkflowDefinitionEditor({ definition, busy, onSave }: { definition: SecurityWorkflow; busy: boolean; onSave: (input: SecurityWorkflowInput) => Promise<void> }) {
  const serialize = (value: SecurityWorkflow) => {
    try { return { source: exportSecurityWorkflowCode(value), error: "" }; }
    catch (cause) {
      const { name, instructions, target, nodes, edges } = value;
      return { source: JSON.stringify({ schemaVersion: 1, workflow: { name, instructions, target, nodes, edges } }, null, 2), error: cause instanceof Error ? cause.message : "Unable to export this definition." };
    }
  };
  const [initial] = useState(() => serialize(definition));
  const [base, setBase] = useState(() => structuredClone(definition));
  const [savedSource, setSavedSource] = useState(initial.source);
  const [source, setSource] = useState(initial.source);
  const [error, setError] = useState(initial.error);
  const download = () => {
    try {
      const validated = exportSecurityWorkflowCode(parseSecurityWorkflowCode(source));
      const url = URL.createObjectURL(new Blob([validated], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${definition.name.replace(/[^A-Za-z0-9_-]/g, "_") || "workflow"}.json`; anchor.click(); URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid workflow definition."); }
  };
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); setError(""); try {
    const parsed = parseSecurityWorkflowCode(source);
    const submitted = { ...parsed, id: base.id, revision: base.revision };
    const submittedSource = source;
    void onSave(submitted).then(() => { setBase(advanceWorkflowDraftBase(base, submitted)); setSavedSource(submittedSource); }).catch(cause => setError(cause instanceof Error ? cause.message : "Unable to save definition."));
  } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid workflow definition."); } }}>
    {workflowDraftHasConflict(base, definition) && <div role="status" className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>Workflow changed. Your draft is kept.</span><Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => { const latest = serialize(definition); setBase(structuredClone(definition)); setSource(latest.source); setSavedSource(latest.source); setError(latest.error); }}>Reload latest</Button></div>}
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Portable JSON defines steps, links and review settings.</p><Button type="button" size="sm" variant="ghost" onClick={download}><Download aria-hidden="true" />Download JSON</Button></div>
    <Textarea aria-label="Workflow JSON definition" spellCheck={false} autoComplete="off" rows={22} className="min-h-96 resize-y rounded-2xl bg-muted/30 p-5 font-mono text-xs leading-6" value={source} disabled={busy} onChange={event => setSource(event.target.value)} />
    {error && <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
    <Button type="submit" size="sm" disabled={busy || source === savedSource}><Save aria-hidden="true" />Save definition</Button>
  </form>;
}

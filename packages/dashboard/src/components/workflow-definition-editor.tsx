import { useState } from "react";
import { Download, Save } from "lucide-react";
import type { SecurityWorkflow, SecurityWorkflowInput } from "@0/shared";
import { exportSecurityWorkflowCode, parseSecurityWorkflowCode } from "@0/shared/dist/security-workflows.js";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function WorkflowDefinitionEditor({ definition, busy, onSave }: { definition: SecurityWorkflow; busy: boolean; onSave: (input: SecurityWorkflowInput) => Promise<void> }) {
  const [initial] = useState(() => {
    try { return { source: exportSecurityWorkflowCode(definition), error: "" }; }
    catch (cause) {
      const { name, instructions, target, nodes, edges } = definition;
      return { source: JSON.stringify({ schemaVersion: 1, workflow: { name, instructions, target, nodes, edges } }, null, 2), error: cause instanceof Error ? cause.message : "Unable to export this definition." };
    }
  });
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
    void onSave({ ...parsed, id: definition.id, revision: definition.revision }).catch(cause => setError(cause instanceof Error ? cause.message : "Unable to save definition."));
  } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid workflow definition."); } }}>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Portable JSON defines phases, links and review settings.</p><Button type="button" size="sm" variant="ghost" onClick={download}><Download aria-hidden="true" />Download JSON</Button></div>
    <Textarea aria-label="Workflow JSON definition" spellCheck={false} autoComplete="off" rows={22} className="min-h-96 resize-y rounded-2xl bg-muted/30 p-5 font-mono text-xs leading-6" value={source} disabled={busy} onChange={event => setSource(event.target.value)} />
    {error && <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
    <Button type="submit" size="sm" disabled={busy || source === initial.source}><Save aria-hidden="true" />Save definition</Button>
  </form>;
}

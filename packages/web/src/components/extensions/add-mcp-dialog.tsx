import { useState } from "react";
import { Input } from "@/components/ui/input";
import { FormDialog } from "@/ui/components/confirm-dialog";
import { mcpDraftInput, mcpDraftProblem } from "@/lib/extensions-model";
import type { InstallInput } from "./use-extensions";

/** Add one MCP server by command or https URL. It becomes a local extension and goes through the same review before anything is installed or run. */
export function AddMcpDialog({ open, pending, error, onSubmit, onClose }: { open: boolean; pending: boolean; error: string; onSubmit: (input: InstallInput) => void; onClose: () => void }) {
  const [name, setName] = useState(""); const [target, setTarget] = useState("");
  const problem = name.trim() || target.trim() ? mcpDraftProblem(name, target) : null;
  return <FormDialog open={open} onOpenChange={next => { if (!next) onClose(); }} pending={pending} title="Add an MCP server" description="Type the command that starts it (for example npx -y some-mcp) or an https URL. You review it before it is added; it starts only when a tool of it is first used."
    submitLabel={pending ? "Reading…" : "Review"} submitDisabled={!name.trim() || !target.trim() || Boolean(problem)} onSubmit={event => { event.preventDefault(); onSubmit(mcpDraftInput(name, target)); }}
    error={(problem || error) && <p role="alert" className="text-sm text-destructive">{problem || error}</p>}>
    <label className="block space-y-2 text-sm"><span>Name</span><Input value={name} onChange={event => setName(event.target.value)} placeholder="docs" autoComplete="off" spellCheck={false} disabled={pending} autoFocus /></label>
    <label className="block space-y-2 text-sm"><span>Command or URL</span><Input value={target} onChange={event => setTarget(event.target.value)} placeholder="npx -y some-mcp  or  https://example.com/mcp" autoComplete="off" spellCheck={false} disabled={pending} /></label>
  </FormDialog>;
}

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { FormDialog } from "@/ui/components/confirm-dialog";

/** Step one of adding: where it lives. Nothing is fetched until Review is pressed, and nothing is installed by this dialog. */
export function AddExtensionDialog({ open, pending, error, problem, onSubmit, onClose }: { open: boolean; pending: boolean; error: string; problem: (source: string) => string | null; onSubmit: (source: string) => void; onClose: () => void }) {
  const [source, setSource] = useState("");
  const invalid = source.trim() ? problem(source) : null;
  return <FormDialog open={open} onOpenChange={next => { if (!next) onClose(); }} pending={pending} title="Add an extension" description="Paste a git URL or owner/repo. Add @ and a full commit to pin one. You review it before anything is installed."
    submitLabel={pending ? "Reading…" : "Review"} submitDisabled={!source.trim() || Boolean(invalid)} onSubmit={event => { event.preventDefault(); onSubmit(source); }}
    error={(invalid || error) && <p role="alert" className="text-sm text-destructive">{invalid || error}</p>}>
    <label className="block space-y-2 text-sm"><span>Source</span><Input value={source} onChange={event => setSource(event.target.value)} placeholder="owner/repo@commit or https://…" autoComplete="off" spellCheck={false} disabled={pending} autoFocus /></label>
  </FormDialog>;
}

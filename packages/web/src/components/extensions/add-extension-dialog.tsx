import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { FormDialog } from "@/ui/components/confirm-dialog";

export type SourceKind = "github" | "folder";
const COPY: Record<SourceKind, { title: string; description: string; label: string; placeholder: string }> = {
  github: { title: "Add from GitHub", description: "Paste owner/repo or a git URL. Add @ and a full commit to pin it. You review what it can do before anything is installed.", label: "Repository", placeholder: "owner/repo@commit or https://…" },
  folder: { title: "Add from a folder", description: "A folder on this computer that holds an extension. You review what it can do before anything is installed.", label: "Folder", placeholder: "~/extensions/my-extension" },
};

/** Step one of adding: where it lives. Nothing is fetched until Review is pressed, and nothing is installed by this dialog. */
export function AddExtensionDialog({ open, kind, pending, error, problem, onSubmit, onClose }: { open: boolean; kind: SourceKind; pending: boolean; error: string; problem: (source: string) => string | null; onSubmit: (source: string) => void; onClose: () => void }) {
  const [source, setSource] = useState("");
  useEffect(() => { if (open) setSource(""); }, [open, kind]);
  const copy = COPY[kind];
  const invalid = kind === "github" && source.trim() ? problem(source) : null;
  return <FormDialog open={open} onOpenChange={next => { if (!next) onClose(); }} pending={pending} title={copy.title} description={copy.description} className="sm:max-w-md rounded-md"
    submitLabel={pending ? "Reading…" : "Review"} submitDisabled={!source.trim() || Boolean(invalid)} onSubmit={event => { event.preventDefault(); onSubmit(source); }}
    error={(invalid || error) && <p role="alert" className="text-sm text-destructive">{invalid || error}</p>}>
    <label className="block space-y-2 text-sm"><span>{copy.label}</span><Input value={source} onChange={event => setSource(event.target.value)} placeholder={copy.placeholder} autoComplete="off" spellCheck={false} disabled={pending} autoFocus /></label>
  </FormDialog>;
}

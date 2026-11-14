import { useEffect, useRef, useState } from "react";
import { Download, FileJson, Upload } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const MAX_BYTES = 1_048_576;
interface MemoryArchive { format: "zero-memory"; version: 1; knowledge: unknown[]; }
interface MemoryPreview { digest: string; total: number; importable: number; duplicates: number; projects: string[]; knowledge: { id: string; projectId: string; summary: string; sourceCount: number; duplicate: boolean }[]; warnings: string[]; }

/** Local file selection is separate from server review and explicit import. */
export function MemoryPortability() {
  const { client, webFetchJson } = useBackendApi();
  const team = useTeamAccess();
  const cache = useQueryClient();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [archive, setArchive] = useState<MemoryArchive | null>(null);
  const [filename, setFilename] = useState("");
  const [preview, setPreview] = useState<MemoryPreview | null>(null);
  const [busy, setBusy] = useState<"file" | "export" | "review" | "import" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const reset = () => { generation.current++; request.current?.abort(); setArchive(null); setFilename(""); setPreview(null); setBusy(null); setError(""); if (fileInput.current) fileInput.current.value = ""; };
  useEffect(() => {
    reset(); setOpen(false); setStatus("");
    return () => { generation.current++; request.current?.abort(); };
  }, [client.backendId, team.user?.workspaceId, team.user?.userId]);
  const start = (kind: "export" | "review" | "import") => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(kind); setError(""); setStatus("");
    return { signal: controller.signal, version: ++generation.current };
  };
  const exportLessons = async () => {
    const { signal, version } = start("export");
    try {
      const data = await webFetchJson<MemoryArchive>("/api/console/learning/export", { signal });
      if (version !== generation.current) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `zero-memory-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Lessons exported.");
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : "Couldn’t export lessons."); }
    finally { if (version === generation.current) setBusy(null); }
  };
  const chooseFile = async (file: File | undefined) => {
    reset(); if (!file) return;
    const version = generation.current; setBusy("file"); setFilename(file.name);
    try {
      if (file.size > MAX_BYTES) throw new Error("Choose a JSON file smaller than 1 MB.");
      const data: unknown = JSON.parse(await file.text());
      if (version !== generation.current) return;
      if (!data || typeof data !== "object" || (data as MemoryArchive).format !== "zero-memory" || (data as MemoryArchive).version !== 1 || !Array.isArray((data as MemoryArchive).knowledge)) throw new Error("Choose a version 1 Zero memory export.");
      if ((data as MemoryArchive).knowledge.length > 200) throw new Error("Import up to 200 lessons at a time.");
      setArchive(data as MemoryArchive);
    } catch (cause) { if (version === generation.current) setError(cause instanceof SyntaxError ? "This file isn’t valid JSON." : cause instanceof Error ? cause.message : "Couldn’t read this file."); }
    finally { if (version === generation.current) setBusy(null); }
  };
  const reviewImport = async () => {
    if (!archive || readOnly) return;
    const { signal, version } = start("review");
    try {
      const data = await webFetchJson<{ preview: MemoryPreview }>("/api/console/learning/import/preview", { method: "POST", signal, body: JSON.stringify({ archive }) });
      if (version === generation.current) setPreview(data.preview);
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : "Couldn’t review this import."); }
    finally { if (version === generation.current) setBusy(null); }
  };
  const importLessons = async () => {
    if (!archive || !preview || readOnly) return;
    const { signal, version } = start("import");
    try {
      const data = await webFetchJson<{ result: { imported: number; duplicates: number; disabled: true } }>("/api/console/learning/import", { method: "POST", signal, body: JSON.stringify({ archive, digest: preview.digest }) });
      if (version !== generation.current) return;
      await cache.invalidateQueries({ queryKey: ["console-learning", client.backendId] });
      if (version !== generation.current) return;
      setOpen(false); setStatus(`${data.result.imported} ${data.result.imported === 1 ? "lesson imported" : "lessons imported"}. Imported lessons are not in use.`); reset();
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : "Couldn’t import lessons."); }
    finally { if (version === generation.current) setBusy(null); }
  };
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void exportLessons()}><Download className="size-3.5" />{busy === "export" ? "Exporting…" : "Export lessons"}</Button><Button variant="outline" size="sm" disabled={readOnly || busy !== null} onClick={() => { reset(); setStatus(""); setOpen(true); }}><Upload className="size-3.5" />Import lessons</Button></div>
    {status && <p role="status" className="text-xs text-muted-foreground">{status}</p>}
    {error && !open && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <Dialog open={open} onOpenChange={value => { if (busy === "import") return; if (!value) reset(); setOpen(value); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg" showCloseButton={busy !== "import"}>
        <DialogHeader><DialogTitle>{preview ? "Review imported lessons" : "Import lessons"}</DialogTitle><DialogDescription>Bring source-backed codebase lessons into this engine. Imports retain their project and source references and stay out of recall.</DialogDescription></DialogHeader>
        <input ref={fileInput} type="file" accept=".json,application/json" aria-label="Memory export JSON file" className="hidden" onChange={event => void chooseFile(event.currentTarget.files?.[0])} />
        <div className="flex min-w-0 items-center gap-3 rounded-[var(--radius-panel)] bg-muted/40 p-3"><FileJson aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm">{filename || "Select a Zero memory export"}</p><p className="mt-0.5 text-xs text-muted-foreground">{archive ? `${archive.knowledge.length} ${archive.knowledge.length === 1 ? "lesson" : "lessons"}` : "JSON · up to 1 MB · 200 lessons"}</p></div><Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => fileInput.current?.click()}>{filename ? "Change file" : "Choose file"}</Button></div>
        {archive && !preview && <p className="text-xs leading-5 text-muted-foreground">This file is selected locally. Review import checks it with this engine before anything is saved.</p>}
        {preview && <div className="space-y-3"><dl className="grid grid-cols-3 gap-3 text-xs"><div><dt className="text-muted-foreground">New lessons</dt><dd className="mt-1 text-lg tabular-nums">{preview.importable}</dd></div><div><dt className="text-muted-foreground">Already saved</dt><dd className="mt-1 text-lg tabular-nums">{preview.duplicates}</dd></div><div><dt className="text-muted-foreground">Projects</dt><dd className="mt-1 text-lg tabular-nums">{preview.projects.length}</dd></div></dl><ul aria-label="Lessons to import" className="max-h-56 space-y-2 overflow-y-auto">{preview.knowledge.map(note => <li key={note.id} className="rounded-[var(--radius-control)] border border-border p-3"><p className="whitespace-pre-wrap break-words text-xs leading-5">{note.summary}</p><p className="mt-1 text-xs text-muted-foreground">{note.sourceCount} {note.sourceCount === 1 ? "source" : "sources"} · {note.duplicate ? "Already saved" : "Not in use after import"}</p></li>)}</ul>{preview.warnings.length > 0 && <ul aria-label="Import notes" className="space-y-1 text-xs leading-5 text-muted-foreground">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="ghost" disabled={busy === "import"} onClick={() => { reset(); setOpen(false); }}>Cancel</Button>{preview ? <Button disabled={readOnly || busy !== null || preview.importable === 0} onClick={() => void importLessons()}><Upload className="size-3.5" />{busy === "import" ? "Importing…" : `Import ${preview.importable} ${preview.importable === 1 ? "lesson" : "lessons"}`}</Button> : <Button disabled={readOnly || busy !== null || !archive} onClick={() => void reviewImport()}>{busy === "review" ? "Reviewing…" : "Review import"}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

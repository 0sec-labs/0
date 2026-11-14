import { useState } from "react";
import { FileText, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LoadingState } from "@/components/state-panel";
import { cn } from "@/lib/utils";
import { useSentinelClient, useSentinelFile, useSentinelFiles, useSentinelMutations } from "@/sentinels/api";
import { DEFAULT_FILES, SENTINEL_LIMITS, fileBytes, isConflict, type SentinelFile, type SentinelFileRevision } from "@/sentinels/model";

const FILE_HINTS: Record<string, string> = {
  "AGENTS.md": "The charter: standing role, scope and hard limits.",
  "CREW.md": "How the crew is organised when work is big.",
  "NOTES.md": "Running memory. Review what the Sentinel saves here.",
};
interface Draft { path: string; revision: number | null; content: string }

function Editor({ sentinelId, initial, revisions, readOnly }: { sentinelId: string; initial: Draft; revisions: SentinelFileRevision[]; readOnly: boolean }) {
  const { client } = useSentinelClient();
  const { saveFile } = useSentinelMutations();
  const [base, setBase] = useState(initial);
  const [text, setText] = useState(initial.content);
  const [conflict, setConflict] = useState<SentinelFile | null>(null);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState(false);
  const dirty = text !== base.content;
  const tooLarge = fileBytes(text) > SENTINEL_LIMITS.fileBytes;
  const save = async (revision: number | null) => {
    setError(""); setSavedAt(false);
    try {
      const file = await saveFile.mutateAsync({ id: sentinelId, path: base.path, content: text, revision });
      setBase({ path: file.path, revision: file.revision, content: file.content }); setConflict(null); setSavedAt(true);
    } catch (cause) {
      if (isConflict(cause)) {
        try { setConflict((await client.file(sentinelId, base.path)).file); } catch { setError("This file changed elsewhere and could not be reloaded."); }
      } else setError(cause instanceof Error ? cause.message : "Unable to save the file.");
    }
  };
  return <div className="flex min-w-0 flex-1 flex-col gap-3">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0"><h3 className="truncate text-sm font-medium">{base.path}</h3><p className="text-xs text-muted-foreground-1">{FILE_HINTS[base.path] ?? "Durable file available to every run."}</p></div>
      <div className="flex shrink-0 items-center gap-2">
        {base.revision !== null && <Badge variant="neutral">Revision {base.revision}</Badge>}
        <Button type="button" variant="ghost" size="sm" disabled={!dirty} onClick={() => { setText(base.content); setError(""); }}>Revert</Button>
        <Button type="button" variant="accent" size="sm" disabled={readOnly || !dirty || tooLarge || saveFile.isPending} onClick={() => void save(base.revision)}>{saveFile.isPending ? "Saving" : "Save"}</Button>
      </div>
    </div>
    {conflict && <div role="alert" className="space-y-2 rounded-(--radius-card) bg-amber-500/10 p-3 text-sm">
      <p>This file changed since you opened it (revision {conflict.revision} by {conflict.authorKind === "agent" ? "the Sentinel" : conflict.author}). Your edits are still here.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => { setBase({ path: conflict.path, revision: conflict.revision, content: conflict.content }); setText(conflict.content); setConflict(null); }}>Load latest and discard mine</Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => void save(conflict.revision)}>Overwrite with mine</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setConflict(null)}>Keep editing</Button>
      </div>
    </div>}
    <Textarea aria-label={`Edit ${base.path}`} value={text} readOnly={readOnly} spellCheck={false} rows={18} className="min-h-80 font-mono text-sm" onChange={event => { setText(event.target.value); setSavedAt(false); }} />
    <div className="flex items-center justify-between text-xs text-muted-foreground-1">
      <span className={cn(tooLarge && "text-destructive")}>{fileBytes(text).toLocaleString()} / {SENTINEL_LIMITS.fileBytes.toLocaleString()} bytes</span>
      <span role="status">{savedAt ? "Saved" : dirty ? "Unsaved changes" : ""}</span>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {revisions.length > 0 && <details className="rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] p-3 text-sm">
      <summary className="cursor-pointer font-medium">History ({revisions.length})</summary>
      <ul className="mt-2 divide-y-[0.5px] divide-border-1">
        {revisions.map(revision => <li key={revision.revision} className="flex items-center justify-between gap-3 py-1.5">
          <span className="min-w-0 truncate">Revision {revision.revision} by {revision.authorKind === "agent" ? "the Sentinel" : revision.author}<span className="ml-2 text-xs text-muted-foreground-1">{new Date(revision.createdAt).toLocaleString()}</span></span>
          <Button type="button" size="xs" variant="ghost" disabled={readOnly} onClick={() => setText(revision.content)}>Restore to editor</Button>
        </li>)}
      </ul>
    </details>}
  </div>;
}

function Loaded({ sentinelId, path, readOnly }: { sentinelId: string; path: string; readOnly: boolean }) {
  const query = useSentinelFile(sentinelId, path);
  if (query.isLoading) return <LoadingState label="Loading file" variant="detail" />;
  if (query.error || !query.data) return <p role="alert" className="text-sm text-destructive">{query.error instanceof Error ? query.error.message : "Unable to load the file."}</p>;
  const { file, revisions = [] } = query.data;
  return <Editor key={`${path}:${file.revision}`} sentinelId={sentinelId} initial={{ path, revision: file.revision, content: file.content }} revisions={revisions} readOnly={readOnly} />;
}

export function SentinelFiles({ sentinelId, readOnly = false }: { sentinelId: string; readOnly?: boolean }) {
  const files = useSentinelFiles(sentinelId);
  const [selected, setSelected] = useState<string>("AGENTS.md");
  const [fresh, setFresh] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const existing = files.data?.files.map(file => file.path) ?? [];
  const paths = [...new Set([...DEFAULT_FILES, ...existing])];
  const add = () => {
    const path = name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$/.test(path) || !/\.(md|txt|json)$/i.test(path) || path.includes("..")) { setNameError("Use a relative .md, .txt or .json path, up to four folders deep."); return; }
    if (paths.includes(path)) { setSelected(path); setFresh(null); setName(""); setNameError(""); return; }
    setSelected(path); setFresh(path); setName(""); setNameError("");
  };
  if (files.isLoading) return <LoadingState label="Loading files" variant="detail" />;
  if (files.error) return <p role="alert" className="text-sm text-destructive">{files.error instanceof Error ? files.error.message : "Unable to load files."}</p>;
  const isNew = fresh === selected && !existing.includes(selected);
  return <div className="flex flex-col gap-6 md:flex-row">
    <nav aria-label="Sentinel files" className="flex w-full shrink-0 flex-col gap-1 md:w-56">
      {[...paths, ...(fresh && !paths.includes(fresh) ? [fresh] : [])].map(path => <button key={path} type="button" aria-current={selected === path ? "true" : undefined} onClick={() => setSelected(path)} className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground-1 outline-none hover:bg-secondary hover:text-foreground focus-visible:outline-ring-inset aria-[current=true]:bg-secondary aria-[current=true]:text-foreground">
        <FileText className="size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 truncate">{path}</span>
      </button>)}
      {!readOnly && <form className="mt-2 space-y-1" onSubmit={event => { event.preventDefault(); add(); }}>
        <div className="flex gap-1"><Input aria-label="New file path" placeholder="reports/summary.md" value={name} onChange={event => { setName(event.target.value); setNameError(""); }} /><Button type="submit" variant="secondary" size="icon" aria-label="Add file"><Plus /></Button></div>
        {nameError && <p role="alert" className="text-xs text-destructive">{nameError}</p>}
      </form>}
    </nav>
    {isNew ? <Editor key={`new:${selected}`} sentinelId={sentinelId} initial={{ path: selected, revision: null, content: "" }} revisions={[]} readOnly={readOnly} />
      : <Loaded key={selected} sentinelId={sentinelId} path={selected} readOnly={readOnly} />}
  </div>;
}

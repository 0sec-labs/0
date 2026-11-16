import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CapyDatabaseIcon, CapyPlusIcon as Plus, CapySearchIcon as SearchIcon } from "@/ui/icons/capy";
import { queryKeys } from "@/queries";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { PageHeader } from "@/components/page-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ConfirmDialog, FormDialog } from "@/ui/components/confirm-dialog";
import { Cell, Tile } from "@/components/skills/cells";
import { MemoryMenu } from "@/components/memory-portability";
import { MemoryProposed } from "@/components/memory-proposed";
import { errorText } from "@/lib/api-error";
import { NOTE_KIND_LABELS, filterNotes, folderLabel, noteDetail, overflowNotice, type MemoryNote, type MemoryResponse, type NoteKind } from "@/memory-model";

type Draft = { id?: string; proposal?: boolean; text: string; scope: "global" | "folder"; folder: string; kind: NoteKind | "" };
const blank: Draft = { text: "", scope: "global", folder: "", kind: "" };

export function MemoryPage() {
  const { client, webFetchJson } = useBackendApi();
  const team = useTeamAccess();
  const cache = useQueryClient();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const key = queryKeys.consoleMemory(client.backendId);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => webFetchJson<MemoryResponse>("/api/console/memory", { signal }), refetchInterval: 10000 });
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [forgetting, setForgetting] = useState<MemoryNote | "all" | null>(null);
  const [error, setError] = useState("");
  const change = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => { setError(""); setDraft(null); setForgetting(null); return cache.invalidateQueries({ queryKey: key }); },
    onError: cause => setError(errorText(cause, "Couldn’t save this change.")),
  });
  if (query.isPending) return <><PageHeader title="Memory" /><LoadingState label="Loading memory…" /></>;
  if (query.error) return <><PageHeader title="Memory" /><ErrorState error={query.error} /></>;
  const { notes, folders, enabled, proposed = [], overflow = [] } = query.data;
  const notice = overflowNotice(overflow, filter);
  const shown = filterNotes(notes, filter, search);
  const accept = (id: string, text?: string) => change.mutate(() => webFetchJson(`/api/console/memory/${encodeURIComponent(id)}/accept`, { method: "POST", body: JSON.stringify(text === undefined ? {} : { text }) }));
  const save = () => { if (!draft) return; if (draft.proposal && draft.id) return accept(draft.id, draft.text); const body = JSON.stringify({ text: draft.text, scope: draft.scope, folder: draft.folder, kind: draft.kind || undefined });
    change.mutate(() => draft.id ? webFetchJson(`/api/console/memory/${encodeURIComponent(draft.id)}`, { method: "PATCH", body: JSON.stringify({ text: draft.text }) }) : webFetchJson("/api/console/memory", { method: "POST", body })); };
  const forget = () => { if (!forgetting) return; const target = forgetting; change.mutate(() => target === "all" ? webFetchJson("/api/console/memory/clear", { method: "POST", body: "{}" }) : webFetchJson(`/api/console/memory/${encodeURIComponent(target.id)}`, { method: "DELETE" })); };
  return <>
    <PageHeader title="Memory" summary={enabled ? "What 0 remembers across threads." : "Memory is off. New threads do not read these notes."} actions={<>
      <div className="relative w-55"><SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-(--icon-sm) -translate-y-1/2 text-muted-foreground-2" />
        <Input type="search" aria-label="Search memory" placeholder="Search" className="pl-9" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <MemoryMenu enabled={enabled} count={notes.length} readOnly={readOnly} onForgetAll={() => setForgetting("all")} onError={setError} />
      {!readOnly && <Button size="sm" variant="secondary" onClick={() => { setDraft(blank); setError(""); }}><Plus className="size-4" />Add</Button>}
    </>} />
    {folders.length > 0 && <div className="mt-4 flex items-center gap-2 text-sm"><label htmlFor="memory-folder" className="text-muted-foreground">Show</label>
      <select id="memory-folder" className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">All notes</option><option value="global">Everywhere</option>{folders.map(folder => <option key={folder} value={folder}>{folderLabel(folder)}</option>)}</select></div>}
    {error && !draft && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    <MemoryProposed notes={proposed} readOnly={readOnly} pending={change.isPending} onAccept={note => accept(note.id)}
      onEdit={note => { setDraft({ id: note.id, proposal: true, text: note.text, scope: note.scope, folder: note.folder ?? "", kind: note.kind ?? "" }); setError(""); }} onReject={note => change.mutate(() => webFetchJson(`/api/console/memory/${encodeURIComponent(note.id)}`, { method: "DELETE" }))} />
    {notice && <p role="status" className="mt-3 text-sm text-muted-foreground">{notice}</p>}
    {shown.length === 0 && proposed.length > 0 ? null : shown.length === 0 ? <EmptyState title={notes.length ? "No notes match." : "Nothing remembered yet."} illustration={<CapyDatabaseIcon className="size-6 text-muted-foreground" />} />
      : <ul className="mt-4 divide-y-[0.5px] divide-[var(--card-hairline)]">{shown.map(note => <Cell key={note.id} to="#" tile={<Tile icon={<CapyDatabaseIcon className="size-4" />} />} name={note.text} description={noteDetail(note)} interactive={!readOnly}
        onOpen={readOnly ? undefined : () => { setDraft({ id: note.id, text: note.text, scope: note.scope, folder: note.folder ?? "", kind: note.kind ?? "" }); setError(""); }}
        trailing={readOnly ? undefined : <Button variant="ghost" size="sm" onClick={() => setForgetting(note)}>Forget</Button>} />)}</ul>}
    <FormDialog open={draft !== null} onOpenChange={open => { if (!open) setDraft(null); }} title={draft?.proposal ? "Edit and accept" : draft?.id ? "Edit note" : "Add a note"} description="A short fact 0 should know in new threads." submitLabel={draft?.proposal ? "Accept" : draft?.id ? "Save" : "Remember"}
      submitDisabled={!draft?.text.trim() || (draft?.scope === "folder" && !draft.folder.trim())} pending={change.isPending} onSubmit={save} error={error ? <p role="alert" className="text-sm text-destructive">{error}</p> : undefined}>
      <Textarea aria-label="Note" rows={3} maxLength={500} autoFocus value={draft?.text ?? ""} onChange={event => setDraft(current => current && { ...current, text: event.target.value })} />
      {!draft?.id && <div className="flex flex-wrap items-center gap-2 text-sm">
        <select aria-label="Where" className="h-8 rounded-md border border-input bg-background px-2" value={draft?.scope} onChange={event => setDraft(current => current && { ...current, scope: event.target.value as Draft["scope"] })}><option value="global">Everywhere</option><option value="folder">One folder</option></select>
        {draft?.scope === "folder" && <Input aria-label="Folder path" placeholder="/path/to/folder" className="w-64" value={draft.folder} onChange={event => setDraft(current => current && { ...current, folder: event.target.value })} />}
        <select aria-label="Kind" className="h-8 rounded-md border border-input bg-background px-2" value={draft?.kind} onChange={event => setDraft(current => current && { ...current, kind: event.target.value as Draft["kind"] })}><option value="">No kind</option>{(Object.keys(NOTE_KIND_LABELS) as NoteKind[]).map(kind => <option key={kind} value={kind}>{NOTE_KIND_LABELS[kind]}</option>)}</select>
      </div>}
    </FormDialog>
    <ConfirmDialog open={forgetting !== null} onOpenChange={open => { if (!open) setForgetting(null); }} title={forgetting === "all" ? "Forget every note?" : "Forget this note?"} description={forgetting === "all" ? "0 will no longer remember any of these." : "0 will no longer remember it."}
      confirmLabel="Forget" destructive pending={change.isPending} onConfirm={forget} />
  </>;
}

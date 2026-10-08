import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Plus, Save } from "lucide-react";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReportExportControl } from "@/components/report-export-control";
import type { EngagementRecord, EngagementReport } from "@/lib/engagements";
import type { ScanRecord } from "@/types";
import { useTeamAccess } from "@/components/team-access";

type EngagementDraft = Pick<EngagementRecord, "name" | "description" | "scanIds" | "notes"> & { expectedRevision: number };
const draftFor = (engagement: EngagementRecord): EngagementDraft => ({ name: engagement.name, description: engagement.description, notes: engagement.notes ?? "", scanIds: engagement.scanIds, expectedRevision: engagement.revision });
const draftChanged = (draft: EngagementDraft, engagement: EngagementRecord) => draft.name !== engagement.name || draft.description !== engagement.description || (draft.notes ?? "") !== (engagement.notes ?? "") || JSON.stringify(draft.scanIds) !== JSON.stringify(engagement.scanIds);

// Keep unsaved drafts across in-app navigation for this browser session.
const sessionDrafts = new Map<string, EngagementDraft>();

export function EngagementsPage() {
  const { client, webFetchJson, getScans, listSavedConsoleSessions } = useBackendApi();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const draftScope = team.enabled && team.user ? `${client.backendId}:${JSON.stringify([team.user.workspaceId, team.user.userId])}` : client.backendId;
  const cache = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get("engagement");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, EngagementDraft>>(() => Object.fromEntries(sessionDrafts));
  useEffect(() => { sessionDrafts.clear(); for (const [id, draft] of Object.entries(drafts)) sessionDrafts.set(id, draft); }, [drafts]);
  const key = ["engagements", client.backendId];
  const collection = useQuery({ queryKey: key, queryFn: ({ signal }) => webFetchJson<{ engagements: EngagementRecord[] }>("/api/engagements", { signal }), refetchInterval: team.enabled ? 3000 : false });
  const scans = useQuery({ queryKey: ["engagement-runs", client.backendId], queryFn: getScans, refetchInterval: 5000 });
  const chats = useQuery({ queryKey: ["engagement-chat-titles", client.backendId], queryFn: ({ signal }) => listSavedConsoleSessions(signal) });
  const runNames = new Map(chats.data?.map(item => [item.id, item.summary || item.preview || "Chat investigation"]));
  const selected = collection.data?.engagements.find(item => item.id === selectedId);
  const draftKey = selected ? `${draftScope}:${selected.id}` : "";
  const unsaved = collection.data?.engagements.some(item => { const draft = drafts[`${draftScope}:${item.id}`]; return draft && draftChanged(draft, item); }) ?? false;
  useEffect(() => {
    if (!unsaved) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [unsaved]);
  const report = useQuery({ queryKey: ["engagement-report", client.backendId, selectedId], enabled: Boolean(selected), queryFn: ({ signal }) => webFetchJson<EngagementReport>(`/api/engagements/${encodeURIComponent(selectedId!)}/report`, { signal }), refetchInterval: 5000 });
  const select = (id: string, edit = false) => { if (busy) return; setError(""); setEditing(edit); setSearch({ engagement: id }); };
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update engagement."); } finally { setBusy(false); }
  };
  const save = (input: EngagementDraft) => perform(async () => {
    if (readOnly) return;
    const savedId = selected!.id;
    const savedDraftKey = `${draftScope}:${savedId}`;
    try { await webFetchJson(`/api/engagements/${encodeURIComponent(savedId)}`, { method: "PATCH", body: JSON.stringify(input) }); }
    catch (cause) { await cache.invalidateQueries({ queryKey: key }); throw cause; }
    await cache.invalidateQueries({ queryKey: key });
    await cache.invalidateQueries({ queryKey: ["engagement-report", client.backendId, savedId] });
    setDrafts(current => { const next = { ...current }; delete next[savedDraftKey]; return next; });
  });
  return <div className="space-y-6">
    <header className="space-y-2"><Link to="/findings" onClick={event => { if (busy || (unsaved && !window.confirm("Leave with unsaved changes? Your draft will stay in this session."))) event.preventDefault(); }} className="text-xs text-muted-foreground hover:underline">← Findings</Link><h1 className="flex items-center gap-2 text-2xl font-semibold"><FolderKanban className="size-5" />Assessment reports</h1></header>
    <form className="flex max-w-xl gap-2" onSubmit={event => { event.preventDefault(); void perform(async () => {
      const result = await webFetchJson<{ engagement: EngagementRecord }>("/api/engagements", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setName(""); await cache.invalidateQueries({ queryKey: key }); select(result.engagement.id, true);
    }); }}><Input aria-label="New assessment name" placeholder="Assessment name" value={name} maxLength={160} disabled={busy || readOnly} onChange={event => setName(event.target.value)} /><Button type="submit" disabled={busy || readOnly || !name.trim()}><Plus className="size-4" />Create report</Button></form>
    {(error || collection.error || scans.error) && <p role="alert" className="text-sm text-destructive">{error || (collection.error ?? scans.error)?.message}</p>}
    {collection.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading reports…</p> : <div className="grid items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      <nav aria-label="Assessment reports" className="space-y-1">{collection.data?.engagements.length ? collection.data.engagements.map(item => <button type="button" key={item.id} disabled={busy} aria-current={item.id === selectedId ? "page" : undefined} onClick={() => select(item.id)} className={`block w-full rounded-xl px-3 py-3 text-left hover:bg-muted/50 ${item.id === selectedId ? "bg-muted" : ""}`}><span className="block break-words text-sm font-medium">{item.name}</span><span className="mt-1 block text-xs text-muted-foreground">{item.scanIds.length} {item.scanIds.length === 1 ? "run" : "runs"}</span></button>) : <p className="py-3 text-sm text-muted-foreground">No reports yet.</p>}</nav>
      {selected ? <div className="min-w-0 space-y-6">
        {editing && drafts[draftKey] && drafts[draftKey].expectedRevision !== selected.revision && <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 text-xs"><span>Report changed. Your draft is kept.</span><Button variant="outline" size="xs" disabled={busy} onClick={() => { setDrafts(current => { const next = { ...current }; delete next[draftKey]; return next; }); setError(""); }}>Reload latest</Button></div>}
        {editing && <EngagementEditor key={`${draftScope}:${selected.id}`} engagement={selected} draft={drafts[draftKey] ?? draftFor(selected)} onDraft={draft => setDrafts(current => ({ ...current, [draftKey]: draft }))} scans={scans.data ?? []} report={report.data} runNames={runNames} busy={busy || readOnly} onSave={save} />}
        <section aria-label="Engagement report" className="space-y-4 rounded-2xl border border-border p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">{selected.name}</h2><div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" disabled={busy || readOnly} onClick={() => setEditing(!editing)}>{editing ? "Close editor" : "Edit"}</Button><ReportExportControl path={`/api/engagements/${encodeURIComponent(selected.id)}/report`} allowedFormats={["json", "markdown"]} disabled={busy || !report.data || Boolean(drafts[draftKey] && draftChanged(drafts[draftKey], selected))} /></div></div>
          {report.error ? <p role="alert" className="text-sm text-destructive">{report.error.message}</p> : report.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading report…</p> : report.data && <>
            {report.data.findingGroups.length ? <ul className="divide-y divide-border">{report.data.findingGroups.map(group => {
              const first = group.occurrences[0]!;
              return <li key={group.key} className="space-y-1 py-3"><Link to={group.fingerprint ? `/findings/${encodeURIComponent(group.fingerprint)}` : `/runs/${encodeURIComponent(first.scanId)}`} className="text-sm font-medium hover:underline">{first.finding.title}</Link><p className="text-xs text-muted-foreground">{first.finding.severity} · {group.reviewStatus} · {group.occurrences.length} occurrences</p><div className="flex flex-wrap gap-x-3 gap-y-1">{[...new Set(group.occurrences.map(item => item.scanId))].map(id => <Link key={id} to={`/runs/${encodeURIComponent(id)}`} className="text-xs text-muted-foreground hover:underline">Source run: {id}</Link>)}</div></li>;
            })}</ul> : <p className="text-sm text-muted-foreground">No findings yet.</p>}
            <details className="space-y-2 text-sm text-muted-foreground"><summary className="cursor-pointer text-xs">Details</summary>
              <div className="space-y-3 pt-2">
                {selected.description && <p className="whitespace-pre-wrap">{selected.description}</p>}
                {selected.notes && <p className="whitespace-pre-wrap">{selected.notes}</p>}
                <p className="text-xs">{report.data.summary.scanCount} included {report.data.summary.scanCount === 1 ? "run" : "runs"} · {report.data.summary.findingCount} finding occurrences</p>
                {report.data.scans.map(scan => <div key={scan.id} className="space-y-1 text-xs"><Link to={`/runs/${encodeURIComponent(scan.id)}`} className="hover:underline">{runNames.get(scan.id) || scan.target || "Run"}</Link><span> · {scan.status}</span>{scan.error && <p className="text-destructive">{scan.error}</p>}{(scan.warnings ?? []).map((warning, index) => <p key={index}>{warning.message}</p>)}</div>)}
              </div>
            </details>
          </>}
        </section>
      </div> : <p className="py-3 text-sm text-muted-foreground">Select a report.</p>}
    </div>}
  </div>;
}

function EngagementEditor({ engagement, draft, onDraft, scans, report, runNames, busy, onSave }: { engagement: EngagementRecord; draft: EngagementDraft; onDraft: (draft: EngagementDraft) => void; scans: ScanRecord[]; report?: EngagementReport; runNames: Map<string, string>; busy: boolean; onSave: (input: EngagementDraft) => Promise<void> }) {
  const { name, description, notes = "", scanIds: selected } = draft;
  const setSelected = (update: (ids: string[]) => string[]) => onDraft({ ...draft, scanIds: update(selected) });
  const [filter, setFilter] = useState("");
  const [runId, setRunId] = useState("");
  const candidates = new Map<string, { id: string; target: string; status: string }>();
  for (const scan of [...(report?.scans ?? []), ...scans]) candidates.set(scan.id, scan);
  for (const id of selected) if (!candidates.has(id)) candidates.set(id, { id, target: "Retained run", status: "" });
  const visible = [...candidates.values()].filter(scan => `${scan.id} ${scan.target} ${runNames.get(scan.id) ?? runNames.get(scan.id.replace(/^console-/, "")) ?? ""} ${scan.status}`.toLowerCase().includes(filter.toLowerCase()));
  const changed = draftChanged(draft, engagement);
  return <form aria-label="Engagement details" className="space-y-4" onSubmit={event => { event.preventDefault(); void onSave({ name, description, notes, scanIds: selected, expectedRevision: draft.expectedRevision }); }}>
    <fieldset disabled={busy} className="space-y-4">
    <label className="block space-y-2 text-sm"><span>Name</span><Input value={name} maxLength={160} required onChange={event => onDraft({ ...draft, name: event.target.value })} /></label>
    <label className="block space-y-2 text-sm"><span>Objective and scope</span><textarea value={description} maxLength={8000} rows={2} className="w-full rounded-xl border border-input bg-background px-3 py-2" onChange={event => onDraft({ ...draft, description: event.target.value })} placeholder="What are we assessing, and what is included?" /></label>
    <label className="block space-y-2 text-sm"><span>Handoff notes</span><textarea value={notes} maxLength={16000} rows={3} className="w-full rounded-xl border border-input bg-background px-3 py-2" onChange={event => onDraft({ ...draft, notes: event.target.value })} placeholder="Evidence reviewed, open questions, and next steps for the team." /></label>
    <fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">Included runs ({selected.length})</legend><Input aria-label="Search engagement runs" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search runs by name or target…" />
      <div className="max-h-60 space-y-1 overflow-y-auto rounded-xl border border-border p-2">{visible.length ? visible.map(scan => <label key={scan.id} className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-muted/40"><input type="checkbox" checked={selected.includes(scan.id)} disabled={busy || (!selected.includes(scan.id) && selected.length >= 100)} onChange={event => setSelected(ids => event.target.checked ? [...ids, scan.id] : ids.filter(id => id !== scan.id))} className="mt-1" /><span className="min-w-0"><span className="block break-words text-sm">{scan.target || runNames.get(scan.id) || runNames.get(scan.id.replace(/^console-/, "")) || "Chat investigation"}</span><span className="block text-xs text-muted-foreground">{scan.status || "Retained run"} · {scan.id.replace(/^console-/, "").slice(0, 8)}</span></span></label>) : <p className="p-2 text-sm text-muted-foreground">{filter ? "No matching runs." : "No retained runs yet. Start a chat or workflow to collect evidence."}</p>}</div>
      <details><summary className="cursor-pointer text-xs text-muted-foreground">Add a run by ID</summary><div className="mt-2 flex gap-2"><Input aria-label="Add retained run ID" value={runId} onChange={event => setRunId(event.target.value)} placeholder="Add an older run by ID" maxLength={160} /><Button type="button" variant="outline" disabled={busy || !runId.trim() || selected.length >= 100} onClick={() => { const id = runId.trim(); setSelected(ids => ids.includes(id) ? ids : [...ids, id]); setRunId(""); }}>Add run</Button></div></details>
    </fieldset>
    </fieldset>
    <Button type="submit" disabled={busy || !name.trim() || !changed}><Save className="size-4" />{busy ? "Saving…" : "Save report"}</Button>
  </form>;
}

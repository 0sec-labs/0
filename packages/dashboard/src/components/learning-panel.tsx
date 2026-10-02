import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, CheckCheck, ChevronDown, History, RotateCcw } from "lucide-react";
import { useBackendApi } from "@/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface LearningEvent { id: string; createdAt: string; title?: string; kind: string; workflowId?: string; workflowRevision?: number; evidenceRefs?: string[]; runId?: string; executionId?: string; projectId?: string; target?: string; outcome?: string; evidenceStrength?: string; summary?: string; }
export interface LearningKnowledge { id: string; title?: string; content?: string; summary: string; projectId: string; sourceLinks: { path: string; hash: string }[]; evidenceEventIds: string[]; scope?: string; target?: string; status: string; sourceEventIds?: string[]; updatedAt: string; lastUsedAt?: string; useCount?: number; }
export interface LearningImprovement { id: string; title?: string; kind: string; status: string; projectId: string; targetId: string; baseVersion: string; proposal: unknown; evidenceEventIds: string[]; revision: number; evaluations: unknown[]; registry?: unknown; workflowId?: string; summary?: string; createdAt: string; sourceEventIds?: string[]; }
export interface LearningResponse { worker?: { configuredEvaluation?: boolean }; events: LearningEvent[]; knowledge: LearningKnowledge[]; improvements: LearningImprovement[]; }
const labels: Record<string, string> = { applied: "Applied", "workflow-restore": "Workflow instructions", current: "Up to date", stale: "Out of date", disabled: "Not in use", proposed: "Suggested", evaluating: "Testing", validated: "Tests passed", rejected: "Dismissed", active: "In use", retired: "No longer used", canary: "Trial", completed: "Completed", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", inconclusive: "Unclear", operational: "Run record", hypothesis: "Not verified", verified: "Verified", "human-feedback": "Your feedback" };
export function learningLabel(value: string) { return labels[value] ?? value.replaceAll(/[_-]/g, " "); }
function eventTitle(event: LearningEvent): string {
  if (event.title) return event.title;
  const subject = event.kind === "chat-turn" ? "Chat" : event.kind === "workflow-step" ? "Workflow step" : event.kind === "workflow-run" ? "Workflow" : null;
  if (subject) return `${subject} ${event.outcome === "completed" ? "finished" : event.outcome === "cancelled" ? "was stopped" : event.outcome === "failed" ? "failed" : "ended"}`;
  if (event.kind === "source-context" || event.kind === "codebase-note") return "Code references saved";
  return event.summary ?? learningLabel(event.kind);
}
export function LearningStatus({ value }: { value: string }) { return <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{learningLabel(value)}</span>; }
function Time({ value }: { value: string }) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : <time dateTime={value} className="text-xs text-muted-foreground">{date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>; }

interface RestoreSuggestion { workflowId: string; fromRevision: number; restoreRevision: number; failedRuns: number; summary: string; }
function restoreSuggestion(candidate: LearningImprovement | null): RestoreSuggestion | null {
  if (!candidate || candidate.kind !== "workflow-restore" || typeof candidate.proposal !== "string") return null;
  try {
    const value = JSON.parse(candidate.proposal);
    return value.action === "restore-workflow-instructions" && typeof value.workflowId === "string" && Number.isSafeInteger(value.fromRevision) && Number.isSafeInteger(value.restoreRevision) ? value : null;
  } catch { return null; }
}
function versionInstructions(version?: WorkflowVersion): string {
  if (!version) return "Version unavailable";
  return [version.definition.name, version.definition.instructions, ...version.definition.nodes.flatMap(node => {
    if (!node || typeof node !== "object") return [];
    const item = node as { label?: string; execution?: { instructions?: string } };
    return item.execution?.instructions ? [`${item.label ?? "Step"}\n${item.execution.instructions}`] : [];
  })].filter(Boolean).join("\n\n");
}
function improvementSummary(candidate: LearningImprovement) { if (candidate.kind === "workflow-restore" && candidate.status === "applied") return "Earlier instructions saved as a new workflow version."; return restoreSuggestion(candidate)?.summary ?? candidate.summary ?? (typeof candidate.proposal === "string" ? candidate.proposal : "Review the change and its test results before using it."); }
export function LearningPanel({ workflowId }: { workflowId?: string }) {
  const { client, webFetchJson } = useBackendApi();
  const cache = useQueryClient();
  const key = ["console-learning", client.backendId, workflowId ?? "all"];
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => webFetchJson<LearningResponse>(`/api/console/learning${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`, { signal }), refetchInterval: 10000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState<LearningImprovement | null>(null);
  const suggestion = restoreSuggestion(reviewing);
  const versions = useQuery({ queryKey: ["suggestion-versions", client.backendId, reviewing?.id], enabled: !!suggestion, queryFn: ({ signal }) => webFetchJson<{ versions: WorkflowVersion[] }>(`/api/console/workflow-definitions/${encodeURIComponent(suggestion!.workflowId)}/versions`, { signal }) });
  const apply = async () => {
    if (!reviewing || !suggestion) return;
    setBusy(reviewing.id); setError("");
    try {
      await webFetchJson(`/api/console/learning/improvements/${encodeURIComponent(reviewing.id)}/apply`, { method: "POST", body: JSON.stringify({ revision: reviewing.revision, workflowRevision: suggestion.fromRevision }) });
      await Promise.all([cache.invalidateQueries({ queryKey: ["console-learning", client.backendId] }), cache.invalidateQueries({ queryKey: ["workflow-definitions"] }), cache.invalidateQueries({ queryKey: ["workflow-versions", client.backendId] })]);
      setReviewing(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to apply this suggestion."); }
    finally { setBusy(null); }
  };
  const change = async (entry: LearningKnowledge) => {
    setBusy(entry.id); setError("");
    try { await webFetchJson(`/api/console/learning/knowledge/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }); await cache.invalidateQueries({ queryKey: ["console-learning", client.backendId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update this note."); }
    finally { setBusy(null); }
  };
  const reject = async (candidate: LearningImprovement) => {
    setBusy(candidate.id); setError("");
    try { await webFetchJson(`/api/console/learning/improvements/${encodeURIComponent(candidate.id)}/reject`, { method: "POST", body: JSON.stringify({ revision: candidate.revision }) }); await cache.invalidateQueries({ queryKey: ["console-learning", client.backendId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to dismiss this suggestion."); }
    finally { setBusy(null); }
  };
  const evaluate = async (candidate: LearningImprovement) => {
    setBusy(candidate.id); setError("");
    try { await webFetchJson(`/api/console/learning/improvements/${encodeURIComponent(candidate.id)}/evaluate`, { method: "POST", body: JSON.stringify({ revision: candidate.revision }) }); await cache.invalidateQueries({ queryKey: ["console-learning", client.backendId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to test this suggestion."); }
    finally { setBusy(null); }
  };
  if (query.isPending) return <LoadingState label="Loading learning activity…" />;
  if (query.error) return <ErrorState error={query.error} />;
  const data = query.data;
  const events = data.events.filter(item => !workflowId || item.workflowId === workflowId);
  const improvements = data.improvements.filter(item => !workflowId || (item.workflowId === workflowId || item.targetId === workflowId));
  return <div className="space-y-4">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Tabs defaultValue="activity" className="gap-5">
      <TabsList aria-label="Learning views"><TabsTrigger value="activity">Activity</TabsTrigger><TabsTrigger value="knowledge">Notes</TabsTrigger><TabsTrigger value="improvements">Suggestions</TabsTrigger></TabsList>
      <TabsContent value="activity">
        {!events.length ? <EmptyState title="No activity yet" body="Your chats and workflow runs will appear here." illustration={<History className="size-7 text-muted-foreground" />} /> : <div className="divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/50">{events.map(event => <details key={event.id} className="group"><summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30 [&::-webkit-details-marker]:hidden"><span className="min-w-0 flex-1 text-sm font-medium">{eventTitle(event)}</span>{event.outcome && !(["chat-turn", "workflow-step", "workflow-run"].includes(event.kind) && ["completed", "failed", "cancelled"].includes(event.outcome)) && <LearningStatus value={event.outcome} />}<Time value={event.createdAt} /><ChevronDown aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" /></summary><div className="space-y-2 px-4 pb-4 text-sm text-muted-foreground">{event.summary && event.summary !== eventTitle(event) && <p className="whitespace-pre-wrap">{event.summary}</p>}{event.target && <p className="break-all">{event.target}</p>}{event.evidenceStrength && <p>{learningLabel(event.evidenceStrength)}</p>}{event.workflowRevision && <p className="text-xs">Workflow version {event.workflowRevision}</p>}{event.evidenceRefs?.length ? <p className="break-all text-xs">Evidence · {event.evidenceRefs.join(", ")}</p> : null}{(event.executionId ?? event.runId) && <p className="break-all text-xs">Run {event.executionId ?? event.runId}</p>}<p className="break-all text-xs">Event {event.id}</p></div></details>)}</div>}
      </TabsContent>
      <TabsContent value="knowledge">
        {!data.knowledge.length ? <EmptyState title="No notes yet" body="Notes from code reviews stay with their project." illustration={<BookOpen className="size-7 text-muted-foreground" />} /> : <div className="space-y-3">{data.knowledge.map(entry => <article key={entry.id} className="space-y-3 rounded-2xl bg-muted/25 p-5"><div className="flex flex-wrap items-center gap-3"><h3 className="min-w-0 flex-1 text-sm font-medium">{entry.title ?? "Code review note"}</h3><LearningStatus value={entry.status} /><Button variant="ghost" size="sm" disabled={busy !== null || entry.status !== "current"} onClick={() => void change(entry)}>{busy === entry.id ? "Saving…" : entry.status === "disabled" ? "Not in use" : entry.status !== "current" ? "Needs a new review" : "Stop using"}</Button></div><p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{entry.content ?? entry.summary}</p><div className="flex flex-wrap gap-3 text-xs text-muted-foreground">{(entry.target ?? entry.scope ?? entry.projectId) && <span className="break-all">{entry.target ?? entry.scope ?? entry.projectId}</span>}{entry.useCount !== undefined && <span>Used {entry.useCount} times</span>}<span>{entry.evidenceEventIds.length} supporting records</span><Time value={entry.updatedAt} /></div><details><summary className="cursor-pointer text-xs text-muted-foreground">Sources</summary><ul className="mt-2 space-y-1 text-xs text-muted-foreground">{entry.sourceLinks.map(source => <li key={`${source.path}:${source.hash}`} className="break-all">{source.path} · {source.hash.slice(0, 12)}</li>)}</ul><p className="mt-2 break-all text-xs text-muted-foreground">{entry.evidenceEventIds.join(", ")}</p></details></article>)}</div>}
      </TabsContent>
      <TabsContent value="improvements">
        {!improvements.length ? <EmptyState title="No suggestions yet" body="Changes will appear here for you to review." illustration={<CheckCheck className="size-7 text-muted-foreground" />} /> : <div className="space-y-3">{improvements.map(candidate => <article key={candidate.id} className="space-y-3 rounded-2xl bg-muted/25 p-5"><div className="flex flex-wrap items-center gap-3"><h3 className="min-w-0 flex-1 text-sm font-medium">{candidate.title ?? learningLabel(candidate.kind)}</h3><LearningStatus value={candidate.status} />{!candidate.registry && candidate.kind === "workflow-restore" && candidate.status === "proposed" && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setError(""); setReviewing(candidate); }}>Review change</Button>}{!candidate.registry && candidate.kind !== "workflow-restore" && candidate.status === "proposed" && data.worker?.configuredEvaluation && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void evaluate(candidate)}>Run tests</Button>}{!candidate.registry && ["proposed", "validated"].includes(candidate.status) && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void reject(candidate)}>{busy === candidate.id ? "Saving…" : "Dismiss"}</Button>}</div><p className="text-sm text-muted-foreground">{improvementSummary(candidate)}</p><div className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>{candidate.evidenceEventIds.length} supporting records</span>{candidate.kind !== "workflow-restore" && <span>{candidate.evaluations.length} test results</span>}<Time value={candidate.createdAt} /></div><details><summary className="cursor-pointer text-xs text-muted-foreground">Change details</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-background/40 p-3 text-xs text-muted-foreground">{JSON.stringify({ baseVersion: candidate.baseVersion, evidenceEventIds: candidate.evidenceEventIds, proposal: candidate.proposal, evaluations: candidate.evaluations }, null, 2)}</pre></details>{(candidate.workflowId ?? restoreSuggestion(candidate)?.workflowId) && <Button variant="ghost" size="sm" asChild><Link to={`/workflows?workflow=${encodeURIComponent(candidate.workflowId ?? restoreSuggestion(candidate)!.workflowId)}`}>View workflow</Link></Button>}</article>)}</div>}
      </TabsContent>
    </Tabs>
    <Dialog open={!!reviewing} onOpenChange={open => { if (!open && !busy) { setReviewing(null); setError(""); } }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" showCloseButton={!busy}>
        <DialogHeader><DialogTitle>Review workflow change</DialogTitle><DialogDescription>{suggestion?.summary}</DialogDescription></DialogHeader>
        <p className="text-sm text-muted-foreground">This saves a new version for future runs. The target, tools and limits stay the same. Review scheduled runs after saving.</p>
        {versions.isPending ? <p className="text-sm text-muted-foreground">Loading instructions…</p> : versions.error ? <p role="alert" className="text-sm text-destructive">Unable to load the change.</p> : <div className="grid gap-4 sm:grid-cols-2">{[{ revision: suggestion?.fromRevision, label: "Current instructions" }, { revision: suggestion?.restoreRevision, label: "Suggested instructions" }].map(({ revision, label }) => <section key={label} className="space-y-2"><h3 className="text-sm font-medium">{label}</h3><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/30 p-3 font-sans text-sm leading-6">{versionInstructions(versions.data?.versions.find(v => v.revision === revision))}</pre></section>)}</div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="ghost" disabled={busy !== null} onClick={() => { setReviewing(null); setError(""); }}>Cancel</Button><Button disabled={busy !== null || !suggestion || !versions.data?.versions.some(v => v.revision === suggestion.fromRevision) || !versions.data?.versions.some(v => v.revision === suggestion.restoreRevision)} onClick={() => void apply()}>{busy ? "Saving…" : "Save new version"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

interface WorkflowVersion { parentRevision: number | null; restoredFromRevision: number | null; digest: string; revision: number; createdAt: string; reason?: string; definition: { name: string; target: string; description?: string; instructions?: string; nodes: unknown[] }; }
export function WorkflowVersions({ workflowId, revision, onRestore }: { workflowId: string; revision: number; onRestore: (revision: number) => Promise<void> }) {
  const { client, webFetchJson } = useBackendApi();
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["workflow-versions", client.backendId, workflowId, revision], queryFn: ({ signal }) => webFetchJson<{ versions: WorkflowVersion[] }>(`/api/console/workflow-definitions/${encodeURIComponent(workflowId)}/versions`, { signal }) });
  if (query.isPending) return <LoadingState label="Loading versions…" />;
  if (query.error) return <ErrorState error={query.error} />;
  return <div className="space-y-3">{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{!query.data.versions.length ? <EmptyState title="No version history yet" /> : query.data.versions.map(version => <details key={version.revision} className="rounded-2xl bg-muted/25 p-4"><summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm"><span className="flex-1 font-medium">Version {version.revision}</span>{version.revision === revision && <LearningStatus value="current" />}<Time value={version.createdAt} /></summary><div className="mt-4 space-y-3"><p className="text-sm text-muted-foreground">{version.restoredFromRevision !== null ? `Restored from version ${version.restoredFromRevision}` : version.reason ?? version.definition.name}</p><p className="break-all text-xs text-muted-foreground">Content fingerprint {version.digest}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-background/40 p-3 text-xs text-muted-foreground">{JSON.stringify(version.definition, null, 2)}</pre>{version.revision !== revision && <Button variant="ghost" size="sm" disabled={restoring !== null} onClick={() => { setRestoring(version.revision); setError(""); void onRestore(version.revision).catch(cause => setError(cause instanceof Error ? cause.message : "Unable to restore this version.")).finally(() => setRestoring(null)); }}><RotateCcw className="size-4" />{restoring === version.revision ? "Restoring…" : "Restore this version"}</Button>}</div></details>)}</div>;
}

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, CheckCheck, History, RotateCcw } from "lucide-react";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface LearningEvent { id: string; createdAt: string; title?: string; kind: string; workflowId?: string; workflowRevision?: number; evidenceRefs?: string[]; runId?: string; executionId?: string; projectId?: string; target?: string; outcome?: string; evidenceStrength?: string; summary?: string; }
export interface LearningKnowledge { id: string; title?: string; content?: string; summary: string; projectId: string; sourceLinks: { path: string; hash: string }[]; evidenceEventIds: string[]; scope?: string; target?: string; status: string; sourceEventIds?: string[]; updatedAt: string; lastUsedAt?: string; useCount?: number; }
export interface LearningImprovement { id: string; title?: string; kind: string; status: string; projectId: string; targetId: string; baseVersion: string; proposal: unknown; evidenceEventIds: string[]; revision: number; evaluations: unknown[]; registry?: unknown; workflowId?: string; summary?: string; createdAt: string; sourceEventIds?: string[]; }
export interface LearningResponse { worker?: { configuredEvaluation?: boolean }; events: LearningEvent[]; knowledge: LearningKnowledge[]; improvements: LearningImprovement[]; }
export function learningLabel(value: string) { return value.replaceAll(/[_-]/g, " "); }
export function LearningStatus({ value }: { value: string }) { return <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{learningLabel(value)}</span>; }
function Time({ value }: { value: string }) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : <time dateTime={value} className="text-xs text-muted-foreground">{date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>; }

export function LearningPanel({ workflowId }: { workflowId?: string }) {
  const { client, webFetchJson } = useBackendApi();
  const cache = useQueryClient();
  const key = ["console-learning", client.backendId, workflowId ?? "all"];
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => webFetchJson<LearningResponse>(`/api/console/learning${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`, { signal }), refetchInterval: 10000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const change = async (entry: LearningKnowledge) => {
    setBusy(entry.id); setError("");
    try { await webFetchJson(`/api/console/learning/knowledge/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }); await cache.invalidateQueries({ queryKey: ["console-learning", client.backendId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update knowledge."); }
    finally { setBusy(null); }
  };
  const reject = async (candidate: LearningImprovement) => {
    setBusy(candidate.id); setError("");
    try { await webFetchJson(`/api/console/learning/improvements/${encodeURIComponent(candidate.id)}/reject`, { method: "POST", body: JSON.stringify({ revision: candidate.revision }) }); await cache.invalidateQueries({ queryKey: ["console-learning", client.backendId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to reject the candidate."); }
    finally { setBusy(null); }
  };
  const evaluate = async (candidate: LearningImprovement) => {
    setBusy(candidate.id); setError("");
    try { await webFetchJson(`/api/console/learning/improvements/${encodeURIComponent(candidate.id)}/evaluate`, { method: "POST", body: JSON.stringify({ revision: candidate.revision }) }); await cache.invalidateQueries({ queryKey: ["console-learning", client.backendId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to evaluate the candidate."); }
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
      <TabsList aria-label="Learning views"><TabsTrigger value="activity">Activity</TabsTrigger><TabsTrigger value="knowledge">Knowledge</TabsTrigger><TabsTrigger value="improvements">Improvements</TabsTrigger></TabsList>
      <TabsContent value="activity">
        {!events.length ? <EmptyState title="No learning activity yet" body="Completed workflows and verification outcomes will appear here." illustration={<History className="size-7 text-muted-foreground" />} /> : <div className="divide-y divide-border/50 rounded-2xl bg-muted/20 px-5">{events.map(event => <details key={event.id} className="py-4"><summary className="flex cursor-pointer flex-wrap items-center gap-3"><span className="min-w-0 flex-1 text-sm font-medium">{event.title ?? event.summary ?? learningLabel(event.kind)}</span>{event.outcome && <LearningStatus value={event.outcome} />}<Time value={event.createdAt} /></summary><div className="mt-3 space-y-2 text-sm text-muted-foreground">{event.summary && <p className="whitespace-pre-wrap">{event.summary}</p>}{event.target && <p className="break-all">{event.target}</p>}{event.evidenceStrength && <p>Evidence · {learningLabel(event.evidenceStrength)}</p>}{event.workflowRevision && <p className="text-xs">Workflow revision {event.workflowRevision}</p>}{event.evidenceRefs?.length ? <p className="break-all text-xs">Evidence · {event.evidenceRefs.join(", ")}</p> : null}{(event.executionId ?? event.runId) && <p className="break-all text-xs">Run {event.executionId ?? event.runId}</p>}<p className="break-all text-xs">Event {event.id}</p></div></details>)}</div>}
      </TabsContent>
      <TabsContent value="knowledge">
        {!data.knowledge.length ? <EmptyState title="No retained knowledge yet" body="Source-linked notes remain scoped to their project and evidence." illustration={<BookOpen className="size-7 text-muted-foreground" />} /> : <div className="space-y-3">{data.knowledge.map(entry => <article key={entry.id} className="space-y-3 rounded-2xl bg-muted/25 p-5"><div className="flex flex-wrap items-center gap-3"><h3 className="min-w-0 flex-1 text-sm font-medium">{entry.title ?? "Retained context"}</h3><LearningStatus value={entry.status} /><Button variant="ghost" size="sm" disabled={busy !== null || entry.status !== "current"} onClick={() => void change(entry)}>{busy === entry.id ? "Saving…" : entry.status !== "current" ? "Needs fresh evidence" : "Disable"}</Button></div><p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{entry.content ?? entry.summary}</p><div className="flex flex-wrap gap-3 text-xs text-muted-foreground">{(entry.target ?? entry.scope ?? entry.projectId) && <span className="break-all">{entry.target ?? entry.scope ?? entry.projectId}</span>}{entry.useCount !== undefined && <span>Used {entry.useCount} times</span>}<span>{entry.evidenceEventIds.length} source events</span><Time value={entry.updatedAt} /></div><details><summary className="cursor-pointer text-xs text-muted-foreground">Sources</summary><ul className="mt-2 space-y-1 text-xs text-muted-foreground">{entry.sourceLinks.map(source => <li key={`${source.path}:${source.hash}`} className="break-all">{source.path} · {source.hash.slice(0, 12)}</li>)}</ul><p className="mt-2 break-all text-xs text-muted-foreground">{entry.evidenceEventIds.join(", ")}</p></details></article>)}</div>}
      </TabsContent>
      <TabsContent value="improvements">
        {!improvements.length ? <EmptyState title="No proposed improvements" body="Candidates appear here with supporting evidence before activation." illustration={<CheckCheck className="size-7 text-muted-foreground" />} /> : <div className="space-y-3">{improvements.map(candidate => <article key={candidate.id} className="space-y-3 rounded-2xl bg-muted/25 p-5"><div className="flex flex-wrap items-center gap-3"><h3 className="min-w-0 flex-1 text-sm font-medium">{candidate.title ?? candidate.summary ?? learningLabel(candidate.kind)}</h3><LearningStatus value={candidate.status} />{!candidate.registry && candidate.status === "proposed" && data.worker?.configuredEvaluation && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void evaluate(candidate)}>Evaluate</Button>}{!candidate.registry && ["proposed", "validated"].includes(candidate.status) && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void reject(candidate)}>{busy === candidate.id ? "Saving…" : "Reject"}</Button>}</div><p className="text-sm text-muted-foreground">{candidate.summary ?? (typeof candidate.proposal === "string" ? candidate.proposal : "Review candidate evidence and evaluation before activation.")}</p><div className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>{learningLabel(candidate.kind)}</span><span>{candidate.evidenceEventIds.length} source events</span><span>{candidate.evaluations.length} evaluations</span><Time value={candidate.createdAt} /></div><details><summary className="cursor-pointer text-xs text-muted-foreground">Evidence and proposal</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-background/40 p-3 text-xs text-muted-foreground">{JSON.stringify({ baseVersion: candidate.baseVersion, evidenceEventIds: candidate.evidenceEventIds, proposal: candidate.proposal, evaluations: candidate.evaluations }, null, 2)}</pre></details>{candidate.workflowId && <Button variant="ghost" size="sm" asChild><Link to={`/workflows?workflow=${encodeURIComponent(candidate.workflowId)}`}>View workflow</Link></Button>}</article>)}</div>}
      </TabsContent>
    </Tabs>
  </div>;
}

interface WorkflowVersion { parentRevision: number | null; restoredFromRevision: number | null; digest: string; revision: number; createdAt: string; reason?: string; definition: { name: string; target: string; description?: string; nodes: unknown[] }; }
export function WorkflowVersions({ workflowId, revision, onRestore }: { workflowId: string; revision: number; onRestore: (revision: number) => Promise<void> }) {
  const { client, webFetchJson } = useBackendApi();
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["workflow-versions", client.backendId, workflowId, revision], queryFn: ({ signal }) => webFetchJson<{ versions: WorkflowVersion[] }>(`/api/console/workflow-definitions/${encodeURIComponent(workflowId)}/versions`, { signal }) });
  if (query.isPending) return <LoadingState label="Loading versions…" />;
  if (query.error) return <ErrorState error={query.error} />;
  return <div className="space-y-3">{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{!query.data.versions.length ? <EmptyState title="No version history yet" /> : query.data.versions.map(version => <details key={version.revision} className="rounded-2xl bg-muted/25 p-4"><summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm"><span className="flex-1 font-medium">Revision {version.revision}</span>{version.revision === revision && <LearningStatus value="current" />}<Time value={version.createdAt} /></summary><div className="mt-4 space-y-3"><p className="text-sm text-muted-foreground">{version.restoredFromRevision !== null ? `Restored from revision ${version.restoredFromRevision}` : version.reason ?? version.definition.name}</p><p className="break-all text-xs text-muted-foreground">Digest {version.digest}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-background/40 p-3 text-xs text-muted-foreground">{JSON.stringify(version.definition, null, 2)}</pre>{version.revision !== revision && <Button variant="ghost" size="sm" disabled={restoring !== null} onClick={() => { setRestoring(version.revision); setError(""); void onRestore(version.revision).catch(cause => setError(cause instanceof Error ? cause.message : "Unable to restore revision.")).finally(() => setRestoring(null)); }}><RotateCcw className="size-4" />{restoring === version.revision ? "Restoring…" : "Restore as new revision"}</Button>}</div></details>)}</div>;
}

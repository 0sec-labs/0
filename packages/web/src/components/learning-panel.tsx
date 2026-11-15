import { queryKeys } from "@/queries";
import { Disclosure } from "@/components/ui/disclosure";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, BookOpen, MoreHorizontal, RotateCcw } from "lucide-react";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { errorText } from "@/lib/api-error";

export interface LearningEvent { id: string; createdAt: string; title?: string; kind: string; workflowId?: string; workflowRevision?: number; evidenceRefs?: string[]; runId?: string; executionId?: string; projectId?: string; target?: string; outcome?: string; evidenceStrength?: string; summary?: string; }
export interface LearningKnowledge { id: string; title?: string; content?: string; summary: string; projectId: string; sourceLinks: { path: string; hash: string }[]; evidenceEventIds: string[]; scope?: string; target?: string; status: string; sourceEventIds?: string[]; updatedAt: string; lastUsedAt?: string; useCount?: number; }
export interface LearningResponse { events: LearningEvent[]; knowledge: LearningKnowledge[]; }
const labels: Record<string, string> = { current: "Up to date", stale: "Out of date", disabled: "Not in use" };
export function learningLabel(value: string) { return labels[value] ?? value.replaceAll(/[_-]/g, " "); }
export function LearningStatus({ value }: { value: string }) { return <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{learningLabel(value)}</span>; }
function Time({ value }: { value: string }) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : <time dateTime={value} className="text-xs text-muted-foreground">{date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>; }

export function LearningPanel() {
  const { client, webFetchJson } = useBackendApi();
  const cache = useQueryClient();
  const key = queryKeys.consoleLearning(client.backendId, "all");
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => webFetchJson<LearningResponse>("/api/console/learning", { signal }), refetchInterval: 10000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const change = async (entry: LearningKnowledge) => {
    setBusy(entry.id); setError("");
    try { await webFetchJson(`/api/console/learning/knowledge/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }); await cache.invalidateQueries({ queryKey: queryKeys.consoleLearning(client.backendId) }); }
    catch (cause) { setError(errorText(cause, "Unable to update this note.")); }
    finally { setBusy(null); }
  };
  if (query.isPending) return <LoadingState label="Loading memory…" />;
  if (query.error) return <ErrorState error={query.error} />;
  const data = query.data;
  return <div className="space-y-4">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!data.knowledge.length ? <EmptyState title="Nothing saved yet" illustration={<BookOpen className="size-6 text-muted-foreground" />} /> : <div className="divide-y-[0.5px] divide-[var(--card-hairline)] overflow-hidden rounded-[var(--radius-panel,16px)] border-[0.5px] border-[var(--card-hairline)] bg-card">{data.knowledge.map(entry => <article key={entry.id} className="space-y-1.5 px-4 py-3"><div className="flex min-h-8 items-center gap-3"><h3 className="min-w-0 flex-1 truncate text-sm font-medium">{entry.title ?? "Saved memory"}</h3><LearningStatus value={entry.status} /><DropdownMenu><DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="Memory actions" disabled={busy !== null || entry.status !== "current"} />}><MoreHorizontal /></DropdownMenu.Trigger><DropdownMenu.Content align="end" className="w-44"><DropdownMenu.Item icon={<Ban />} onClick={() => void change(entry)}>Stop using</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu></div><p className="line-clamp-2 break-words text-sm text-muted-foreground">{entry.content ?? entry.summary}</p><p className="text-xs text-muted-foreground">{entry.sourceLinks.length} cited {entry.sourceLinks.length === 1 ? "file" : "files"}{entry.useCount ? ` · used ${entry.useCount} ${entry.useCount === 1 ? "time" : "times"}` : ""} · <Time value={entry.updatedAt} /></p><Disclosure summary={<>Supporting files ({entry.sourceLinks.length})</>} triggerClassName="cursor-pointer text-xs text-muted-foreground">{entry.sourceLinks.length ? <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{entry.sourceLinks.map(source => <li key={`${source.path}:${source.hash}`} className="break-all">{source.path} · {source.hash.slice(0, 12)}</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No supporting files recorded.</p>}</Disclosure></article>)}</div>}
  </div>;
}

interface WorkflowVersion { parentRevision: number | null; restoredFromRevision: number | null; digest: string; revision: number; createdAt: string; reason?: string; definition: { name: string; target: string; description?: string; instructions?: string; nodes: unknown[] }; }
export function WorkflowVersions({ workflowId, revision, onRestore, disabled = false }: { workflowId: string; revision: number; onRestore: (revision: number) => Promise<void>; disabled?: boolean }) {
  const { client, webFetchJson } = useBackendApi();
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: queryKeys.workflowVersions(client.backendId, workflowId, revision), queryFn: ({ signal }) => webFetchJson<{ versions: WorkflowVersion[] }>(`/api/console/workflow-definitions/${encodeURIComponent(workflowId)}/versions`, { signal }) });
  if (query.isPending) return <LoadingState label="Loading versions…" />;
  if (query.error) return <ErrorState error={query.error} />;
  return <div className="space-y-3">{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{!query.data.versions.length ? <EmptyState title="No version history yet" /> : query.data.versions.map(version => <Disclosure key={version.revision} className="rounded-[var(--radius-panel,16px)] bg-muted/25 p-4" summary={<> <span className="flex-1 font-medium">Version {version.revision}</span>{version.revision === revision && <LearningStatus value="current" />}<Time value={version.createdAt} /> </>} triggerClassName="flex cursor-pointer flex-wrap items-center gap-3 text-sm"><div className="mt-4 space-y-3"><p className="text-sm text-muted-foreground">{version.restoredFromRevision !== null ? `Restored from version ${version.restoredFromRevision}` : version.reason ?? version.definition.name}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-menu,12px)] bg-background/40 p-3 text-xs text-muted-foreground">{JSON.stringify(version.definition, null, 2)}</pre>{version.revision !== revision && <Button variant="ghost" size="sm" disabled={restoring !== null || disabled} onClick={() => { setRestoring(version.revision); setError(""); void onRestore(version.revision).catch(cause => setError(errorText(cause, "Unable to restore this version."))).finally(() => setRestoring(null)); }}><RotateCcw className="size-4" />{restoring === version.revision ? "Restoring…" : "Restore this version"}</Button>}</div></Disclosure>)}</div>;
}

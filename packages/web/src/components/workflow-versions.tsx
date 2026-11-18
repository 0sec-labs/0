import { queryKeys } from "@/queries";
import { Disclosure } from "@/components/ui/disclosure";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { errorText } from "@/lib/api-error";

function Time({ value }: { value: string }) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : <time dateTime={value} className="text-xs text-muted-foreground">{date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>; }

interface WorkflowVersion { parentRevision: number | null; restoredFromRevision: number | null; digest: string; revision: number; createdAt: string; reason?: string; definition: { name: string; target: string; description?: string; instructions?: string; nodes: unknown[] }; }
export function WorkflowVersions({ workflowId, revision, onRestore, disabled = false }: { workflowId: string; revision: number; onRestore: (revision: number) => Promise<void>; disabled?: boolean }) {
  const { client, webFetchJson } = useBackendApi();
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: queryKeys.workflowVersions(client.backendId, workflowId, revision), queryFn: ({ signal }) => webFetchJson<{ versions: WorkflowVersion[] }>(`/api/console/workflow-definitions/${encodeURIComponent(workflowId)}/versions`, { signal }) });
  if (query.isPending) return <LoadingState label="Loading versions…" />;
  if (query.error) return <ErrorState error={query.error} />;
  return <div className="space-y-3">{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{!query.data.versions.length ? <EmptyState title="No version history yet" /> : query.data.versions.map(version => <Disclosure key={version.revision} className="rounded-[var(--radius-panel,16px)] bg-muted/25 p-4" summary={<> <span className="flex-1 font-medium">Version {version.revision}</span>{version.revision === revision && <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">Current</span>}<Time value={version.createdAt} /> </>} triggerClassName="flex cursor-pointer flex-wrap items-center gap-3 text-sm"><div className="mt-4 space-y-3"><p className="text-sm text-muted-foreground">{version.restoredFromRevision !== null ? `Restored from version ${version.restoredFromRevision}` : version.reason ?? version.definition.name}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-menu,12px)] bg-background/40 p-3 text-xs text-muted-foreground">{JSON.stringify(version.definition, null, 2)}</pre>{version.revision !== revision && <Button variant="ghost" size="sm" disabled={restoring !== null || disabled} onClick={() => { setRestoring(version.revision); setError(""); void onRestore(version.revision).catch(cause => setError(errorText(cause, "Unable to restore this version."))).finally(() => setRestoring(null)); }}><RotateCcw className="size-4" />{restoring === version.revision ? "Restoring…" : "Restore this version"}</Button>}</div></Disclosure>)}</div>;
}

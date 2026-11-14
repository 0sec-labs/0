import { v } from "@/lib/vocabulary";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SecurityWorkflowExecution } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { executionDurationMs, formatDuration, relativeAge } from "@/components/automations/automation-model";
import { LoadingState } from "@/components/state-panel";

export function WorkflowRuns({ workflowId, busy, onAction }: { workflowId: string; busy: boolean; onAction: (action: () => Promise<void>) => Promise<void> }) {
  const { client, webFetchJson } = useBackendApi();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["workflow-executions", client.backendId, workflowId], queryFn: ({ signal }) => webFetchJson<{ executions: SecurityWorkflowExecution[] }>(`/api/console/workflow-executions?workflowId=${encodeURIComponent(workflowId)}`, { signal }), refetchInterval: 3000 });
  if (query.isError) return <p role="alert" className="text-sm text-destructive">{query.error.message}</p>;
  if (query.isLoading) return <LoadingState label="Loading runs…" />;
  if (!query.data?.executions.length) return <p className="py-6 text-center text-sm text-muted-foreground">No runs yet. Review your steps, then select Run.</p>;
  const dot = (status: string) => status === "completed" ? "bg-success" : status === "failed" || status === "interrupted" ? "bg-destructive" : status === "running" || status === "queued" ? "bg-warning" : "bg-muted-foreground-3";
  return <div className="flex flex-col gap-1">{query.data.executions.map(execution => <article key={execution.id} className="rounded-[var(--radius-card,8px)] px-2 py-1.5 hover:bg-secondary">
    <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot(execution.status)}`} />
      <span className="w-24 shrink-0 text-sm capitalize">{execution.status}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={new Date(execution.createdAt).toLocaleString()}>{relativeAge(execution.createdAt, Date.now())} · {new Date(execution.createdAt).toLocaleString()} · v{execution.workflowRevision}</span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{formatDuration(executionDurationMs(execution))}</span>
      <div className="flex gap-1"><Button variant="ghost" size="xs" onClick={() => navigate(`/runs/${encodeURIComponent(`workflow:${execution.id}`)}`)}>Open run</Button><Button variant="ghost" size="xs" onClick={() => navigate(`/chats/${encodeURIComponent(execution.sessionId)}`)}>{v("Open {mission}")}</Button>{["queued", "running"].includes(execution.status) && <Button variant="ghost" size="xs" disabled={busy} onClick={() => void onAction(async () => { await webFetchJson(`/api/console/workflow-executions/${execution.id}/cancel`, { method: "POST", body: JSON.stringify({ sessionId: execution.sessionId }) }); await query.refetch(); }).catch(() => {})}>Stop</Button>}</div>
    </div>
    {execution.error && <p className="mt-1 pl-4 text-xs text-destructive">{execution.error}</p>}
    <div className="mt-1 space-y-0.5 pl-4">{Object.entries(execution.nodeResults).map(([id, result]) => <p key={id} className="text-xs text-muted-foreground">{execution.workflow.nodes.find(node => node.id === id)?.label ?? id} · {result.status}{result.error ? ` · ${result.error}` : ""}</p>)}</div>
  </article>)}</div>;
}

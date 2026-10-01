import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SecurityWorkflowExecution } from "@0/shared";
import { webFetchJson } from "@/api";
import { Button } from "@/components/ui/button";
import { ActivityIndicator } from "@/console/loading-state";

export function WorkflowRuns({ workflowId, busy, onAction }: { workflowId: string; busy: boolean; onAction: (action: () => Promise<void>) => Promise<void> }) {
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["workflow-executions", workflowId], queryFn: ({ signal }) => webFetchJson<{ executions: SecurityWorkflowExecution[] }>(`/api/console/workflow-executions?workflowId=${encodeURIComponent(workflowId)}`, { signal }), refetchInterval: 3000 });
  if (query.isError) return <p role="alert" className="text-sm text-destructive">{query.error.message}</p>;
  if (query.isLoading) return <ActivityIndicator label="Loading runs…" />;
  if (!query.data?.executions.length) return <p className="py-10 text-center text-sm text-muted-foreground">No runs yet. Review your steps, then select Run.</p>;
  return <div className="space-y-3">{query.data.executions.map(execution => <article key={execution.id} className="rounded-2xl bg-muted/25 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><span className="text-sm capitalize">{execution.status}</span><span className="ml-3 text-xs text-muted-foreground">{new Date(execution.createdAt).toLocaleString()} · v{execution.workflowRevision}</span></div><div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => navigate(`/console/${execution.sessionId}`)}>Open conversation</Button>{["queued", "running"].includes(execution.status) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onAction(async () => { await webFetchJson(`/api/console/workflow-executions/${execution.id}/cancel`, { method: "POST", body: JSON.stringify({ sessionId: execution.sessionId }) }); await query.refetch(); }).catch(() => {})}>Stop</Button>}</div></div>{execution.error && <p className="mt-3 text-xs text-destructive">{execution.error}</p>}<div className="mt-3 space-y-2">{Object.entries(execution.nodeResults).map(([id, result]) => <p key={id} className="text-xs text-muted-foreground">{execution.workflow.nodes.find(node => node.id === id)?.label ?? id} · {result.status}{result.error ? ` · ${result.error}` : ""}</p>)}</div></article>)}</div>;
}

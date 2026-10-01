import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronRight, Play } from "lucide-react";
import type { SecurityWorkflow } from "@0/shared";
import { webFetchJson } from "@/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WorkflowTriggers } from "@/components/workflow-triggers";

export type WorkflowScheduleSummary = { id: string; workflowId: string; workflowRevision: number; enabled: boolean; cadence: "hourly" | "daily" | "weekly"; nextFireAt: string; timezone: string; lastError?: string };
const CADENCES = { hourly: "Every hour", daily: "Every 24 hours", weekly: "Every 7 days" };
export function workflowAutomationSummary(workflow: SecurityWorkflow, schedules: WorkflowScheduleSummary[]) {
  const own = schedules.filter(schedule => schedule.workflowId === workflow.id);
  const active = own.filter(schedule => schedule.enabled);
  const next = [...active].sort((a, b) => a.nextFireAt.localeCompare(b.nextFireAt))[0];
  return { own, active, next, enabled: active.length > 0, needsReview: own.some(schedule => schedule.workflowRevision !== workflow.revision || schedule.lastError), label: active.length > 1 ? `${active.length} active schedules` : next ? CADENCES[next.cadence] : own.length ? "Schedules paused" : "Manual · Add trigger" };
}

/** Switch state reflects persisted recurring triggers; manual runs remain available. */
export function WorkflowAutomationControl({ workflow, disabled = false, onConfigureTarget }: { workflow: SecurityWorkflow; disabled?: boolean; onConfigureTarget: () => void }) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const schedules = useQuery({ queryKey: ["workflow-triggers", "all"], queryFn: ({ signal }) => webFetchJson<{ triggers: WorkflowScheduleSummary[] }>("/api/console/workflow-triggers", { signal }), refetchInterval: 5000 });
  const summary = workflowAutomationSummary(workflow, schedules.data?.triggers ?? []);
  const pause = async () => {
    setBusy(true); setError("");
    try {
      const results = await Promise.allSettled(summary.active.map(trigger => webFetchJson(`/api/console/workflow-triggers/${encodeURIComponent(trigger.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not pause schedules."); }
    finally { await cache.invalidateQueries({ queryKey: ["workflow-triggers"] }); setBusy(false); }
  };
  const enable = async () => {
    const schedule = summary.own.length === 1 ? summary.own[0] : undefined;
    if (!schedule || schedule.workflowRevision !== workflow.revision) { setOpen(true); return; }
    setBusy(true); setError("");
    try { await webFetchJson(`/api/console/workflow-triggers/${encodeURIComponent(schedule.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: true, approval: "enable-reviewed-trigger" }) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not enable schedule."); }
    finally { await cache.invalidateQueries({ queryKey: ["workflow-triggers"] }); setBusy(false); }
  };
  const inactive = disabled || busy || !schedules.data || schedules.isError;
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-3">
      <button type="button" disabled={disabled || busy} onClick={() => setOpen(true)} className="flex min-w-0 items-center gap-2 rounded-lg text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">
        {summary.own.length ? <CalendarClock aria-hidden="true" className="size-4 shrink-0" /> : <Play aria-hidden="true" className="size-4 shrink-0" />}<span className="truncate">{schedules.isPending ? "Loading triggers…" : schedules.isError ? "Triggers unavailable" : summary.label}</span><ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
      </button>
      <div className="flex shrink-0 items-center gap-2"><span className="text-xs text-muted-foreground">{summary.enabled ? "On" : "Off"}</span><Switch aria-label={`Automatic triggers for ${workflow.name}`} checked={summary.enabled} disabled={inactive} onCheckedChange={checked => { if (checked) void enable(); else void pause(); }} /></div>
    </div>
    {summary.next && <p className="text-xs text-muted-foreground">Next · {new Date(summary.next.nextFireAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: summary.next.timezone })}</p>}
    {summary.needsReview && <p className="text-xs text-muted-foreground">Review triggers</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>Triggers</DialogTitle><DialogDescription>{workflow.name}</DialogDescription></DialogHeader>{workflow.target.trim() ? <WorkflowTriggers workflow={workflow} disabled={disabled} /> : <div className="space-y-4"><p className="text-sm text-muted-foreground">Choose a target before setting up automatic runs.</p><Button onClick={() => { setOpen(false); onConfigureTarget(); }}>Set target</Button></div>}</DialogContent></Dialog>
  </div>;
}

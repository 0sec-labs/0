import { queryKeys } from "@/queries";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecurityWorkflow } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/api-error";

export type WorkflowScheduleSummary = { id: string; workflowId: string; workflowRevision: number; enabled: boolean; cadence: "hourly" | "daily" | "weekly"; nextFireAt: string; timezone: string; lastError?: string };
const CADENCES = { hourly: "Every hour", daily: "Every 24 hours", weekly: "Every 7 days" };
export function workflowAutomationSummary(workflow: SecurityWorkflow, schedules: WorkflowScheduleSummary[]) {
  const own = schedules.filter(schedule => schedule.workflowId === workflow.id);
  const active = own.filter(schedule => schedule.enabled);
  const next = [...active].sort((a, b) => a.nextFireAt.localeCompare(b.nextFireAt))[0];
  return { own, active, next, enabled: active.length > 0, needsReview: own.some(schedule => schedule.workflowRevision !== workflow.revision || schedule.lastError), label: active.length > 1 ? `${active.length} active schedules` : next ? CADENCES[next.cadence] : own.length ? "Schedules paused" : "Manual · Add trigger" };
}

/** Compact Active switch for list rows and the detail header. Enabling needs a schedule reviewed at the current revision; otherwise `onNeedsSetup` sends the user to the triggers form. */
export function AutomationActiveSwitch({ workflow, disabled = false, onNeedsSetup, className }: { workflow: SecurityWorkflow; disabled?: boolean; onNeedsSetup: () => void; className?: string }) {
  const { webFetchJson } = useBackendApi();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const schedules = useQuery({ queryKey: queryKeys.workflowTriggers("all"), queryFn: ({ signal }) => webFetchJson<{ triggers: WorkflowScheduleSummary[] }>("/api/console/workflow-triggers", { signal }), refetchInterval: 30_000 });
  const summary = workflowAutomationSummary(workflow, schedules.data?.triggers ?? []);
  const patch = async (triggers: WorkflowScheduleSummary[], body: Record<string, unknown>, fallback: string) => {
    setBusy(true); setError("");
    try {
      const results = await Promise.allSettled(triggers.map(trigger => webFetchJson(`/api/console/workflow-triggers/${encodeURIComponent(trigger.id)}`, { method: "PATCH", body: JSON.stringify(body) })));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } catch (cause) { setError(errorText(cause, fallback)); }
    finally { await cache.invalidateQueries({ queryKey: queryKeys.workflowTriggers() }); setBusy(false); }
  };
  const change = (checked: boolean) => {
    if (!checked) { void patch(summary.active, { enabled: false }, "Could not pause schedules."); return; }
    const schedule = summary.own.length === 1 ? summary.own[0] : undefined;
    if (!schedule || schedule.workflowRevision !== workflow.revision) { onNeedsSetup(); return; }
    void patch([schedule], { enabled: true, approval: "enable-reviewed-trigger" }, "Could not enable schedule.");
  };
  return <span className={className}>
    <Switch aria-label={`Automatic triggers for ${workflow.name}`} checked={summary.enabled} disabled={disabled || busy || !schedules.data || schedules.isError} onCheckedChange={change} />
    {error && <span role="alert" className="sr-only">{error}</span>}
  </span>;
}

import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ChevronRight, RefreshCw } from "lucide-react";
import type { SecurityWorkflow } from "@0/shared";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/state-panel";

type Schedule = {
  id: string;
  workflowId: string;
  cadence: "hourly" | "daily" | "weekly";
  timezone: string;
  nextFireAt: string;
  enabled: boolean;
};
const CADENCES = { hourly: "Hourly", daily: "Daily", weekly: "Weekly" };

function nextRun(value: string, timezone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: timezone }).format(date);
  } catch { return date.toLocaleString(); }
}

/** Schedules open the same workflow editor; timing is part of the automation. */
export function AutomationSchedules({ definitions, search, busy, onSelect }: {
  definitions: SecurityWorkflow[];
  search: string;
  busy: boolean;
  onSelect: (id: string) => void;
}) {
  const { client, webFetchJson } = useBackendApi();
  const team = useTeamAccess();
  const schedules = useQuery({
    queryKey: ["workflow-triggers", client.backendId, team.user?.workspaceId ?? "personal", team.user?.userId ?? "local", "all"],
    queryFn: ({ signal }) => webFetchJson<{ triggers: Schedule[] }>("/api/console/workflow-triggers", { signal }),
    refetchInterval: 5000,
  });
  const byId = new Map(definitions.map(workflow => [workflow.id, workflow]));
  const needle = search.trim().toLocaleLowerCase();
  const visible = (schedules.data?.triggers ?? []).filter(schedule => {
    const workflow = byId.get(schedule.workflowId);
    return `${workflow?.name ?? "Unavailable workflow"} ${workflow?.target ?? ""} ${CADENCES[schedule.cadence]} ${schedule.timezone} ${schedule.enabled ? "enabled" : "paused"}`.toLocaleLowerCase().includes(needle);
  });
  if (schedules.isPending) return <LoadingState label="Loading schedules…" />;
  if (schedules.isError) return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-menu)] bg-destructive/10 p-4 text-sm"><p className="text-destructive">{schedules.error.message}</p><Button type="button" variant="ghost" size="sm" disabled={schedules.isFetching} onClick={() => void schedules.refetch()}><RefreshCw aria-hidden="true" className="size-4" />Try again</Button></div>;
  if (!visible.length) return <div className="flex flex-col items-center gap-3 py-14 text-center"><CalendarClock aria-hidden="true" className="size-6 text-muted-foreground/60" /><p className="text-sm text-muted-foreground">{needle ? "No matching schedules." : "No schedules yet. Open a workflow and tell chat when it should run."}</p></div>;
  return <ul aria-label="Scheduled automations" className="divide-y divide-border/50">
    {visible.map(schedule => {
      const workflow = byId.get(schedule.workflowId);
      return <li key={schedule.id}><Button type="button" variant="ghost" disabled={busy || !workflow} onClick={() => onSelect(schedule.workflowId)} className="h-auto w-full justify-start gap-3 whitespace-normal rounded-[var(--radius-menu)] px-4 py-4 text-left font-normal">
        <CalendarClock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{workflow?.name ?? "Unavailable workflow"}</span><span className="mt-1 block text-xs text-muted-foreground">{CADENCES[schedule.cadence]}<span aria-hidden="true"> · </span><span title={schedule.timezone}>{schedule.enabled ? "Next " : "Scheduled "}{nextRun(schedule.nextFireAt, schedule.timezone)}</span></span></span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">{schedule.enabled && <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" />}{schedule.enabled ? "Enabled" : "Paused"}</span>
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/60" />
      </Button></li>;
    })}
  </ul>;
}

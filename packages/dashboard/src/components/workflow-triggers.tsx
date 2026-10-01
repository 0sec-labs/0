import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, Clock3, Plus, RefreshCw } from "lucide-react";
import type { SecurityWorkflow } from "@0/shared";
import { createConsoleSession, listConsoleSessions, webFetchJson } from "@/api";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ActivityIndicator } from "@/console/loading-state";

// Display fields only; database claim metadata is not part of this UI.
type Cadence = "hourly" | "daily" | "weekly";
type Trigger = {
  id: string; workflowId: string; workflowRevision: number; sessionId: string;
  kind: "schedule"; cadence: Cadence; startAt: string; timezone: string;
  enabled: boolean; nextFireAt: string; lastStatus?: string; lastError?: string;
  lastExecutionId?: string;
};
type ScheduleInput = Pick<Trigger, "workflowId" | "workflowRevision" | "sessionId" | "cadence" | "startAt" | "timezone">;
const PATH = "/api/console/workflow-triggers";
const CADENCES: Record<Cadence, string> = { hourly: "Every hour", daily: "Every 24 hours", weekly: "Every 7 days" };
const STATUSES: Record<string, string> = { scheduled: "Scheduled", paused: "Paused", starting: "Starting", running: "Running", completed: "Completed", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted", blocked: "Needs attention", needs_review: "Workflow changed", skipped_missed: "Missed run skipped" };
const localTime = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
function displayTime(value: string, timezone?: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  try { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" as const } : {}), hour: "numeric", minute: "2-digit", timeZoneName: "short", ...(timezone ? { timeZone: timezone } : {}) }).format(date); }
  catch { return date.toLocaleString(); }
}

export function WorkflowTriggers({ workflow, disabled = false }: { workflow: SecurityWorkflow; disabled?: boolean }) {
  const cache = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [ownerId, setOwnerId] = useState("");
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [firstRun, setFirstRun] = useState(() => localTime(new Date(Date.now() + 3_600_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const sessions = useQuery({ queryKey: ["workflow-trigger-sessions"], queryFn: ({ signal }) => listConsoleSessions(signal), refetchInterval: 15_000 });
  const schedules = useQuery({ queryKey: ["workflow-triggers", workflow.id], queryFn: ({ signal }) => webFetchJson<{ triggers: Trigger[] }>(`${PATH}?workflowId=${encodeURIComponent(workflow.id)}`, { signal }), refetchInterval: 5_000 });
  const owners = (sessions.data ?? []).filter(session => session.status !== "closed" && session.status !== "failed");
  const owner = owners.find(session => session.id === ownerId);
  const inactive = disabled || busy;
  const hasTarget = Boolean(workflow.target.trim());
  const run = async (operation: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true); setError(""); setFeedback("");
    try { await operation(); setFeedback(message); await cache.invalidateQueries({ queryKey: ["workflow-triggers"] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The schedule could not be updated."); }
    finally { setBusy(false); }
  };
  const input = (): ScheduleInput | null => {
    setError(""); setFeedback("");
    if (!hasTarget || !owner) { setError("Set a workflow target and choose a conversation first."); return null; }
    const date = new Date(firstRun.replace(" ", "T"));
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(firstRun) || !Number.isFinite(date.getTime()) || localTime(date) !== firstRun) { setError("Enter a valid local date and time, such as 2026-10-03 09:00."); return null; }
    if (date.getTime() <= Date.now()) { setError("Choose a first run in the future."); return null; }
    return { workflowId: workflow.id, workflowRevision: workflow.revision, sessionId: owner.id, cadence, startAt: date.toISOString(), timezone };
  };
  const createOwner = () => void run(async () => {
    const session = await createConsoleSession({ title: `Schedule: ${workflow.name}`, target: workflow.target, autonomyMode: "standard" });
    setOwnerId(session.id); await cache.invalidateQueries({ queryKey: ["workflow-trigger-sessions"] });
  }, "Connection ready.");
  const saveSchedule = (enabled: boolean) => {
    const fields = input(); if (!fields) return;
    void run(async () => {
      await webFetchJson(PATH, { method: "POST", body: JSON.stringify({ ...fields, enabled, ...(enabled ? { approval: "enable-reviewed-trigger" } : {}) }) });
      setAdding(false);
    }, enabled ? "Schedule on." : "Schedule saved.");
  };
  return <div className="space-y-7">
    <p className="text-xs text-muted-foreground">Run manually, on a schedule, or through the local API.</p>
    <section className="space-y-4"><div className="flex items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-sm font-medium"><CalendarClock aria-hidden="true" className="size-4" />Schedules</h3><div className="flex items-center gap-1"><Button variant="ghost" size="sm" disabled={inactive} onClick={() => setAdding(true)}><Plus aria-hidden="true" />Add schedule</Button><Button variant="ghost" size="icon-sm" aria-label="Refresh schedules" disabled={inactive || schedules.isFetching} onClick={() => void schedules.refetch()}><RefreshCw aria-hidden="true" /></Button></div></div>
      {schedules.isPending && <ActivityIndicator label="Loading schedules…" />}
      {schedules.isError && <p role="alert" className="text-sm text-destructive">{schedules.error.message}</p>}
      {schedules.data?.triggers.map(trigger => {
        const changed = trigger.workflowRevision !== workflow.revision;
        return <article key={trigger.id} className="rounded-2xl bg-muted/35 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="text-sm font-medium">{CADENCES[trigger.cadence]}</h4></div><div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{trigger.enabled ? "On" : "Off"}</span><Switch aria-label={`Enable ${CADENCES[trigger.cadence]} schedule`} checked={trigger.enabled} disabled={inactive || (!trigger.enabled && (!hasTarget || changed))} onCheckedChange={enabled => {
          void run(() => webFetchJson(`${PATH}/${encodeURIComponent(trigger.id)}`, { method: "PATCH", body: JSON.stringify({ enabled, ...(enabled ? { approval: "enable-reviewed-trigger" } : {}) }) }), enabled ? "Schedule on." : "Schedule off. Active runs continue.");
        }} /></div></div>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2"><div><dt className="text-muted-foreground">{trigger.enabled ? "Next run" : "Next scheduled time"}</dt><dd className="mt-1">{displayTime(trigger.nextFireAt, trigger.timezone)}</dd></div><div><dt className="text-muted-foreground">Last result</dt><dd className="mt-1">{trigger.lastStatus ? STATUSES[trigger.lastStatus] ?? trigger.lastStatus.replaceAll("_", " ") : "No runs yet"}</dd></div></dl>
          {changed && <p className="mt-3 text-xs text-muted-foreground">The workflow changed. Create a new schedule for its current revision.</p>}
          {trigger.lastError && <p className="mt-3 text-xs leading-5 text-destructive">{trigger.lastError}</p>}
        </article>;
      })}
      {schedules.data && !schedules.data.triggers.length && <p className="text-sm text-muted-foreground">No schedules yet.</p>}
    </section>
    {(adding || schedules.data?.triggers.length === 0) && <section className="space-y-4"><h3 className="text-sm font-medium">Create a schedule</h3><p className="text-xs leading-5 text-muted-foreground">Keep the local engine open. Missed runs are skipped.</p><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Timing details</summary><p className="mt-2 leading-5">Intervals use elapsed UTC time; local times may shift with daylight saving.</p></details>
      {!hasTarget && <p className="text-sm text-muted-foreground">Set a target in this workflow before scheduling it.</p>}
      <div className="grid gap-4 sm:grid-cols-2"><Select label="Repeat" value={cadence} options={Object.entries(CADENCES).map(([value, label]) => ({ value, label }))} disabled={inactive || !hasTarget} onValueChange={value => setCadence(value as Cadence)} /><label className="space-y-2 text-sm"><span className="block font-medium">First run · {timezone}</span><Input aria-label="First scheduled run in local time" value={firstRun} placeholder="YYYY-MM-DD HH:mm" disabled={inactive || !hasTarget} onChange={event => setFirstRun(event.target.value)} /></label></div>
      <div className="flex flex-wrap items-end gap-3"><Select className="min-w-0 flex-1" label="Run with" value={ownerId} placeholder="Choose a conversation" disabled={inactive || sessions.isPending || !hasTarget} options={[{ value: "", label: "Choose a conversation" }, ...owners.map(session => ({ value: session.id, label: `${session.title || "Conversation"} · ${session.runtime?.model || session.autonomyMode}` }))]} onValueChange={setOwnerId} /><Button variant="ghost" size="sm" disabled={inactive || !hasTarget} onClick={createOwner}><Plus aria-hidden="true" />New conversation</Button></div>
      {sessions.isError && <p role="alert" className="text-xs text-destructive">{sessions.error.message}</p>}
      {owner && <p className="text-xs text-muted-foreground"><a className="underline underline-offset-4" href={`/console/${encodeURIComponent(owner.id)}`}>Review conversation</a></p>}
      <div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" disabled={inactive || !hasTarget || !owner} onClick={() => saveSchedule(false)}>Save off</Button><Button size="sm" disabled={inactive || !hasTarget || !owner} onClick={() => saveSchedule(true)}><Clock3 aria-hidden="true" />Enable schedule</Button></div>
    </section>}
    {busy && <ActivityIndicator label="Updating schedule…" />}{feedback && <p role="status" className="flex items-start gap-2 text-sm text-muted-foreground"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{feedback}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}

  </div>;
}

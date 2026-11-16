import { queryKeys } from "@/queries";
import { ActivityIndicator } from "@/console/loading-state";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Hand, Plus, Trash2 } from "lucide-react";
import type { SecurityWorkflow } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { scheduleSummaryLabel } from "@/components/automations/automation-model";
import { LoadingState } from "@/components/state-panel";
import { errorText } from "@/lib/api-error";
import { toast } from "@/ui/components/toast";

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
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CADENCE_NAMES: Record<Cadence, string> = { hourly: "Hourly", daily: "Daily", weekly: "Weekly" };
const RAN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "running", "starting"]);
const DEFAULT_TIME: Record<Cadence, string> = { hourly: "00:00", daily: "09:00", weekly: "09:00" };
const STATUSES: Record<string, string> = { scheduled: "Scheduled", paused: "Paused", starting: "Starting", running: "Running", completed: "Completed", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted", blocked: "Needs attention", needs_review: "Workflow changed", skipped_missed: "Missed run skipped" };
export function displayTime(value: string, timezone?: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  try { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" as const } : {}), hour: "numeric", minute: "2-digit", timeZoneName: "short", ...(timezone ? { timeZone: timezone } : {}) }).format(date); }
  catch { return date.toLocaleString(); }
}

export function WorkflowTriggers({ workflow, disabled = false }: { workflow: SecurityWorkflow; disabled?: boolean }) {
  const { createConsoleSession, listConsoleSessions, webFetchJson } = useBackendApi();
  const cache = useQueryClient();
  const [adding, setAdding] = useState(false);
  const addForm = useRef<HTMLElement>(null);
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [time, setTime] = useState(DEFAULT_TIME.daily);
  const [minute, setMinute] = useState("0");
  const [weekday, setWeekday] = useState(() => String(new Date().getDay()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const sessions = useQuery({ queryKey: queryKeys.workflowTriggerSessions(), queryFn: ({ signal }) => listConsoleSessions(signal), refetchInterval: 15_000 });
  const schedules = useQuery({ queryKey: queryKeys.workflowTriggers(workflow.id), queryFn: ({ signal }) => webFetchJson<{ triggers: Trigger[] }>(`${PATH}?workflowId=${encodeURIComponent(workflow.id)}`, { signal }), refetchInterval: 5_000 });
  const owners = (sessions.data ?? []).filter(session => session.status !== "closed" && session.status !== "failed");
  const inactive = disabled || busy;
  const hasTarget = Boolean(workflow.target.trim());
  const run = async (operation: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await operation(); toast({ title: message, kind: "success" }); await cache.invalidateQueries({ queryKey: queryKeys.workflowTriggers() }); }
    catch (cause) { setError(errorText(cause, "The schedule could not be updated.")); }
    finally { setBusy(false); }
  };
  /** Next wall-clock occurrence of the chosen time (and weekday for weekly), in this browser's timezone. */
  const firstRun = () => {
    const [hour = 9, minuteOfHour = 0] = time.split(":").map(Number);
    const date = new Date();
    if (cadence === "hourly") { date.setMinutes(Number(minute), 0, 0); while (date.getTime() <= Date.now()) date.setHours(date.getHours() + 1); return date; }
    date.setHours(hour, minuteOfHour, 0, 0);
    if (cadence === "weekly") date.setDate(date.getDate() + ((Number(weekday) - date.getDay() + 7) % 7));
    while (date.getTime() <= Date.now()) date.setDate(date.getDate() + (cadence === "weekly" ? 7 : 1));
    return date;
  };
  const validTime = cadence === "hourly" ? /^\d{1,2}$/.test(minute) && Number(minute) <= 59 : /^\d{2}:\d{2}$/.test(time);
  const preview = validTime ? [0, 1, 2].map(index => { const date = firstRun(); if (cadence === "hourly") date.setHours(date.getHours() + index); else date.setDate(date.getDate() + index * (cadence === "weekly" ? 7 : 1)); return displayTime(date.toISOString(), timezone); }) : [];
  const saveSchedule = (enabled: boolean) => {
    setError("");
    if (!hasTarget) { setError("Add a scope first."); return; }
    if (!validTime) { setError(cadence === "hourly" ? "Enter a minute from 0 to 59." : "Enter a valid time."); return; }
    const start = firstRun();
    const duplicate = schedules.data?.triggers.some(trigger => { const at = new Date(trigger.startAt); return trigger.cadence === cadence && trigger.timezone === timezone && at.getMinutes() === start.getMinutes() && (cadence === "hourly" || at.getHours() === start.getHours()) && (cadence !== "weekly" || at.getDay() === start.getDay()); });
    if (duplicate) { setError("This schedule already exists."); return; }
    void run(async () => {
      const title = `Schedule: ${workflow.name}`;
      const sessionId = owners.find(session => session.title === title)?.id ?? (await createConsoleSession({ title, target: workflow.target })).id;
      const fields: ScheduleInput = { workflowId: workflow.id, workflowRevision: workflow.revision, sessionId, cadence, startAt: start.toISOString(), timezone };
      await webFetchJson(PATH, { method: "POST", body: JSON.stringify({ ...fields, enabled, ...(enabled ? { approval: "enable-reviewed-trigger" } : {}) }) });
      await cache.invalidateQueries({ queryKey: queryKeys.workflowTriggerSessions() });
      setAdding(false);
    }, enabled ? "Schedule on." : "Schedule saved.");
  };
  const changeCadence = (next: Cadence) => { setCadence(next); setTime(DEFAULT_TIME[next]); setMinute("0"); setError(""); };
  const startAdding = (next: Cadence) => { changeCadence(next); setAdding(true); requestAnimationFrame(() => addForm.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })); };
  const remove = (trigger: Trigger) => void run(() => webFetchJson(`${PATH}/${encodeURIComponent(trigger.id)}`, { method: "DELETE" }), "Schedule removed.");
  const card = "rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card p-3";
  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0"><h3 className="text-sm font-medium">Triggers</h3></div>
      <div className="flex items-center gap-1">
        <DropdownMenu><DropdownMenu.Trigger render={<Button variant="outline" size="sm" disabled={inactive} />}><Plus aria-hidden="true" />Add trigger</DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" className="w-64">
            <DropdownMenu.Group>
              <DropdownMenu.Label>On a schedule</DropdownMenu.Label>
              {(["hourly", "daily", "weekly"] as const).map(value => <DropdownMenu.Item key={value} icon={<CalendarClock aria-hidden="true" />} onClick={() => startAdding(value)}>{CADENCE_NAMES[value]}</DropdownMenu.Item>)}
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </div>
    <article className={`${card} flex items-center gap-3`}><Hand aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm">Manual run</p></div></article>
    {schedules.isPending && <LoadingState label="Loading schedules…" rows={2} />}
    {schedules.isError && <p role="alert" className="text-sm text-destructive">{schedules.error.message}</p>}
    {schedules.data?.triggers.map(trigger => {
      const changed = trigger.workflowRevision !== workflow.revision;
      const name = CADENCES[trigger.cadence];
      return <article key={trigger.id} className={card}>
        <div className="flex flex-wrap items-center gap-3"><CalendarClock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm">{scheduleSummaryLabel(trigger)}</p><p className="text-xs text-muted-foreground">{trigger.enabled ? `Next run ${displayTime(trigger.nextFireAt, trigger.timezone)}` : "Paused"}{trigger.lastStatus && RAN_STATUSES.has(trigger.lastStatus) ? ` · Last run ${(STATUSES[trigger.lastStatus] ?? trigger.lastStatus).toLowerCase()}` : trigger.lastStatus && ["blocked", "needs_review", "skipped_missed"].includes(trigger.lastStatus) ? ` · ${STATUSES[trigger.lastStatus]}` : ""}</p></div>
          <Switch aria-label={`Enable ${name} schedule`} checked={trigger.enabled} disabled={inactive || (!trigger.enabled && (!hasTarget || changed))} onCheckedChange={enabled => {
            void run(() => webFetchJson(`${PATH}/${encodeURIComponent(trigger.id)}`, { method: "PATCH", body: JSON.stringify({ enabled, ...(enabled ? { approval: "enable-reviewed-trigger" } : {}) }) }), enabled ? "Schedule on." : "Schedule off. Active runs continue.");
          }} />
          <Tooltip content={trigger.enabled ? "Turn the schedule off to remove it" : "Remove schedule"}><span className="inline-flex"><Button variant="ghost" size="icon-sm" aria-label={`Remove ${name} schedule`} disabled={inactive || trigger.enabled} onClick={() => remove(trigger)}><Trash2 aria-hidden="true" /></Button></span></Tooltip>
        </div>
        {changed && <p className="mt-2 text-xs text-muted-foreground">The automation changed. Create a new schedule for its current revision.</p>}
        {trigger.lastError && <p className="mt-2 text-xs leading-5 text-destructive">{trigger.lastError}</p>}
      </article>;
    })}
    {adding && <section ref={addForm} aria-label="New schedule" className={`${card} space-y-4`}>
      <div className="flex flex-wrap items-end gap-3">
        <Select className="w-36" label="Frequency" value={cadence} options={Object.entries(CADENCE_NAMES).map(([value, label]) => ({ value, label }))} disabled={inactive || !hasTarget} onValueChange={value => changeCadence(value as Cadence)} />
        {cadence === "weekly" && <Select className="w-40" label="On" value={weekday} options={WEEKDAYS.map((label, index) => ({ value: String(index), label }))} disabled={inactive} onValueChange={setWeekday} />}
        <label className="space-y-2 text-sm"><span className="block">{cadence === "hourly" ? "At minute" : "At"}</span>{cadence === "hourly" ? <Input aria-label="Minute past the hour" type="number" min={0} max={59} value={minute} disabled={inactive} onChange={event => { setMinute(event.target.value); setError(""); }} className="h-8 w-24 text-sm" /> : <Input aria-label="Time of day" type="time" value={time} disabled={inactive} onChange={event => setTime(event.target.value)} className="h-8 w-32 text-sm" />}</label>
        <span className="pb-1.5 text-sm text-muted-foreground">{timezone}</span>
      </div>
      {preview.length > 0 && <p className="text-xs text-muted-foreground">Next runs: {preview.join(", ")}</p>}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={inactive || !hasTarget} onClick={() => saveSchedule(true)}>Add and enable</Button><Button variant="outline" size="sm" disabled={inactive || !hasTarget} onClick={() => saveSchedule(false)}>Add paused</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setAdding(false)}>Cancel</Button></div>
    </section>}
    {busy && <ActivityIndicator label="Updating schedule…" />}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}

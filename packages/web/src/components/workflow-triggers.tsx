import { v } from "@/lib/vocabulary";
import { ActivityIndicator } from "@/console/loading-state";
import { Link } from "react-router-dom";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, Clock3, GitPullRequest, Hand, Link2, MessageSquare, Plus, Trash2 } from "lucide-react";
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
const CADENCE_NAMES: Record<Cadence, string> = { hourly: "Hourly", daily: "Daily", weekly: "Weekly" };
const STATUSES: Record<string, string> = { scheduled: "Scheduled", paused: "Paused", starting: "Starting", running: "Running", completed: "Completed", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted", blocked: "Needs attention", needs_review: "Workflow changed", skipped_missed: "Missed run skipped" };
const localTime = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
function displayTime(value: string, timezone?: string): string {
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
    if (!hasTarget || !owner) { setError(v("Set an automation target and choose {a mission} first.")); return null; }
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
  const startAdding = (next: Cadence) => { setCadence(next); setAdding(true); requestAnimationFrame(() => addForm.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })); };
  const remove = (trigger: Trigger) => void run(() => webFetchJson(`${PATH}/${encodeURIComponent(trigger.id)}`, { method: "DELETE" }), "Schedule removed.");
  const soon = [{ icon: GitPullRequest, label: "GitHub" }, { icon: MessageSquare, label: "Slack" }, { icon: Link2, label: "Webhook request" }];
  const card = "rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card p-3";
  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0"><h3 className="text-sm font-medium">Triggers</h3><p className="text-xs text-muted-foreground">Runs when any of these conditions are met</p></div>
      <div className="flex items-center gap-1">
        <DropdownMenu><DropdownMenu.Trigger render={<Button variant="outline" size="sm" disabled={inactive} />}><Plus aria-hidden="true" />Add trigger</DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" className="w-64">
            <DropdownMenu.Group>
              <DropdownMenu.Label>On a schedule</DropdownMenu.Label>
              {(["hourly", "daily", "weekly"] as const).map(value => <DropdownMenu.Item key={value} icon={<CalendarClock aria-hidden="true" />} onClick={() => startAdding(value)}>{CADENCE_NAMES[value]}</DropdownMenu.Item>)}
            </DropdownMenu.Group>
            <DropdownMenu.Group>
              <DropdownMenu.Label>Events</DropdownMenu.Label>
              {soon.map(item => <DropdownMenu.Item key={item.label} disabled icon={<item.icon aria-hidden="true" />}>{item.label}<span className="ml-auto text-2xs text-muted-foreground">Coming soon</span></DropdownMenu.Item>)}
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </div>
    <article className={`${card} flex items-center gap-3`}><Hand aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm">Manual run</p><p className="text-xs text-muted-foreground">Start it any time with Run now</p></div></article>
    {schedules.isPending && <LoadingState label="Loading schedules…" rows={2} />}
    {schedules.isError && <p role="alert" className="text-sm text-destructive">{schedules.error.message}</p>}
    {schedules.data?.triggers.map(trigger => {
      const changed = trigger.workflowRevision !== workflow.revision;
      const name = CADENCES[trigger.cadence];
      return <article key={trigger.id} className={card}>
        <div className="flex flex-wrap items-center gap-3"><CalendarClock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm">{scheduleSummaryLabel(trigger)}</p><p className="text-xs text-muted-foreground">{trigger.enabled ? `Next run ${displayTime(trigger.nextFireAt, trigger.timezone)}` : "Paused"}{trigger.lastStatus ? ` · Last run ${(STATUSES[trigger.lastStatus] ?? trigger.lastStatus.replaceAll("_", " ")).toLowerCase()}` : ""}</p></div>
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
      <p className="text-xs text-muted-foreground">The local engine must stay open. Missed runs are skipped, and times follow this browser&apos;s timezone.</p>
      {!hasTarget && <p className="text-sm text-muted-foreground">Set a target in this automation before scheduling it.</p>}
      <div className="grid gap-4 sm:grid-cols-2"><Select label="Repeat" value={cadence} options={Object.entries(CADENCES).map(([value, label]) => ({ value, label }))} disabled={inactive || !hasTarget} onValueChange={value => setCadence(value as Cadence)} /><label className="space-y-2 text-sm"><span className="block">First run · {timezone}</span><Input aria-label="First scheduled run in local time" value={firstRun} placeholder="YYYY-MM-DD HH:mm" disabled={inactive || !hasTarget} onChange={event => setFirstRun(event.target.value)} /></label></div>
      <div className="flex flex-wrap items-end gap-3"><Select className="min-w-0 flex-1" label="Run with" value={ownerId} placeholder={v("Choose {a mission}")} disabled={inactive || sessions.isPending || !hasTarget} options={[{ value: "", label: v("Choose {a mission}") }, ...owners.map(session => ({ value: session.id, label: `${session.title || "Conversation"} · ${session.runtime?.model || session.autonomyMode}` }))]} onValueChange={setOwnerId} /><Button variant="ghost" size="sm" disabled={inactive || !hasTarget} onClick={createOwner}><Plus aria-hidden="true" />{v("New {mission}")}</Button></div>
      {sessions.isError && <p role="alert" className="text-xs text-destructive">{sessions.error.message}</p>}
      {owner && <p className="text-xs text-muted-foreground"><Link className="underline underline-offset-4" to={`/chats/${encodeURIComponent(owner.id)}`}>{v("Review {mission}")}</Link></p>}
      <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" disabled={inactive || !hasTarget || !owner} onClick={() => saveSchedule(false)}>Save paused</Button><Button variant="secondary" size="sm" disabled={inactive || !hasTarget || !owner} onClick={() => saveSchedule(true)}><Clock3 aria-hidden="true" />Enable schedule</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setAdding(false)}>Cancel</Button></div>
    </section>}
    {busy && <ActivityIndicator label="Updating schedule…" />}{feedback && <p role="status" className="flex items-start gap-2 text-sm text-muted-foreground"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{feedback}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}

import { useState } from "react";
import { errorText } from "@/lib/api-error";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { v } from "@/lib/vocabulary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { EmptyState, LoadingState } from "@/components/state-panel";
import { formatRelativeAge } from "@/lib/relative-time";
import { toast } from "@/ui/components/toast";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { displayTime } from "@/lib/display-time";
import { useAgentTurns, useSentinelAutomations, useSentinelTriggers, useSentinelMutations, useSentinelPresets } from "@/sentinels/api";
import { NEEDS_REVIEW_COPY, draftFromSchedule, triggerRequestFromDraft, type TriggerDraft, describeTrigger, triggerKindLabel, fieldsFromForm, formFromSentinel, presentStatus, type Sentinel, type AgentTurn, type SentinelAutomation, type SentinelFormState, type SentinelTrigger } from "@/sentinels/model";
import { addedSuggestions, sentinelHref, suggestedSchedule, type SentinelPresetAutomation } from "@/sentinels/model";
import { SentinelFiles } from "./sentinel-files";
import { SentinelFields } from "./sentinel-fields";
import { ScheduleFields } from "./schedule-fields";
import { CAUSE_LABEL, turnLabel, workedFor } from "@/sentinels/wake";
import { AddTriggerDialog } from "./add-trigger-dialog";
import { AutomationEditor } from "@/components/automations/automation-editor";
import { NewAutomationDialog } from "@/components/automations/new-automation-dialog";
import { useCreateAutomation } from "@/components/automations/use-automations";

const TURN_TONE: Record<AgentTurn["status"], "success" | "warning" | "danger" | "info" | "neutral"> = { queued: "neutral", running: "info", completed: "success", failed: "danger", cancelled: "neutral", skipped: "neutral" };
const ago = (iso: string) => formatRelativeAge(Date.parse(iso));
const chatHref = (missionId: string | null | undefined) => (missionId ? `/chats/${encodeURIComponent(missionId)}` : undefined);

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <section className="space-y-3"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">{title}</h2>{action}</div>{children}</section>;
}

export function SentinelOverview({ sentinel, readOnly }: { sentinel: Sentinel; readOnly: boolean }) {
  const { setPaused, acknowledge } = useSentinelMutations();
  const turns = useAgentTurns(sentinel.id);
  const [error, setError] = useState("");
  const status = presentStatus(sentinel);
  const archived = sentinel.status === "archived";
  const paused = sentinel.status === "paused";
  const week = (turns.data ?? []).filter(item => item.status !== "skipped" && Date.now() - Date.parse(item.startedAt ?? item.queuedAt ?? "") < 7 * 86_400_000);
  const cost = week.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
  const last = (turns.data ?? []).find(item => item.status !== "skipped" && item.status !== "queued");
  const acknowledgeReview = async () => {
    setError("");
    try { await acknowledge.mutateAsync({ id: sentinel.id, version: sentinel.version }); } catch (cause) { setError(errorText(cause, "Unable to acknowledge the review.")); }
  };
  const toggle = async () => {
    setError("");
    try { await setPaused.mutateAsync({ id: sentinel.id, paused: !paused, version: sentinel.version }); } catch (cause) { setError(errorText(cause, "Unable to change status.")); }
  };
  return <div className="space-y-8">
    {status.needsReview && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-card) bg-amber-500/10 px-4 py-3 text-sm">
      <span className="min-w-0 flex-1">{sentinel.attention?.reason ? `${sentinel.attention.reason} It will not run on its own until you review the change and acknowledge it.` : NEEDS_REVIEW_COPY}</span>
      {!readOnly && !archived && <Button type="button" size="sm" variant="secondary" disabled={acknowledge.isPending} onClick={() => void acknowledgeReview()}>{acknowledge.isPending ? "Acknowledging" : "Acknowledge"}</Button>}
    </div>}
    {!status.needsReview && sentinel.attention?.reason && <div role="status" className="rounded-(--radius-card) bg-amber-500/10 px-4 py-3 text-sm">{sentinel.attention.reason}</div>}
    {status.needsYou && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-card) bg-amber-500/10 px-4 py-3 text-sm">
      <span>{sentinel.name} is waiting on {sentinel.attention?.pendingDecisions ?? 1} decision{(sentinel.attention?.pendingDecisions ?? 1) === 1 ? "" : "s"} from you.</span>
      <Button size="sm" variant="secondary" render={<Link to={sentinelHref(sentinel.id)} />}>Open thread</Button>
    </div>}
    <Section title="Status">
      <div className="flex items-center justify-between gap-4 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-4">
        <div className="min-w-0"><p className="text-sm font-medium">{archived ? "Archived" : paused ? "Paused" : "Active"}</p><p className="text-xs text-muted-foreground-1">{archived ? "Archived." : paused ? "Triggers are off. You can still message it." : "Wakes on its triggers and budget."}</p></div>
        <Switch aria-label={paused ? v("Resume {Sentinel}") : v("Pause {Sentinel}")} checked={sentinel.status === "active"} disabled={readOnly || archived || setPaused.isPending} onCheckedChange={() => void toggle()} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </Section>
    <Section title="Last 7 days">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["Turns", String(week.length)], ["Failed", String(week.filter(item => item.status === "failed").length)], ["Cost", `$${cost.toFixed(2)}`], ["Last turn", last?.startedAt ? ago(last.startedAt) || "now" : "Never"]].map(([label, value]) => <div key={label} className="rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-3"><dt className="text-xs text-muted-foreground-1">{label}</dt><dd className="mt-1 text-lg font-medium tabular-nums">{value}</dd></div>)}
      </dl>
    </Section>
    <Section title="Memory and files"><SentinelFiles sentinelId={sentinel.id} readOnly={readOnly || archived} /></Section>
    <Section title="Activity"><AgentActivity sentinel={sentinel} /></Section>
  </div>;
}

function TriggerRow({ sentinel, trigger, readOnly, onEnable }: { sentinel: Sentinel; trigger: SentinelTrigger; readOnly: boolean; onEnable: (trigger: SentinelTrigger) => void }) {
  const { updateTrigger, removeTrigger } = useSentinelMutations();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<TriggerDraft | null>(null);
  const change = async (run: () => Promise<unknown>) => { setError(""); try { await run(); } catch (cause) { setError(errorText(cause, "Unable to change the trigger.")); } };
  const setField = <K extends keyof TriggerDraft>(key: K, value: TriggerDraft[K]) => setEditing(current => current ? { ...current, [key]: value } : current);
  const saveSchedule = () => {
    if (!editing) return;
    const parsed = triggerRequestFromDraft({ ...editing, automationId: trigger.automationId });
    if (!parsed.ok || !parsed.request.schedule) { setError(parsed.ok ? "Choose when it wakes." : parsed.error); return; }
    const schedule = parsed.request.schedule;
    void change(async () => { await updateTrigger.mutateAsync({ id: sentinel.id, triggerId: trigger.id, version: trigger.version, schedule }); setEditing(null); });
  };
  return <li className="space-y-1 px-4 py-3 text-sm">
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0"><span className="block truncate">{describeTrigger(trigger)}</span><span className="block truncate text-xs text-muted-foreground-1">{triggerKindLabel(trigger.kind)} · {trigger.enabled ? (trigger.nextFireAt ? `next ${displayTime(trigger.nextFireAt, trigger.schedule?.timezone)}` : "on") : "off"}{trigger.lastStatus ? ` · last ${trigger.lastStatus.replaceAll("_", " ")}` : ""}</span></span>
      <span className="flex shrink-0 items-center gap-2">
        <Switch aria-label={`${trigger.enabled ? "Turn off" : "Turn on"} ${describeTrigger(trigger)}`} checked={trigger.enabled} disabled={readOnly || sentinel.status === "archived" || updateTrigger.isPending} onCheckedChange={next => { if (next) onEnable(trigger); else void change(() => updateTrigger.mutateAsync({ id: sentinel.id, triggerId: trigger.id, version: trigger.version, enabled: false })); }} />
        {!readOnly && trigger.kind === "schedule" && trigger.schedule && <Button type="button" size="xs" variant="ghost" aria-expanded={editing !== null} onClick={() => setEditing(current => current ? null : draftFromSchedule(trigger.schedule!, trigger.automationId))}>{editing ? "Close" : "Edit"}</Button>}
        {!readOnly && <Button type="button" size="xs" variant="ghost" disabled={removeTrigger.isPending} onClick={() => void change(() => removeTrigger.mutateAsync({ id: sentinel.id, triggerId: trigger.id }))}>Remove</Button>}
      </span>
    </div>
    {editing && <div className="space-y-3 pt-2" data-slot="schedule-editor">
      <ScheduleFields draft={editing} set={setField} idPrefix={`schedule-${trigger.id}`} />
      <div className="flex items-center gap-2"><Button type="button" size="sm" variant="secondary" disabled={updateTrigger.isPending} onClick={saveSchedule}>{updateTrigger.isPending ? "Saving" : "Save schedule"}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
    </div>}
    {trigger.lastError && <p className="text-xs text-destructive">{trigger.lastError}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </li>;
}

/** Triggers start runs of this Sentinel's automations. Turning one on needs an explicit review of what it will launch. */
function SentinelTriggers({ sentinel, readOnly, automations }: { sentinel: Sentinel; readOnly: boolean; automations: SentinelAutomation[] }) {
  const triggers = useSentinelTriggers(sentinel.id);
  const [adding, setAdding] = useState(false);
  const { updateTrigger } = useSentinelMutations();
  const [reviewing, setReviewing] = useState<SentinelTrigger | null>(null);
  const [error, setError] = useState("");
  const confirm = async () => {
    if (!reviewing) return;
    setError("");
    try { await updateTrigger.mutateAsync({ id: sentinel.id, triggerId: reviewing.id, version: reviewing.version, enabled: true }); setReviewing(null); } catch (cause) { setError(errorText(cause, "Unable to turn the trigger on.")); }
  };
  return <Section title="Triggers" action={!readOnly && sentinel.status !== "archived" && !triggers.error ? <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(true)}>Add trigger</Button> : undefined}>
    {triggers.isLoading ? <LoadingState label="Loading triggers" /> : triggers.error ? <p className="text-sm text-muted-foreground-1">Triggers aren't available on this engine.</p> : <>
      {(triggers.data?.triggers ?? []).length === 0
        ? <EmptyState variant="inline" title="No triggers yet" />
        : <ul className="divide-y-[0.5px] divide-border-1 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card">{triggers.data!.triggers.map(trigger => <TriggerRow key={trigger.id} sentinel={sentinel} trigger={trigger} readOnly={readOnly} onEnable={setReviewing} />)}</ul>}
    </>}
    <AddTriggerDialog sentinel={sentinel} automations={automations} open={adding} onOpenChange={setAdding} />
    <Dialog open={reviewing !== null} onOpenChange={next => { if (!next) { setReviewing(null); setError(""); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Turn on this trigger?</DialogTitle><DialogDescription>{reviewing ? describeTrigger(reviewing) : ""}</DialogDescription></DialogHeader>
        <p className="text-sm">Each time it fires, {sentinel.name} wakes up and takes a turn in its thread, .</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setReviewing(null)}>Cancel</Button><Button type="button" variant="secondary" disabled={updateTrigger.isPending} onClick={() => void confirm()}>{updateTrigger.isPending ? "Turning on" : "Approve and turn on"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </Section>;
}

export function SentinelAutomations({ sentinel, readOnly = false }: { sentinel: Sentinel; readOnly?: boolean }) {
  const owned = useSentinelAutomations(sentinel.id);
  const presets = useSentinelPresets();
  const create = useCreateAutomation();
  const [search, setSearch] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const workflowId = search.get("workflow");
  const open = (id: string | null) => setSearch(previous => { const next = new URLSearchParams(previous); if (id) next.set("workflow", id); else next.delete("workflow"); return next; });
  const { createTrigger } = useSentinelMutations();
  const setUp = (item: SentinelPresetAutomation) => {
    if (!item.templateId) return;
    const schedule = item.trigger.kind === "schedule" ? suggestedSchedule(item.trigger.cadence, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") : undefined;
    void create.fromTemplate(item.templateId, { ownerSentinelId: sentinel.id, runIn: item.runIn })
      .then(async definition => {
        // The suggested schedule is added switched off; enabling it is the reviewed step.
        if (schedule) await createTrigger.mutateAsync({ id: sentinel.id, automationId: definition.id, kind: "schedule", schedule }).catch(cause => toast({ title: "The automation was added without its schedule", description: errorText(cause, "Add a trigger from the automation."), kind: "error" }));
        open(definition.id);
      })
      .catch(cause => toast({ title: "Unable to set up the automation", description: errorText(cause, "Try again."), kind: "error" }));
  };
  const preset = presets.data?.find(item => item.id === sentinel.role);
  const added = addedSuggestions(preset?.suggestedAutomations ?? [], (owned.data ?? []).flatMap(item => item.template ? [item.template.id] : []));
  if (workflowId) return <AutomationEditor workflowId={workflowId} onClose={() => open(null)} />;
  return <div className="space-y-8">
    <Section title="Automations" action={readOnly ? undefined : <Button size="xs" variant="secondary" onClick={() => setCreating(true)}><Plus aria-hidden="true" />New automation</Button>}>
      {owned.isLoading ? <LoadingState label="Loading automations" /> : (owned.data ?? []).length === 0
        ? <EmptyState title="No automations yet" />
        : <ul className="divide-y-[0.5px] divide-border-1 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card">
          {owned.data!.map(item => <li key={item.id}><button type="button" onClick={() => open(item.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm outline-none ui-row-hover focus-visible:outline-ring-inset"><span className="min-w-0 truncate">{item.name}</span>{item.target && <span className="truncate text-xs text-muted-foreground-1">{item.target}</span>}</button></li>)}
        </ul>}
    </Section>
    {(owned.data ?? []).length > 0 && <SentinelTriggers sentinel={sentinel} readOnly={readOnly} automations={owned.data ?? []} />}
    {preset && preset.suggestedAutomations.length > 0 && <Section title="Suggested">
      <ul className="divide-y-[0.5px] divide-border-1 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)]">
        {preset.suggestedAutomations.map((item, index) => <li key={item.name} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="min-w-0"><span className="block truncate">{item.name}</span><span className="text-xs text-muted-foreground-1">{item.trigger.kind === "schedule" ? item.trigger.cadence : item.trigger.kind}</span></span>
          {item.templateId && !added[index]
            ? <Button size="sm" variant="secondary" disabled={readOnly} onClick={() => setUp(item)}>Set up</Button>
            : <Badge variant={added[index] ? "success" : "neutral"}>{added[index] ? "Added" : "Manual"}</Badge>}
        </li>)}
      </ul>
    </Section>}
    <NewAutomationDialog open={creating} onOpenChange={setCreating} sentinels={[sentinel]} sentinelId={sentinel.id} onCreated={(_, id) => open(id)} />
  </div>;
}

/** What the Sentinel did, newest first: one line per turn with its cause. Everything happened in its one thread. */
export function AgentActivity({ sentinel }: { sentinel: Sentinel }) {
  const query = useAgentTurns(sentinel.id);
  if (query.isLoading) return <LoadingState label="Loading activity" />;
  if (query.error) return <p role="alert" className="text-sm text-destructive">{errorText(query.error, "Unable to load activity.")}</p>;
  if (!query.data?.length) return <EmptyState variant="inline" title="Nothing yet" body="Its turns show here, whether a trigger or you started them." />;
  return <ul className="divide-y-[0.5px] divide-border-1 overflow-hidden rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card">
    {query.data.slice(0, 12).map(item => {
      const when = item.startedAt ?? item.queuedAt;
      return <li key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
        <span data-slot="cause-chip" className="w-16 flex-none rounded-md bg-secondary px-1.5 py-px text-center text-[11px] leading-4 font-medium text-muted-foreground-1">{CAUSE_LABEL[item.origin]}</span>
        <span className="min-w-0 flex-1"><span className="block truncate">{turnLabel(item)}</span>{(item.error || item.skippedReason) && <span className={item.status === "failed" ? "block truncate text-xs text-destructive" : "block truncate text-xs text-muted-foreground-1"}>{item.skippedReason ?? item.error}</span>}</span>
        <Badge variant={TURN_TONE[item.status]}>{item.status}</Badge>
        {item.startedAt && item.finishedAt && <span className="w-12 text-right text-xs tabular-nums text-muted-foreground-1">{workedFor(Date.parse(item.finishedAt) - Date.parse(item.startedAt))}</span>}
        {item.costUsd !== undefined && <span className="w-12 text-right text-xs tabular-nums text-muted-foreground-1">${item.costUsd.toFixed(2)}</span>}
        <span className="w-8 text-right text-xs tabular-nums text-muted-foreground-2">{when ? ago(when) || "now" : ""}</span>
        {/* Work from before the standing thread (or with it turned off) ran in its own thread: keep it reachable. */}
        {item.sessionId && item.sessionId !== sentinel.homeMissionId && <Button size="xs" variant="ghost" render={<Link to={chatHref(item.sessionId)!} />}>Open</Button>}
      </li>;
    })}
  </ul>;
}

export function SentinelSettings({ sentinel, readOnly, onClose }: { sentinel: Sentinel; readOnly: boolean; onClose?: () => void }) {
  const { update, remove } = useSentinelMutations();
  const navigate = useNavigate();
  const [form, setForm] = useState<SentinelFormState>(() => formFromSentinel(sentinel));
  const [memory, setMemory] = useState({ enabled: sentinel.memory.enabled });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(formFromSentinel(sentinel)) || memory.enabled !== sentinel.memory.enabled;
  const archived = sentinel.status === "archived";
  const save = async () => {
    const parsed = fieldsFromForm(form);
    if (!parsed.ok) { setError(parsed.error); return; }
    setError(""); setSaved(false);
    try { await update.mutateAsync({ id: sentinel.id, version: sentinel.version, fields: { ...parsed.fields, memory } }); setSaved(true); } catch (cause) { setError(errorText(cause, "Unable to save settings.")); }
  };
  const archive = async () => {
    setError("");
    try {
      await update.mutateAsync({ id: sentinel.id, version: sentinel.version, fields: { status: "archived" } });
      setConfirmArchive(false);
      toast({ title: `${sentinel.name} archived`, kind: "success" });
      onClose?.();
    } catch (cause) { setConfirmArchive(false); setError(errorText(cause, "Unable to archive.")); }
  };
  const destroy = async () => {
    try { await remove.mutateAsync({ id: sentinel.id, version: sentinel.version }); onClose?.(); navigate("/sentinels"); } catch (cause) { setConfirmDelete(false); setError(errorText(cause, "Unable to delete.")); }
  };
  return <div className="space-y-8">
    {archived && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-card) bg-muted/50 px-4 py-3 text-sm"><span>Archived. It is hidden from the list, does not run and cannot be turned back on.</span></div>}
    <SentinelFields form={form} onChange={next => { setForm(next); setSaved(false); }} disabled={readOnly || archived} />
    <Section title="Memory">
      <div className="space-y-3 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium" id="sentinel-memory-enabled">Use memory</p>
          <Switch aria-labelledby="sentinel-memory-enabled" checked={memory.enabled} disabled={readOnly || archived} onCheckedChange={value => { setMemory({ enabled: value }); setSaved(false); }} />
        </div>
      </div>
    </Section>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center gap-3">
      <Button type="button" variant="secondary" disabled={readOnly || archived || !dirty || update.isPending} onClick={() => void save()}>{update.isPending ? "Saving" : "Save changes"}</Button>
      {saved && <span role="status" className="text-sm text-muted-foreground-1">Saved</span>}
    </div>
    {!readOnly && <Section title="Remove">
      <div className="flex flex-wrap gap-2">
        {!archived && <Button type="button" variant="secondary" disabled={update.isPending} onClick={() => setConfirmArchive(true)}>Archive</Button>}
        <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)}>{v("Delete {sentinel}")}</Button>
      </div>
    </Section>}
    <ConfirmDialog open={confirmArchive} onOpenChange={setConfirmArchive} pending={update.isPending} title={`Archive ${sentinel.name}?`} description="It stops running, leaves the list and cannot be turned back on."
      confirmLabel="Archive" onConfirm={() => void archive()} />
    <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Delete {sentinel.name}?</DialogTitle><DialogDescription>Its instructions, memory and activity history are removed. Threads it started stay.</DialogDescription></DialogHeader>
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button type="button" variant="destructive" disabled={remove.isPending} onClick={() => void destroy()}>Delete</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

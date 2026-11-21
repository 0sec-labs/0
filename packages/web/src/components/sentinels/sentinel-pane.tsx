import { useState } from "react";
import { Clock, GitPullRequest, Play, Plus } from "lucide-react";
import { errorText } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { displayTime } from "@/lib/display-time";
import { cn } from "@/lib/utils";
import { useAgentTurns, useSentinelAutomations, useSentinelFiles, useSentinelMutations, useSentinelTriggers } from "@/sentinels/api";
import { DEFAULT_FILES, NEEDS_REVIEW_COPY, describeTrigger, draftFromSchedule, presentStatus, triggerRequestFromDraft, type Sentinel, type SentinelTrigger, type TriggerDraft } from "@/sentinels/model";
import { AddTriggerDialog } from "./add-trigger-dialog";
import { ScheduleFields } from "./schedule-fields";
import { SentinelDocument } from "./sentinel-document";

const KIND_ICON = { schedule: Clock, "github-pr": GitPullRequest, manual: Play } as const;
const WEEK = 7 * 86_400_000;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-2"><h2 className="text-xs font-medium text-muted-foreground-1">{title}</h2>{children}</section>;
}

function StatusLine({ sentinel, readOnly }: { sentinel: Sentinel; readOnly: boolean }) {
  const { setPaused, acknowledge } = useSentinelMutations();
  const [error, setError] = useState("");
  const status = presentStatus(sentinel);
  const archived = sentinel.status === "archived";
  const paused = sentinel.status === "paused";
  const run = async (action: () => Promise<unknown>, fallback: string) => { setError(""); try { await action(); } catch (cause) { setError(errorText(cause, fallback)); } };
  const decisions = sentinel.attention?.pendingDecisions ?? 1;
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium"><span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", status.needsYou || status.needsReview ? "bg-amber-500" : status.label === "Active" ? "bg-emerald-500" : "bg-muted-foreground-3")} />{status.label}</span>
      {!readOnly && !archived && <Button type="button" variant="secondary" size="xs" disabled={setPaused.isPending} onClick={() => void run(() => setPaused.mutateAsync({ id: sentinel.id, paused: !paused, version: sentinel.version }), "Unable to change status.")}>{paused ? "Resume" : "Pause"}</Button>}
    </div>
    {status.needsReview && <div role="status" className="space-y-2 rounded-md bg-amber-500/10 p-2.5 text-xs">
      <p>{sentinel.attention?.reason ?? NEEDS_REVIEW_COPY}</p>
      {!readOnly && !archived && <Button type="button" size="xs" variant="secondary" disabled={acknowledge.isPending} onClick={() => void run(() => acknowledge.mutateAsync({ id: sentinel.id, version: sentinel.version }), "Unable to acknowledge.")}>{acknowledge.isPending ? "Acknowledging" : "Acknowledge"}</Button>}
    </div>}
    {status.needsYou && <p role="status" className="text-xs text-muted-foreground-1">Waiting on {decisions} decision{decisions === 1 ? "" : "s"} from you in the thread.</p>}
    {archived && <p className="text-xs text-muted-foreground-1">Archived. It does not wake on its own.</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

function TriggerRow({ sentinel, trigger, readOnly, onEnable }: { sentinel: Sentinel; trigger: SentinelTrigger; readOnly: boolean; onEnable: (trigger: SentinelTrigger) => void }) {
  const { updateTrigger, removeTrigger } = useSentinelMutations();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TriggerDraft | null>(null);
  const Icon = KIND_ICON[trigger.kind];
  const locked = readOnly || sentinel.status === "archived";
  const change = async (run: () => Promise<unknown>) => { setError(""); try { await run(); } catch (cause) { setError(errorText(cause, "Unable to change the trigger.")); } };
  const setField = <K extends keyof TriggerDraft>(key: K, value: TriggerDraft[K]) => setEditing(current => current ? { ...current, [key]: value } : current);
  const saveSchedule = () => {
    if (!editing) return;
    const parsed = triggerRequestFromDraft({ ...editing, automationId: trigger.automationId });
    if (!parsed.ok || !parsed.request.schedule) { setError(parsed.ok ? "Choose when it wakes." : parsed.error); return; }
    const schedule = parsed.request.schedule;
    void change(async () => { await updateTrigger.mutateAsync({ id: sentinel.id, triggerId: trigger.id, version: trigger.version, schedule }); setEditing(null); });
  };
  const when = !trigger.enabled ? "Off" : trigger.nextFireAt ? `Next ${displayTime(trigger.nextFireAt, trigger.schedule?.timezone)}` : trigger.kind === "github-pr" ? "Watching" : "On";
  return <li className="py-2">
    <div className="flex items-center gap-2.5">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-icon-muted" />
      <button type="button" aria-expanded={open} onClick={() => setOpen(current => !current)} className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:outline-ring-inset">
        <span className="block truncate text-sm">{describeTrigger(trigger)}</span>
        <span className="block truncate text-xs text-muted-foreground-1">{when}</span>
      </button>
      <Switch aria-label={`${trigger.enabled ? "Turn off" : "Turn on"} ${describeTrigger(trigger)}`} checked={trigger.enabled} disabled={locked || updateTrigger.isPending}
        onCheckedChange={next => { if (next) onEnable(trigger); else void change(() => updateTrigger.mutateAsync({ id: sentinel.id, triggerId: trigger.id, version: trigger.version, enabled: false })); }} />
    </div>
    {open && <div className="space-y-2 pt-2 pl-6">
      {trigger.lastStatus && <p className="text-xs text-muted-foreground-1">Last: {trigger.lastStatus.replaceAll("_", " ")}</p>}
      {trigger.lastError && <p className="text-xs text-destructive">{trigger.lastError}</p>}
      {editing && <div className="space-y-3" data-slot="schedule-editor">
        <ScheduleFields draft={editing} set={setField} idPrefix={`schedule-${trigger.id}`} />
        <div className="flex items-center gap-1.5"><Button type="button" size="xs" variant="secondary" disabled={updateTrigger.isPending} onClick={saveSchedule}>{updateTrigger.isPending ? "Saving" : "Save"}</Button><Button type="button" size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
      </div>}
      {!locked && !editing && <div className="flex items-center gap-1.5">
        {trigger.kind === "schedule" && trigger.schedule && <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(draftFromSchedule(trigger.schedule!, trigger.automationId))}>Edit</Button>}
        <Button type="button" size="xs" variant="ghost" disabled={removeTrigger.isPending} onClick={() => void change(() => removeTrigger.mutateAsync({ id: sentinel.id, triggerId: trigger.id }))}>Remove</Button>
      </div>}
    </div>}
    {error && <p role="alert" className="pt-1 pl-6 text-xs text-destructive">{error}</p>}
  </li>;
}

function Triggers({ sentinel, readOnly }: { sentinel: Sentinel; readOnly: boolean }) {
  const triggers = useSentinelTriggers(sentinel.id);
  const automations = useSentinelAutomations(sentinel.id);
  const { updateTrigger } = useSentinelMutations();
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState<SentinelTrigger | null>(null);
  const [error, setError] = useState("");
  const confirm = async () => {
    if (!reviewing) return;
    setError("");
    try { await updateTrigger.mutateAsync({ id: sentinel.id, triggerId: reviewing.id, version: reviewing.version, enabled: true }); setReviewing(null); } catch (cause) { setError(errorText(cause, "Unable to turn the trigger on.")); }
  };
  const list = triggers.data?.triggers ?? [];
  const canAdd = !readOnly && sentinel.status !== "archived" && !triggers.error;
  return <Section title="Triggers">
    {triggers.error ? <p className="text-sm text-muted-foreground-1">Triggers aren't available on this computer.</p>
      : list.length > 0 ? <ul className="divide-y-[0.5px] divide-border-1">{list.map(trigger => <TriggerRow key={trigger.id} sentinel={sentinel} trigger={trigger} readOnly={readOnly} onEnable={setReviewing} />)}</ul>
      : triggers.isLoading ? null : <p className="text-sm text-muted-foreground-1">Nothing wakes it yet. You can still write to it.</p>}
    {canAdd && <Button type="button" variant="ghost" size="xs" className="-ml-2" onClick={() => setAdding(true)}><Plus aria-hidden="true" />Add trigger</Button>}
    <AddTriggerDialog sentinel={sentinel} automations={automations.data ?? []} open={adding} onOpenChange={setAdding} />
    <Dialog open={reviewing !== null} onOpenChange={next => { if (!next) { setReviewing(null); setError(""); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Turn on this trigger?</DialogTitle><DialogDescription>{reviewing ? describeTrigger(reviewing) : ""}</DialogDescription></DialogHeader>
        <p className="text-sm">Each time it fires, {sentinel.name} wakes up and takes a turn in its thread.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setReviewing(null)}>Cancel</Button><Button type="button" variant="secondary" disabled={updateTrigger.isPending} onClick={() => void confirm()}>{updateTrigger.isPending ? "Turning on" : "Turn on"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </Section>;
}

function Week({ sentinel }: { sentinel: Sentinel }) {
  const turns = useAgentTurns(sentinel.id);
  if (!turns.data) return null;
  const week = turns.data.filter(item => item.status !== "skipped" && Date.now() - Date.parse(item.startedAt ?? item.queuedAt ?? "") < WEEK);
  const failed = week.filter(item => item.status === "failed").length;
  const cost = week.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
  return <Section title="Last 7 days"><p className="text-sm tabular-nums text-muted-foreground-1" data-slot="week">{week.length} {week.length === 1 ? "turn" : "turns"} · {failed} failed · ${cost.toFixed(2)}</p></Section>;
}

/** Other files the Sentinel wrote (reports, handoffs). Nothing shows until one exists. */
function OtherFiles({ sentinel, readOnly }: { sentinel: Sentinel; readOnly: boolean }) {
  const files = useSentinelFiles(sentinel.id);
  const extra = (files.data?.files ?? []).map(file => file.path).filter(path => !(DEFAULT_FILES as readonly string[]).includes(path));
  if (extra.length === 0) return null;
  return <Section title="Files">
    <div className="space-y-4">{extra.map(path => <div key={path} className="space-y-1"><h3 className="truncate text-sm font-medium">{path}</h3><SentinelDocument sentinelId={sentinel.id} path={path} empty="Empty." readOnly={readOnly} /></div>)}</div>
  </Section>;
}

/** The right-hand pane of a Sentinel's thread: status, triggers, instructions, notes and the last week in one line. */
export function SentinelPane({ sentinel, readOnly }: { sentinel: Sentinel; readOnly: boolean }) {
  const locked = readOnly || sentinel.status === "archived";
  return <div className="flex flex-col gap-6 p-4" data-testid="agent-pane">
    <StatusLine sentinel={sentinel} readOnly={readOnly} />
    <Triggers sentinel={sentinel} readOnly={readOnly} />
    <Section title="Instructions"><SentinelDocument sentinelId={sentinel.id} path="AGENTS.md" empty="No instructions yet." readOnly={locked} /></Section>
    <Section title="Notes"><SentinelDocument sentinelId={sentinel.id} path="NOTES.md" empty="Nothing saved yet." readOnly={locked} /></Section>
    <OtherFiles sentinel={sentinel} readOnly={locked} />
    <Week sentinel={sentinel} />
  </div>;
}

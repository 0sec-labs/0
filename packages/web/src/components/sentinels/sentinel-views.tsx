import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { v } from "@/lib/vocabulary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { EmptyState, LoadingState } from "@/components/state-panel";
import { formatRelativeAge } from "@/lib/relative-time";
import { useSentinelActivations, useSentinelAutomations, useSentinelBudget, useSentinelTriggers, useSentinelFiles, useSentinelMutations, useSentinelPresets } from "@/sentinels/api";
import { DEFAULT_FILES, NEEDS_REVIEW_COPY, activationLabel, budgetMeters, describeTrigger, perRunCaps, triggerKindLabel, fieldsFromForm, formFromSentinel, presentStatus, type Sentinel, type SentinelActivation, type SentinelFormState, type SentinelTrigger } from "@/sentinels/model";
import { SentinelFields } from "./sentinel-fields";
import { RunSentinelDialog } from "./run-sentinel-dialog";

const ACTIVATION_TONE: Record<SentinelActivation["status"], "success" | "warning" | "danger" | "info" | "neutral"> = { queued: "neutral", running: "info", completed: "success", failed: "danger", cancelled: "neutral", skipped: "neutral" };
const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const ago = (iso: string) => formatRelativeAge(Date.parse(iso));
const chatHref = (missionId: string | null | undefined) => (missionId ? `/console/${encodeURIComponent(missionId)}` : undefined);

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <section className="space-y-3"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">{title}</h2>{action}</div>{children}</section>;
}

export function SentinelOverview({ sentinel, readOnly }: { sentinel: Sentinel; readOnly: boolean }) {
  const { setPaused, acknowledge } = useSentinelMutations();
  const activations = useSentinelActivations(sentinel.id);
  const files = useSentinelFiles(sentinel.id);
  const navigate = useNavigate();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const status = presentStatus(sentinel);
  const archived = sentinel.status === "archived";
  const paused = sentinel.status === "paused";
  const week = (activations.data ?? []).filter(item => Date.now() - Date.parse(item.startedAt) < 7 * 86_400_000);
  const cost = week.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
  const home = chatHref(sentinel.homeMissionId);
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
      <span className="min-w-0 flex-1">{sentinel.attention?.reason ? `${sentinel.attention.reason} ` : ""}{NEEDS_REVIEW_COPY}</span>
      {!readOnly && !archived && <Button type="button" size="sm" variant="secondary" disabled={acknowledge.isPending} onClick={() => void acknowledgeReview()}>{acknowledge.isPending ? "Acknowledging" : "Acknowledge"}</Button>}
    </div>}
    {!status.needsReview && sentinel.attention?.reason && <div role="status" className="rounded-(--radius-card) bg-amber-500/10 px-4 py-3 text-sm">{sentinel.attention.reason}</div>}
    {status.needsYou && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-card) bg-amber-500/10 px-4 py-3 text-sm">
      <span>{sentinel.name} is waiting on {sentinel.attention?.pendingDecisions ?? 1} decision{(sentinel.attention?.pendingDecisions ?? 1) === 1 ? "" : "s"} from you.</span>
      {home && <Button asChild size="sm" variant="secondary"><Link to={home}>Open chat</Link></Button>}
    </div>}
    <Section title="Status" action={<div className="flex items-center gap-2">
      <Button type="button" size="sm" variant="secondary" disabled={readOnly || archived || paused} onClick={() => setRunning(true)}>Run now</Button>
    </div>}>
      <div className="flex items-center justify-between gap-4 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-4">
        <div className="min-w-0"><p className="text-sm font-medium">{archived ? "Archived" : paused ? "Paused" : "Active"}</p><p className="text-xs text-muted-foreground-1">{archived ? "Archived Sentinels cannot run." : paused ? "Created paused. Resume it to allow runs." : "Running allowed within its scope and budget."}</p></div>
        <Switch aria-label={paused ? "Resume Sentinel" : "Pause Sentinel"} checked={sentinel.status === "active"} disabled={readOnly || archived || setPaused.isPending} onCheckedChange={() => void toggle()} />
      </div>
      {paused && <p className="text-xs text-muted-foreground-1">Run now needs an active Sentinel. Resume it first.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </Section>
    <SentinelBudgetCard sentinel={sentinel} />
    <Section title="Last 7 days">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["Runs", String(week.length)], ["Failed", String(week.filter(item => item.status === "failed").length)], ["Cost", `$${cost.toFixed(2)}`], ["Last run", activations.data?.[0] ? ago(activations.data[0].startedAt) || "now" : "Never"]].map(([label, value]) => <div key={label} className="rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-3"><dt className="text-xs text-muted-foreground-1">{label}</dt><dd className="mt-1 text-lg font-medium tabular-nums">{value}</dd></div>)}
      </dl>
    </Section>
    <Section title={`Files${files.data ? ` (${files.data.files.length})` : ""}`} action={<Button asChild size="xs" variant="ghost"><Link to="?view=files">Open files</Link></Button>}>
      <div className="grid gap-3 sm:grid-cols-3">
        {DEFAULT_FILES.map(path => {
          const file = files.data?.files.find(item => item.path === path);
          return <Link key={path} to="?view=files" className="flex h-36 flex-col gap-2 overflow-hidden rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-3 outline-none hover:bg-card-hover focus-visible:outline-ring-inset">
            <span className="flex-1 text-xs text-muted-foreground-1">{file ? `${file.bytes.toLocaleString()} bytes, revision ${file.revision}, edited ${ago(file.updatedAt) || "now"} by ${file.authorKind === "agent" ? "the sentinel" : "you"}` : "Empty"}</span>
            <span className="text-xs font-medium">{path}</span>
          </Link>;
        })}
      </div>
    </Section>
    {!home && !archived && <p className="text-sm text-muted-foreground-1">Its standing chat appears after the first run.</p>}
    {home && <Button asChild variant="secondary" size="sm" className="self-start"><Link to={home}>Open standing chat</Link></Button>}
    <RunSentinelDialog sentinel={sentinel} open={running} onOpenChange={setRunning} onStarted={missionId => { const href = chatHref(missionId); if (href) navigate(href); }} />
  </div>;
}

function SentinelBudgetCard({ sentinel }: { sentinel: Sentinel }) {
  const report = useSentinelBudget(sentinel.id);
  const meters = report.data ? budgetMeters(report.data) : [];
  return <Section title="Budget">
    <div className="space-y-3 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-4">
      {report.isLoading ? <LoadingState label="Loading budget" /> : report.error ? <p className="text-sm text-muted-foreground-1">Budget usage isn't available right now.</p> : <>
        {report.data?.pauseReason && <p role="status" className="text-sm">{report.data.pauseReason.message} Resume it to allow runs again.</p>}
        {meters.map(meter => <div key={meter.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm"><span>{meter.label}</span><span className="text-xs text-muted-foreground-1">{meter.used} of {meter.limit}</span></div>
          <div role="progressbar" aria-label={meter.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(meter.percent)} className="h-1 overflow-hidden rounded-full bg-secondary"><div className={meter.percent >= 90 ? "h-full bg-warning" : "h-full bg-primary"} style={{ width: `${meter.percent}%` }} /></div>
        </div>)}
        <p className="text-xs text-muted-foreground-1">Each run is capped at {perRunCaps((report.data?.budget ?? sentinel.budget))}. Totals cover the last 24 hours.</p>
      </>}
    </div>
  </Section>;
}

function TriggerRow({ sentinel, trigger, readOnly, onEnable }: { sentinel: Sentinel; trigger: SentinelTrigger; readOnly: boolean; onEnable: (trigger: SentinelTrigger) => void }) {
  const { updateTrigger, removeTrigger } = useSentinelMutations();
  const [error, setError] = useState("");
  const change = async (run: () => Promise<unknown>) => { setError(""); try { await run(); } catch (cause) { setError(errorText(cause, "Unable to change the trigger.")); } };
  return <li className="space-y-1 px-4 py-3 text-sm">
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0"><span className="block truncate">{describeTrigger(trigger)}</span><span className="block truncate text-xs text-muted-foreground-1">{triggerKindLabel(trigger.kind)} · {trigger.enabled ? (trigger.nextFireAt ? `next ${new Date(trigger.nextFireAt).toLocaleString()}` : "on") : "off"}{trigger.lastStatus ? ` · last ${trigger.lastStatus}` : ""}</span></span>
      <span className="flex shrink-0 items-center gap-2">
        <Switch aria-label={`${trigger.enabled ? "Turn off" : "Turn on"} ${describeTrigger(trigger)}`} checked={trigger.enabled} disabled={readOnly || sentinel.status === "archived" || updateTrigger.isPending} onCheckedChange={next => { if (next) onEnable(trigger); else void change(() => updateTrigger.mutateAsync({ id: sentinel.id, triggerId: trigger.id, version: trigger.version, enabled: false })); }} />
        {!readOnly && <Button type="button" size="xs" variant="ghost" disabled={removeTrigger.isPending} onClick={() => void change(() => removeTrigger.mutateAsync({ id: sentinel.id, triggerId: trigger.id }))}>Remove</Button>}
      </span>
    </div>
    {trigger.lastError && <p className="text-xs text-destructive">{trigger.lastError}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </li>;
}

/** Triggers start runs of this Sentinel's automations. Turning one on needs an explicit review of what it will launch. */
function SentinelTriggers({ sentinel, readOnly }: { sentinel: Sentinel; readOnly: boolean }) {
  const triggers = useSentinelTriggers(sentinel.id);
  const { updateTrigger } = useSentinelMutations();
  const [reviewing, setReviewing] = useState<SentinelTrigger | null>(null);
  const [error, setError] = useState("");
  const unavailable = (triggers.data?.kinds ?? []).filter(kind => !kind.available);
  const confirm = async () => {
    if (!reviewing) return;
    setError("");
    try { await updateTrigger.mutateAsync({ id: sentinel.id, triggerId: reviewing.id, version: reviewing.version, enabled: true }); setReviewing(null); } catch (cause) { setError(errorText(cause, "Unable to turn the trigger on.")); }
  };
  return <Section title="Triggers">
    {triggers.isLoading ? <LoadingState label="Loading triggers" /> : triggers.error ? <p className="text-sm text-muted-foreground-1">Triggers aren't available on this engine.</p> : <>
      {(triggers.data?.triggers ?? []).length === 0
        ? <EmptyState title="No triggers yet" body="A trigger starts one of this automation's runs on a schedule or an event. New triggers start off." />
        : <ul className="divide-y-[0.5px] divide-border-1 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card">{triggers.data!.triggers.map(trigger => <TriggerRow key={trigger.id} sentinel={sentinel} trigger={trigger} readOnly={readOnly} onEnable={setReviewing} />)}</ul>}
      {unavailable.length > 0 && <ul aria-label="Unavailable trigger types" className="space-y-1 text-xs text-muted-foreground-1">{unavailable.map(kind => <li key={kind.kind}><span className="font-medium text-foreground">{triggerKindLabel(kind.kind)}</span> is not available yet{kind.reason ? `. ${kind.reason}` : "."}</li>)}</ul>}
    </>}
    <Dialog open={reviewing !== null} onOpenChange={next => { if (!next) { setReviewing(null); setError(""); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Turn on this trigger?</DialogTitle><DialogDescription>{reviewing ? describeTrigger(reviewing) : ""}</DialogDescription></DialogHeader>
        <p className="text-sm">Each time it fires, {sentinel.name} starts a run on its own with {perRunCaps(sentinel.budget)}, within its scope and autonomy. Runs count against its daily budget.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setReviewing(null)}>Cancel</Button><Button type="button" variant="accent" disabled={updateTrigger.isPending} onClick={() => void confirm()}>{updateTrigger.isPending ? "Turning on" : "Approve and turn on"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </Section>;
}

export function SentinelAutomations({ sentinel, readOnly = false }: { sentinel: Sentinel; readOnly?: boolean }) {
  const owned = useSentinelAutomations(sentinel.id);
  const presets = useSentinelPresets();
  const preset = presets.data?.find(item => item.id === sentinel.role);
  const ownedIds = new Set((owned.data ?? []).map(item => item.id));
  return <div className="space-y-8">
    <Section title="Owned automations" action={<Button asChild size="xs" variant="ghost"><Link to="/automations">Open Automations<ExternalLink aria-hidden="true" /></Link></Button>}>
      {owned.isLoading ? <LoadingState label="Loading automations" /> : (owned.data ?? []).length === 0
        ? <EmptyState title="No automations yet" body={v("Triggers and schedules live in Automations. An automation owned by this {sentinel} shares its budget and memory.")} />
        : <ul className="divide-y-[0.5px] divide-border-1 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card">
          {owned.data!.map(item => <li key={item.id}><Link to={`/automations?workflow=${encodeURIComponent(item.id)}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm outline-none hover:bg-card-hover focus-visible:outline-ring-inset"><span className="min-w-0 truncate">{item.name}</span>{item.target && <span className="truncate text-xs text-muted-foreground-1">{item.target}</span>}</Link></li>)}
        </ul>}
    </Section>
    <SentinelTriggers sentinel={sentinel} readOnly={readOnly} />
    {preset && preset.suggestedAutomations.length > 0 && <Section title="Suggested">
      <ul className="divide-y-[0.5px] divide-border-1 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)]">
        {preset.suggestedAutomations.map(item => <li key={item.name} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="min-w-0"><span className="block truncate">{item.name}</span><span className="text-xs text-muted-foreground-1">{item.trigger.kind === "schedule" ? item.trigger.cadence : item.trigger.kind}</span></span>
          {item.available && item.templateId && !ownedIds.has(item.templateId)
            ? <Button asChild size="sm" variant="secondary"><Link to={`/automations?template=${encodeURIComponent(item.templateId)}`}>Set up</Link></Button>
            : <Badge variant="neutral">{item.available ? "Manual" : "Needs engine work"}</Badge>}
        </li>)}
      </ul>
    </Section>}
  </div>;
}

export function SentinelActivations({ sentinel }: { sentinel: Sentinel }) {
  const query = useSentinelActivations(sentinel.id);
  if (query.isLoading) return <LoadingState label="Loading activations" />;
  if (query.error) return <p role="alert" className="text-sm text-destructive">{errorText(query.error, "Unable to load activations.")}</p>;
  if (!query.data?.length) return <EmptyState title="No activations yet" body="Waiting for its first trigger. Run it now to see how it works." />;
  return <ul className="divide-y-[0.5px] divide-border-1 overflow-hidden rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card">
    {query.data.map(item => {
      const href = chatHref(item.missionId);
      return <li key={item.id} className="flex items-center gap-3 px-4 py-3 text-sm">
        <Badge variant={ACTIVATION_TONE[item.status]}>{item.status}</Badge>
        <span className="min-w-0 flex-1"><span className="block truncate">{activationLabel(item)}<span className="ml-2 text-xs text-muted-foreground-1">version {item.sentinelVersion}</span></span>{item.error && <span className="block truncate text-xs text-destructive">{item.error}</span>}</span>
        {item.costUsd !== undefined && <span className="text-xs tabular-nums text-muted-foreground-1">${item.costUsd.toFixed(2)}</span>}
        <span className="w-8 text-right text-xs tabular-nums text-muted-foreground-2">{ago(item.startedAt) || "now"}</span>
        {href && <Button asChild size="xs" variant="ghost"><Link to={href}>Open</Link></Button>}
      </li>;
    })}
  </ul>;
}

export function SentinelSettings({ sentinel, readOnly }: { sentinel: Sentinel; readOnly: boolean }) {
  const { update, remove } = useSentinelMutations();
  const navigate = useNavigate();
  const [form, setForm] = useState<SentinelFormState>(() => formFromSentinel(sentinel));
  const [memory, setMemory] = useState(sentinel.memory);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const archived = sentinel.status === "archived";
  const save = async () => {
    const parsed = fieldsFromForm(form, sentinel);
    if (!parsed.ok) { setError(parsed.error); return; }
    setError(""); setSaved(false);
    try { await update.mutateAsync({ id: sentinel.id, version: sentinel.version, fields: { ...parsed.fields, memory } }); setSaved(true); } catch (cause) { setError(errorText(cause, "Unable to save settings.")); }
  };
  const archive = async () => {
    setError("");
    try { await update.mutateAsync({ id: sentinel.id, version: sentinel.version, fields: { status: "archived" } }); } catch (cause) { setError(errorText(cause, "Unable to archive.")); }
  };
  const destroy = async () => {
    try { await remove.mutateAsync({ id: sentinel.id, version: sentinel.version }); navigate("/sentinels"); } catch (cause) { setConfirmDelete(false); setError(errorText(cause, "Unable to delete.")); }
  };
  return <div className="max-w-2xl space-y-8">
    <SentinelFields form={form} onChange={next => { setForm(next); setSaved(false); }} disabled={readOnly || archived} />
    <Section title="Memory">
      <div className="space-y-3 rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card p-4">
        {([["enabled", "Use saved notes", "Include NOTES.md in each run."], ["autoLearn", "Learn from runs", "Learned notes become reviewable only after you approve them."]] as const).map(([key, label, hint]) => <div key={key} className="flex items-center justify-between gap-4">
          <div><p className="text-sm font-medium" id={`sentinel-memory-${key}`}>{label}</p><p className="text-xs text-muted-foreground-1">{hint}</p></div>
          <Switch aria-labelledby={`sentinel-memory-${key}`} checked={memory[key]} disabled={readOnly || archived} onCheckedChange={value => { setMemory({ ...memory, [key]: value }); setSaved(false); }} />
        </div>)}
      </div>
    </Section>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center gap-3">
      <Button type="button" variant="accent" disabled={readOnly || archived || update.isPending} onClick={() => void save()}>{update.isPending ? "Saving" : "Save changes"}</Button>
      {saved && <span role="status" className="text-sm text-muted-foreground-1">Saved</span>}
    </div>
    {!readOnly && <Section title="Danger zone">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={archived || update.isPending} onClick={() => void archive()}>Archive</Button>
        <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)}>{v("Delete {sentinel}")}</Button>
      </div>
      <p className="text-xs text-muted-foreground-1">Archiving stops it for good; duplicate it to start again. Deleting removes its files and history.</p>
    </Section>}
    <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Delete {sentinel.name}?</DialogTitle><DialogDescription>Its charter, notes and activation history are removed. Chats it started stay.</DialogDescription></DialogHeader>
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button type="button" variant="destructive" disabled={remove.isPending} onClick={() => void destroy()}>Delete</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

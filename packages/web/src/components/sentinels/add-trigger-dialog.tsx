import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSentinelMutations } from "@/sentinels/api";
import { TRIGGER_FREQUENCIES, blankTriggerDraft, triggerRequestFromDraft, type Sentinel, type SentinelAutomation, type TriggerDraft } from "@/sentinels/model";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{label}</label>{children}</div>;
}

/** Adds a trigger to one of this Sentinel's automations. New triggers are created off; turning one on needs the approval dialog. */
export function AddTriggerDialog({ sentinel, automations, open, onOpenChange }: { sentinel: Sentinel; automations: SentinelAutomation[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { createTrigger } = useSentinelMutations();
  const [draft, setDraft] = useState<TriggerDraft>(() => blankTriggerDraft(automations[0]?.id));
  const [error, setError] = useState("");
  const set = <K extends keyof TriggerDraft>(key: K, value: TriggerDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const current = automations.some(item => item.id === draft.automationId) ? draft.automationId : automations[0]?.id ?? "";
  const submit = async () => {
    const parsed = triggerRequestFromDraft({ ...draft, automationId: current });
    if (!parsed.ok) { setError(parsed.error); return; }
    setError("");
    try { await createTrigger.mutateAsync({ id: sentinel.id, ...parsed.request }); onOpenChange(false); setDraft(blankTriggerDraft(current)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to add the trigger."); }
  };
  const kinds = [{ value: "schedule", label: "Schedule" }, { value: "github-pr", label: "GitHub pull request" }];
  return <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) setError(""); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>Add trigger</DialogTitle><DialogDescription>New triggers start off. You review and turn them on afterwards.</DialogDescription></DialogHeader>
      <div className="space-y-3">
        <Row label="Automation"><Select aria-label="Automation" value={current} onValueChange={value => set("automationId", value)} options={automations.map(item => ({ value: item.id, label: item.name }))} /></Row>
        <Row label="Type"><Select aria-label="Trigger type" value={draft.kind} onValueChange={value => set("kind", value as TriggerDraft["kind"])} options={kinds} /></Row>
        {draft.kind === "schedule" ? <>
          <Row label="Repeats"><Select aria-label="Repeats" value={draft.frequency} onValueChange={value => set("frequency", value as TriggerDraft["frequency"])} options={TRIGGER_FREQUENCIES.map(([value, label]) => ({ value, label }))} /></Row>
          {draft.frequency === "minutes" && <Row label="Every (minutes, 5 or more)" htmlFor="trigger-every"><Input id="trigger-every" type="number" min={5} max={1440} value={draft.every} onChange={event => set("every", event.target.value)} /></Row>}
          {draft.frequency === "weekly" && <Row label="Day"><Select aria-label="Day" value={draft.weekday} onValueChange={value => set("weekday", value)} options={WEEKDAYS.map((label, index) => ({ value: String(index), label }))} /></Row>}
          {["daily", "weekdays", "weekly"].includes(draft.frequency) && <Row label="Time" htmlFor="trigger-time"><Input id="trigger-time" type="time" value={draft.time} onChange={event => set("time", event.target.value)} /></Row>}
          {draft.frequency === "cron" && <Row label="Cron expression" htmlFor="trigger-cron"><Input id="trigger-cron" placeholder="0 9 * * 1" value={draft.cron} onChange={event => set("cron", event.target.value)} /></Row>}
          <Row label="Timezone" htmlFor="trigger-timezone"><Input id="trigger-timezone" value={draft.timezone} onChange={event => set("timezone", event.target.value)} /></Row>
        </> : <>
          <Row label="Repository" htmlFor="trigger-repo"><Input id="trigger-repo" placeholder="owner/name" value={draft.repo} onChange={event => set("repo", event.target.value)} /></Row>
          <Row label="Base branch (optional)" htmlFor="trigger-branch"><Input id="trigger-branch" value={draft.baseBranch} onChange={event => set("baseBranch", event.target.value)} /></Row>
        </>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" variant="accent" disabled={createTrigger.isPending || !automations.length} onClick={() => void submit()}>{createTrigger.isPending ? "Adding" : "Add trigger"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

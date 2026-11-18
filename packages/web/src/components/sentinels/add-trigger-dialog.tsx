import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import { FieldRow as Row, ScheduleFields } from "./schedule-fields";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSentinelMutations } from "@/sentinels/api";
import { blankTriggerDraft, triggerRequestFromDraft, type Sentinel, type SentinelAutomation, type TriggerDraft } from "@/sentinels/model";

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
      <DialogHeader><DialogTitle>Add trigger</DialogTitle></DialogHeader>
      <div className="space-y-3">
        <Row label="Automation"><Select aria-label="Automation" value={current} onValueChange={value => set("automationId", value)} options={automations.map(item => ({ value: item.id, label: item.name }))} /></Row>
        <Row label="Type"><Select aria-label="Trigger type" value={draft.kind} onValueChange={value => set("kind", value as TriggerDraft["kind"])} options={kinds} /></Row>
        {draft.kind === "schedule" ? <>
          <ScheduleFields draft={draft} set={set} />
        </> : <>
          <Row label="Repository" htmlFor="trigger-repo"><Input id="trigger-repo" placeholder="owner/name" value={draft.repo} onChange={event => set("repo", event.target.value)} /></Row>
          <Row label="Base branch (optional)" htmlFor="trigger-branch"><Input id="trigger-branch" value={draft.baseBranch} onChange={event => set("baseBranch", event.target.value)} /></Row>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><span id="trigger-comment-label" className="block text-sm">Comment on the pull request</span><span className="block text-xs text-muted-foreground-1">Posts one short summary and updates it on new commits. Off: results stay in this Sentinel's activity and thread.</span></div>
            <Switch aria-labelledby="trigger-comment-label" checked={draft.commentOnPr} onCheckedChange={value => set("commentOnPr", value)} />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><span id="trigger-forks-label" className="block text-sm">Include pull requests from forks</span><span className="block text-xs text-muted-foreground-1">Off: forks are skipped. On: read-only analysis of the diff, marked untrusted. Their code is never run.</span></div>
            <Switch aria-labelledby="trigger-forks-label" checked={draft.includeForks} onCheckedChange={value => set("includeForks", value)} />
          </div>
        </>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" variant="secondary" disabled={createTrigger.isPending || !automations.length} onClick={() => void submit()}>{createTrigger.isPending ? "Adding" : "Add trigger"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

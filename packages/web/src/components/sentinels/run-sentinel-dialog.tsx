import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useSentinelMutations } from "@/sentinels/api";
import { AUTONOMY_OPTIONS, TOOL_ACCESS_OPTIONS, type Sentinel } from "@/sentinels/model";

/** Explicit approval before a Sentinel acts. The request pins the reviewed version, so a stale review is refused. */
export function RunSentinelDialog({ sentinel, open, onOpenChange, onStarted }: { sentinel: Sentinel; open: boolean; onOpenChange: (open: boolean) => void; onStarted?: (missionId: string | undefined) => void }) {
  const { run } = useSentinelMutations();
  const [task, setTask] = useState("");
  const [error, setError] = useState("");
  const targets = [...sentinel.scope.targets, ...sentinel.scope.domains, ...sentinel.scope.repos];
  const start = async () => {
    setError("");
    try {
      const result = await run.mutateAsync({ id: sentinel.id, version: sentinel.version, task });
      onOpenChange(false); setTask("");
      onStarted?.(result.activation.missionId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to start the run."); }
  };
  return <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) setError(""); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Run {sentinel.name} now?</DialogTitle>
        <DialogDescription>This starts a new run in a chat. Review what it is allowed to do first.</DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground-1">Scope</dt><dd className="min-w-0 break-words">{targets.length ? targets.join(", ") : "Nothing in scope yet. It will ask before testing anything."}</dd>
        <dt className="text-muted-foreground-1">Autonomy</dt><dd>{AUTONOMY_OPTIONS.find(option => option.value === sentinel.autonomy)?.hint}</dd>
        <dt className="text-muted-foreground-1">Tool access</dt><dd>{TOOL_ACCESS_OPTIONS.find(option => option.value === sentinel.toolAccess)?.label}</dd>
        <dt className="text-muted-foreground-1">Production</dt><dd>{sentinel.scope.production ? "Allowed" : "Off"}</dd>
        <dt className="text-muted-foreground-1">Budget</dt><dd>Up to ${sentinel.budget.dailyUsd} a day, {sentinel.budget.maxRunsPerDay} runs a day</dd>
      </dl>
      <div className="space-y-1.5">
        <label htmlFor="sentinel-run-task" className="block text-sm font-medium">Task (optional)</label>
        <Textarea id="sentinel-run-task" rows={3} value={task} maxLength={4000} placeholder="Leave empty to run its standing job." onChange={event => setTask(event.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="button" variant="accent" disabled={run.isPending} onClick={() => void start()}>{run.isPending ? "Starting" : "Approve and run"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImpactAssessmentSchema, getFindingPriority } from "@0/shared/dist/finding-priority.js";
import type { ImpactAssessment } from "@0/shared";
import { useBackendApi } from "@/api";
import type { FindingRecord } from "@/types";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function FindingImpactEditor({ finding }: { finding: FindingRecord }) {
  const { updateFindingImpactAssessment, clearFindingImpactAssessment, client } = useBackendApi();
  const cache = useQueryClient();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState<ImpactAssessment["business_impact"]>("unassessed");
  const [affected, setAffected] = useState("");
  const [rationale, setRationale] = useState("");
  const resetDraft = () => {
    const parsed = ImpactAssessmentSchema.safeParse(finding.impactAssessment);
    setPriority(parsed.success && getFindingPriority(finding).assessed ? parsed.data.business_impact : "unassessed");
    setAffected(parsed.success ? parsed.data.blast_radius : "");
    setRationale(parsed.success ? parsed.data.rationale : "");
  };
  const mutation = useMutation({
    mutationFn: async () => {
      if (priority === "unassessed") return clearFindingImpactAssessment(finding.id);
      const existing = ImpactAssessmentSchema.safeParse(finding.impactAssessment);
      return updateFindingImpactAssessment(finding.id, ImpactAssessmentSchema.parse({
        reachability_tier: existing.success ? existing.data.reachability_tier : "unknown",
        weaponizability: existing.success ? existing.data.weaponizability : "unknown",
        business_impact: priority, blast_radius: affected.trim(), rationale: rationale.trim(), assessment_source: "provided",
      }));
    },
    onSuccess: async () => {
      client.signal.throwIfAborted();
      setOpen(false);
      await Promise.all([cache.invalidateQueries({ queryKey: ["dashboard"] }), cache.invalidateQueries({ queryKey: ["finding-family"] }), cache.invalidateQueries({ queryKey: ["scan-findings"] })]);
    },
  });
  const canSave = priority === "unassessed" || Boolean(affected.trim() && rationale.trim() && affected.length <= 4096 && rationale.length <= 1000);
  return <details open={open} onToggle={event => {
    const next = event.currentTarget.open;
    if (next && !open) { resetDraft(); mutation.reset(); }
    setOpen(next);
  }} className="rounded-xl px-3 py-2">
    <summary className="text-xs font-medium">Edit business impact</summary>
    <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); if (canSave && !mutation.isPending) mutation.mutate(); }}>
      <label className="block space-y-1 text-xs" htmlFor={`${id}-priority`}><span id={`${id}-priority-label`}>Business priority</span><select aria-labelledby={`${id}-priority-label`} id={`${id}-priority`} value={priority} disabled={mutation.isPending} onChange={event => setPriority(event.target.value as ImpactAssessment["business_impact"])} className="block w-full rounded-xl bg-muted px-3 py-2 text-sm"><option value="headline">Urgent</option><option value="notable">High</option><option value="modest">Moderate</option><option value="noise">Low</option><option value="unassessed">Not assessed</option></select></label>
      {priority !== "unassessed" && <><label className="block space-y-1 text-xs" htmlFor={`${id}-affected`}><span>Affected customers, data, or services</span><Textarea id={`${id}-affected`} value={affected} onChange={event => setAffected(event.target.value)} maxLength={4096} rows={2} disabled={mutation.isPending} required /></label><label className="block space-y-1 text-xs" htmlFor={`${id}-rationale`}><span>Why this matters</span><Textarea id={`${id}-rationale`} value={rationale} onChange={event => setRationale(event.target.value)} maxLength={1000} rows={3} disabled={mutation.isPending} required /></label></>}
      {priority !== "unassessed" && rationale.length > 1000 && <p className="text-xs text-muted-foreground">Shorten the rationale to 1,000 characters before saving.</p>}
      <div className="flex items-center gap-2"><Button size="sm" type="submit" disabled={!canSave || mutation.isPending}>{mutation.isPending ? "Saving…" : "Save"}</Button><Button size="sm" type="button" variant="ghost" disabled={mutation.isPending} onClick={() => setOpen(false)}>Cancel</Button></div>
      {mutation.error && !client.signal.aborted && <p role="alert" className="text-xs text-destructive">{mutation.error instanceof Error ? mutation.error.message : "Could not update business impact."}</p>}
    </form>
  </details>;
}

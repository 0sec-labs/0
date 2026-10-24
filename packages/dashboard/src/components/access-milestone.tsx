import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { accessMilestoneFromArtifact, appendAccessMilestone, visibleAccessMilestones } from "@0/shared/dist/access-milestone.js";
import { Link } from "react-router-dom";
import type { AccessMilestone } from "@0/shared/dist/access-milestone.js";
export function AccessMilestoneBanner({ milestone, scanId, at }: { milestone: AccessMilestone; scanId: string; at?: number }) {
  const verifiedAt = milestone.verifiedAt ?? at;
  const date = verifiedAt !== undefined && Number.isFinite(verifiedAt) && Math.abs(verifiedAt) <= 8_640_000_000_000_000 ? new Date(verifiedAt) : null;
  const cleanupDate = milestone.cleanupAt !== undefined && Number.isFinite(milestone.cleanupAt) && Math.abs(milestone.cleanupAt) <= 8_640_000_000_000_000 ? new Date(milestone.cleanupAt) : null;
  const confirmed = milestone.status === "confirmed";
  const blocked = milestone.status === "blocked";
  return <section role={confirmed ? "alert" : "status"} aria-label={`${milestone.status} access milestone`} className={`rounded-lg border p-4 ${confirmed ? "border-red-500/50 bg-red-500/10" : blocked ? "border-slate-500/40 bg-slate-500/10" : "border-amber-500/40 bg-amber-500/10"}`}>
    <p className={`text-xs font-medium uppercase ${confirmed ? "text-red-700 dark:text-red-300" : blocked ? "text-slate-700 dark:text-slate-300" : "text-amber-700 dark:text-amber-300"}`}>{confirmed ? "Confirmed access · deterministic ownership proof" : blocked ? "Access blocked · deterministic replay" : "Conditional impact · deterministic state transition"}</p>
    <h3 className="mt-1 font-semibold">{milestone.headline}</h3>
    <p className="mt-1 text-sm">{milestone.asset}</p>
    {date && <time className="text-xs text-muted-foreground" dateTime={date.toISOString()}>{date.toLocaleString()}</time>}
    <p className="mt-2 text-sm text-muted-foreground">{milestone.summary}</p>
    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
      <div><dt className="inline text-muted-foreground">Confidence: </dt><dd className="inline">{milestone.confidence === 1 ? "Deterministic observation" : "Unspecified"}</dd></div>
      <div><dt className="inline text-muted-foreground">Severity: </dt><dd className="inline">{milestone.severity ?? "Unspecified"}</dd></div>
      {milestone.accessLevel && <div><dt className="inline text-muted-foreground">Access level: </dt><dd className="inline">{milestone.accessLevel}</dd></div>}
    </dl>
    <p className={`mt-2 text-sm font-medium ${milestone.cleanup === "completed" ? "text-emerald-700 dark:text-emerald-300" : milestone.cleanup === "failed" ? "text-red-700 dark:text-red-300" : ""}`} aria-label="Cleanup status">
      Cleanup: {milestone.cleanup === "completed" ? "Observed field verified restored to its pre-proof value" : milestone.cleanup === "required" ? "Declared state restoration has not been verified" : milestone.cleanup === "failed" ? "Observed field was not restored at the last owner observation" : milestone.cleanup === "not-required" ? "Not required for this read-only proof" : "Unknown — not verified"}
      {cleanupDate && <time className="ml-2 text-xs font-normal" dateTime={cleanupDate.toISOString()}>Observed {cleanupDate.toLocaleString()}</time>}
    </p>
    {milestone.prerequisites?.length ? <p className="mt-2 text-xs text-muted-foreground">Prerequisites: {milestone.prerequisites.join("; ")}</p> : null}
    {milestone.limitations?.length ? <p className="mt-1 text-xs text-muted-foreground">Limitations: {milestone.limitations.join(" ")}</p> : null}
    <Link className="mt-2 inline-block text-sm underline" to={`/runs/${encodeURIComponent(scanId)}#${milestone.evidenceEventId ? `evidence-${encodeURIComponent(milestone.evidenceEventId)}` : "activity"}`}>View retained evidence</Link>
    {milestone.cleanupEvidenceEventId && <Link className="ml-4 text-sm underline" to={`/runs/${encodeURIComponent(scanId)}#evidence-${encodeURIComponent(milestone.cleanupEvidenceEventId)}`}>View cleanup observation</Link>}
  </section>;
}

/** Assessment context, without assigning unrelated artifacts to this finding. */
export function AssessmentAccessMilestones({ scanId }: { scanId: string }) {
  const { client, getScanEvents } = useBackendApi();
  const events = useQuery({ queryKey: ["scan-events", client.backendId, scanId], queryFn: () => getScanEvents(scanId), refetchInterval: 3000 });
  const milestones = (events.data?.events ?? []).reduce<Array<{ milestone: AccessMilestone; at: number }>>((items, event) => {
    const milestone = accessMilestoneFromArtifact(event.eventType, event.payload, scanId, event.id);
    return milestone ? appendAccessMilestone(items, { milestone, at: event.timestamp }) : items;
  }, []);
  if (!milestones.length) return null;
  return <section className="space-y-3" aria-label="Assessment access milestones"><h3 className="text-sm font-medium">Assessment access milestones</h3>{visibleAccessMilestones(milestones).map(({ milestone, at }) => <AccessMilestoneBanner key={milestone.key} milestone={milestone} scanId={scanId} at={at} />)}</section>;
}

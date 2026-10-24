import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { accessMilestoneFromArtifact, appendAccessMilestone } from "@0/shared/dist/access-milestone.js";
import { Link } from "react-router-dom";
import type { AccessMilestone } from "@0/shared/dist/access-milestone.js";
export function AccessMilestoneBanner({ milestone, scanId, at }: { milestone: AccessMilestone; scanId: string; at?: number }) {
  const date = at !== undefined && Number.isFinite(at) && Math.abs(at) <= 8_640_000_000_000_000 ? new Date(at) : null;
  const confirmed = milestone.status === "confirmed";
  const blocked = milestone.status === "blocked";
  return <section role={confirmed ? "alert" : "status"} aria-label={`${milestone.status} access milestone`} className={`rounded-lg border p-4 ${confirmed ? "border-red-500/50 bg-red-500/10" : blocked ? "border-slate-500/40 bg-slate-500/10" : "border-amber-500/40 bg-amber-500/10"}`}>
    <p className={`text-xs font-medium uppercase ${confirmed ? "text-red-700 dark:text-red-300" : blocked ? "text-slate-700 dark:text-slate-300" : "text-amber-700 dark:text-amber-300"}`}>{confirmed ? "Confirmed access · deterministic ownership proof" : blocked ? "Access blocked · deterministic replay" : "Conditional impact · deterministic state transition"}</p>
    <h3 className="mt-1 font-semibold">{milestone.headline}</h3>
    <p className="mt-1 text-sm">{milestone.asset}</p>
    {date && <time className="text-xs text-muted-foreground" dateTime={date.toISOString()}>{date.toLocaleString()}</time>}
    <p className="mt-2 text-sm text-muted-foreground">{milestone.summary}</p>
    <Link className="mt-2 inline-block text-sm underline" to={`/runs/${encodeURIComponent(scanId)}#${milestone.evidenceEventId ? `evidence-${encodeURIComponent(milestone.evidenceEventId)}` : "activity"}`}>View retained evidence</Link>
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
  return <section className="space-y-3" aria-label="Assessment access milestones"><h3 className="text-sm font-medium">Assessment access milestones</h3>{milestones.slice(-3).map(({ milestone, at }) => <AccessMilestoneBanner key={milestone.key} milestone={milestone} scanId={scanId} at={at} />)}</section>;
}

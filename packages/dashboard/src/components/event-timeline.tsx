import { accessMilestoneFromArtifact, appendAccessMilestone, type AccessMilestone } from "@0/shared/dist/access-milestone.js";
import { AccessMilestoneBanner } from "./access-milestone";
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleAlert,
  Radar,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import type { ScanEventsResponse } from "@/types";
import { formatTime, summarizePayload } from "@/lib/format";
import { Card, CardContent, CardEmpty, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function EventTimeline({
  events,
}: {
  events: ScanEventsResponse["events"];
}) {
  const milestones = events.reduce<Array<{ milestone: AccessMilestone; scanId: string; at: number }>>((items, event) => {
    const milestone = accessMilestoneFromArtifact(event.eventType, event.payload, event.scanId, event.id);
    return milestone ? appendAccessMilestone(items, { milestone, scanId: event.scanId, at: event.timestamp }) : items;
  }, []);
  return (
    <Card id="activity" className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle className="mt-2">Activity</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {milestones.map(({ milestone, scanId, at }) => <AccessMilestoneBanner key={milestone.key} milestone={milestone} scanId={scanId} at={at} />)}
        {events.length === 0 ? (
          <CardEmpty>No activity yet.</CardEmpty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Event</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead className="w-[10rem]">Time</TableHead>
                <TableHead className="w-[8rem]">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => {
                const Icon = iconForEvent(event.stage, event.eventType);
                const milestone = accessMilestoneFromArtifact(event.eventType, event.payload, event.scanId, event.id);

                return (
                  <TableRow key={event.id} id={`evidence-${encodeURIComponent(event.id)}`}>
                    <TableCell>
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 inline-flex size-8 items-center justify-center rounded-md border border-border bg-muted text-primary-text">
                          <Icon className="size-4" />
                        </div>
                        <div className="font-medium text-foreground">
                          {event.stage} · {event.eventType}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {milestone ? milestone.headline : summarizePayload(event.payload)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatTime(event.timestamp)}
                    </TableCell>
                    <TableCell>
                      {event.payload ? (
                        <details className="rounded-md border border-border bg-muted/50 p-2 text-sm text-muted-foreground">
                          <summary className="cursor-pointer list-none font-medium text-foreground">Show</summary>
                          <pre className="mt-3 text-xs text-muted-foreground">
                            {JSON.stringify(event.payload, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function iconForEvent(stage: string, eventType: string) {
  const value = `${stage}:${eventType}`.toLowerCase();
  if (value.includes("attack")) return ShieldAlert;
  if (value.includes("agent")) return Bot;
  if (value.includes("verify")) return CheckCircle2;
  if (value.includes("finding")) return CircleAlert;
  if (value.includes("scan")) return Radar;
  if (value.includes("analysis")) return Sparkles;
  return Activity;
}

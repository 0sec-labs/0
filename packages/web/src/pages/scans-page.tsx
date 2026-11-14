import { queryKeys } from "@/queries";
import { v } from "@/lib/vocabulary";
import { selectRun } from "@/lib/runs";
import { PageHeader, PageContent } from "@/components/page-header";
import { ReportExportControl } from "@/components/report-export-control";
import { useMemo, useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CapyAlertIcon as AlertCircle } from "@/ui/icons/capy";
import { useBackendApi } from "@/api";
import { EventTimeline } from "@/components/event-timeline";
import { MetaTile } from "@/components/meta-tile";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { PhaseBadge, ReviewBadge, SeverityBadge, RunStatusBadge } from "@/components/status-badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardEmpty, CardHeader, CardList, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScanResumeControl } from "@/components/scan-resume-control";
import { formatDuration, formatTime } from "@/lib/format";
import type { ScanEventsResponse, ScanFindingsResponse, ScanRecord } from "@/types";

/** A report is one retained scan record; its conversation is linked context, never inferred from IDs. */
export function ReportPage({ scans }: { scans: ScanRecord[] }) {
  const { client, getRuns, getScanEvents, getScanFindings } = useBackendApi();
  const { scanId: routeId } = useParams<{ scanId?: string }>();
  const [reportId, setReportId] = useState<string | null>(null);
  const runsQuery = useQuery({ queryKey: queryKeys.runs(client.backendId), queryFn: getRuns, refetchInterval: 10000 });
  const runs = runsQuery.data ?? [];
  const selectedRun = selectRun(runs, routeId);
  // Existing scan links remain usable, including scans folded into automation records.
  const legacyScan = routeId && !selectedRun ? scans.find(scan => scan.id === routeId) : undefined;
  const scanIds = selectedRun?.native.scanIds ?? (legacyScan ? [legacyScan.id] : []);
  const selectedScanId = reportId && scanIds.includes(reportId) ? reportId : (routeId && scanIds.includes(routeId) ? routeId : scanIds[0]) ?? null;
  const active = selectedRun?.status === "running";
  const eventsQuery = useQuery({ queryKey: queryKeys.scanEvents(client.backendId, selectedScanId), queryFn: () => getScanEvents(selectedScanId!), enabled: Boolean(selectedScanId), refetchInterval: active ? 3000 : false });
  const findingsQuery = useQuery({ queryKey: queryKeys.scanFindings(client.backendId, selectedScanId), queryFn: () => getScanFindings(selectedScanId!), enabled: Boolean(selectedScanId), refetchInterval: active ? 3000 : false });
  const notFound = !runsQuery.isPending && !selectedRun && !legacyScan;
  const links = selectedRun && (selectedRun.conversation || selectedRun.native.workflowId || scanIds.length > 1) ? <div className="flex flex-wrap items-center gap-2">
    {selectedRun.conversation && <Button variant="outline" size="sm" render={<NavLink to={`/chats/${encodeURIComponent(selectedRun.conversation.sessionId)}`} />}>{v("Open {mission}")}</Button>}
    {selectedRun.native.workflowId && <Button variant="outline" size="sm" render={<NavLink to={`/automations?workflow=${encodeURIComponent(selectedRun.native.workflowId)}`} />}>Open automation</Button>}
    {scanIds.length > 1 && <span className="flex flex-wrap gap-2" role="group" aria-label="Reports">{scanIds.map((id, index) => <Button key={id} size="sm" variant={selectedScanId === id ? "secondary" : "ghost"} onClick={() => setReportId(id)}>Report {index + 1}</Button>)}</span>}
  </div> : null;
  const body = runsQuery.isPending && !legacyScan ? <LoadingState label="Report" variant="detail" />
    : runsQuery.isError && !legacyScan ? <ErrorState error={runsQuery.error} />
    : notFound ? <EmptyState title="Report not found" body="This report is not available on this engine." action={<Button variant="outline" render={<Link to="/findings" />}>Back to findings</Button>} />
    : !selectedScanId ? <EmptyState title="No scan report" body={v("This execution has no retained scan report. Open its {mission} for activity and results.")} />
    : eventsQuery.isPending || findingsQuery.isPending ? <LoadingState label="Report" variant="detail" />
    : eventsQuery.error || findingsQuery.error ? <ErrorState error={(eventsQuery.error ?? findingsQuery.error)!} />
    : eventsQuery.data && findingsQuery.data ? <ScanDetail events={eventsQuery.data} findings={findingsQuery.data} targetRuns={scans.filter(scan => scan.target === eventsQuery.data.scan.target)} /> : null;
  return <PageContent width="wide">
    <PageHeader title="Report" summary={eventsQuery.data?.scan.target ?? selectedRun?.target ?? undefined} />
    {links}
    {body}
  </PageContent>;
}

function ScanDetail({
  events,
  findings,
  targetRuns,
}: {
  events: ScanEventsResponse;
  findings: ScanFindingsResponse;
  targetRuns: ScanRecord[];
}) {
  const scan = events.scan;
  const latestIncident = useMemo(() => findLatestIncident(events.events), [events.events]);

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RunStatusBadge value={scan.status} />
        <div className="flex flex-wrap items-center gap-2">
          {scan.mode !== "ci-import" ? <ScanResumeControl key={scan.id} scan={scan} /> : null}
          <ReportExportControl path={`/api/scans/${encodeURIComponent(scan.id)}/export`} />
        </div>
      </div>
      <Card>
        <CardHeader><CardTitle className="font-sans text-base font-medium">Scope</CardTitle></CardHeader>
        <CardContent>
          <CardList>
            <MetaTile label="Target" value={scan.target} />
            <MetaTile label="Started" value={formatTime(scan.startedAt)} />
            <MetaTile label="Completed" value={scan.completedAt ? formatTime(scan.completedAt) : "In progress"} />
            <MetaTile label="Mode" value={`${scan.mode} / ${scan.depth}`} />
            <MetaTile label="Engine" value={scan.runtime} />
            <MetaTile label="Duration" value={formatDuration(scan.durationMs)} />
            <MetaTile label="Report ID" value={scan.id} mono />
          </CardList>
        </CardContent>
      </Card>

        {scan.ciImport ? (
          <Card>
            <CardHeader><CardTitle className="text-base">Imported CI report</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-muted-foreground">This engine has not independently verified the imported evidence. Findings are retained for review; importing does not authorize execution or fixes.</p>
              <p>Source execution: <strong>{scan.ciImport.sourceExecutionStatus}</strong>{scan.ciImport.cliExitCode !== null ? ` · CLI exit ${scan.ciImport.cliExitCode}` : ""}</p>
              {scan.ciImport.repository ? <p className="break-all">Repository: {scan.ciImport.repository}</p> : null}
              {scan.ciImport.reviewedRevision ? <p className="break-all">Reviewed revision: <code>{scan.ciImport.reviewedRevision}</code></p> : <p className="text-muted-foreground">Reviewed revision was not supplied.</p>}
              {scan.ciImport.runId ? <p>CI run: {scan.ciImport.runId}</p> : null}
              {scan.ciImport.cliVersion ? <p>CLI: {scan.ciImport.cliVersion}</p> : null}
              <p className="text-muted-foreground">Imported {formatTime(scan.ciImport.importedAt)}</p>
            </CardContent>
          </Card>
        ) : null}

        {latestIncident ? (
          <Card className="border-destructive/25 bg-destructive/5">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 size-5 text-destructive" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">Error</div>
                  <div className="mt-1 text-sm leading-6 text-muted-foreground">
                    {latestIncident.headline}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{formatTime(latestIncident.timestamp)}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle className="font-sans text-base font-medium">Findings</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {findings.groups.length === 0 ? (
              <CardEmpty>No findings in this report.</CardEmpty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Finding</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="w-[12rem]">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {findings.groups.map((group) => (
                    <TableRow key={group.fingerprint}>
                      <TableCell className="font-medium text-foreground"><NavLink to={`/findings/${encodeURIComponent(group.fingerprint)}`} className="hover:text-primary-text hover:underline">{group.latest.title}</NavLink></TableCell>
                      <TableCell className="text-muted-foreground">{group.latest.category}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <SeverityBadge severity={group.latest.severity} />
                          <PhaseBadge value={group.workflow.phase} />
                          {group.workflow.reviewGate !== "none" ? <ReviewBadge value={group.workflow.reviewGate} /> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {targetRuns.some((entry) => entry.id !== scan.id) ? (
        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle className="font-sans text-base font-medium">Earlier reports</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {(
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Started</TableHead>
                    <TableHead>Findings</TableHead>
                    <TableHead className="w-[10rem]">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {targetRuns.filter((entry) => entry.id !== scan.id).slice(0, 6).map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">
                        <NavLink to={`/runs/${encodeURIComponent(entry.id)}`} className="text-foreground hover:text-primary-text">
                          {formatTime(entry.startedAt)}
                        </NavLink>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{entry.summary.totalFindings}</TableCell>
                      <TableCell>
                        <RunStatusBadge value={entry.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        ) : null}

        <EventTimeline events={events.events} />
    </div>
  );
}

function findLatestIncident(events: ScanEventsResponse["events"]) {
  const isExecutionStall = (event: ScanEventsResponse["events"][number]) => {
    const payload = event.payload ?? {};
    const summary =
      typeof payload.summary === "string" && payload.summary.trim()
        ? payload.summary.trim()
        : event.eventType;
    return /max turns|did not emit required tool_call/i.test(summary);
  };

  const incident = [...events]
    .reverse()
    .find((event) =>
      ["agent_error", "scan_error", "worker_failed"].includes(event.eventType)
      || ((event.eventType === "stage_complete" || event.eventType === "agent_complete") && isExecutionStall(event)),
    );

  if (!incident) return null;

  const payload = incident.payload ?? {};
  const headline =
    typeof payload.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : typeof payload.summary === "string" && payload.summary.trim()
        ? payload.summary.trim()
        : `${incident.stage} ${incident.eventType}`.replaceAll("_", " ");

  return {
    stage: incident.stage,
    actor: incident.agentRole ?? null,
    headline,
    timestamp: incident.timestamp,
  };
}

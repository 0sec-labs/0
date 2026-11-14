import { v } from "@/lib/vocabulary";
import { filterRuns, selectRun } from "@/lib/runs";
import { PageHeader, PageContent } from "@/components/page-header";
import { ReportExportControl } from "@/components/report-export-control";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, Siren } from "lucide-react";
import { CapyAlertIcon as AlertCircle } from "@/ui/icons/capy";
import { useBackendApi } from "@/api";
import { useDashboardPanel } from "@/components/dashboard-panel";
import { EntityList, EntityListItem } from "@/components/entity-list";
import { EventTimeline } from "@/components/event-timeline";
import { InspectorPane } from "@/components/inspector-pane";
import { MetaTile } from "@/components/meta-tile";
import { MetricCard } from "@/components/metric-card";
import { EmptyState, ErrorState, LoadingState } from "@/components/state-panel";
import { PhaseBadge, ReviewBadge, SeverityBadge, StatusBadge } from "@/components/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardEmpty, CardHeader, CardList, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Workspace, WorkspaceMain, WorkspaceSidebar } from "@/components/workspace";
import { ScanResumeControl } from "@/components/scan-resume-control";
import { formatDuration, formatTime } from "@/lib/format";
import type { ScanEventsResponse, ScanFindingsResponse, ScanRecord } from "@/types";

/** Runs are engine records; conversations are linked context, never inferred from IDs. */
export function ScansPage({ scans }: { scans: ScanRecord[] }) {
  const { client, getRuns, getScanEvents, getScanFindings } = useBackendApi();
  const { scanId: routeId } = useParams<{ scanId?: string }>();
  const [search, setSearch] = useState("");
  const [reportId, setReportId] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search);
  const runsQuery = useQuery({ queryKey: ["runs", client.backendId], queryFn: getRuns, refetchInterval: 3000 });
  const runs = runsQuery.data ?? [];
  const visibleRuns = filterRuns(runs, deferredSearch);
  const selectedRun = selectRun(runs, routeId, !routeId ? visibleRuns[0]?.id : undefined);
  // Existing scan links remain usable, including scans folded into automation records.
  const legacyScan = routeId && !selectedRun ? scans.find(scan => scan.id === routeId) : undefined;
  const scanIds = selectedRun?.native.scanIds ?? (legacyScan ? [legacyScan.id] : []);
  const selectedScanId = reportId && scanIds.includes(reportId) ? reportId : (routeId && scanIds.includes(routeId) ? routeId : scanIds[0]) ?? null;
  const eventsQuery = useQuery({ queryKey: ["scan-events", client.backendId, selectedScanId], queryFn: () => getScanEvents(selectedScanId!), enabled: Boolean(selectedScanId), refetchInterval: selectedRun?.status === "running" ? 3000 : false });
  const findingsQuery = useQuery({ queryKey: ["scan-findings", client.backendId, selectedScanId], queryFn: () => getScanFindings(selectedScanId!), enabled: Boolean(selectedScanId), refetchInterval: selectedRun?.status === "running" ? 3000 : false });

  return <PageContent width="wide">
    <PageHeader title="Runs" summary={v("Follow assessments and automation executions, with their {missions} and retained evidence.")} />
    <Workspace className="xl:grid-cols-[22rem_minmax(0,1fr)]">
      <WorkspaceSidebar><EntityList title="Runs" description={v("Work started from {a mission}, CLI, or automations.")} searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search runs">
        {runsQuery.isPending ? <LoadingState label="Runs" /> : runsQuery.isError ? <ErrorState error={runsQuery.error} /> : !visibleRuns.length ? <CardEmpty>{runs.length ? "No matching runs." : "No runs yet."}</CardEmpty> : visibleRuns.map(run => <NavLink key={run.id} to={`/runs/${encodeURIComponent(run.id)}`}><EntityListItem selected={selectedRun?.id === run.id} title={run.title} description={run.target || "No target"} meta={formatTime(run.createdAt)} badges={<><StatusBadge value={run.status} /><Badge>{run.kind}</Badge>{run.native.scanIds.some(id => scans.some(scan => scan.id === id && scan.ciImport)) && <Badge>Imported CI</Badge>}</>} /></NavLink>)}
      </EntityList></WorkspaceSidebar>
      <div className="min-w-0 space-y-4">
        {selectedRun && <Card><CardContent className="space-y-3 p-4"><div className="flex flex-wrap items-center gap-2"><span className="mr-auto text-sm font-medium">{selectedRun.title}</span><StatusBadge value={selectedRun.status} />{selectedRun.conversation && <Button variant="outline" size="sm" asChild><NavLink to={`/console/${encodeURIComponent(selectedRun.conversation.sessionId)}`}>{v("Open {mission}")}</NavLink></Button>}{selectedRun.native.workflowId && <Button variant="outline" size="sm" asChild><NavLink to={`/automations?workflow=${encodeURIComponent(selectedRun.native.workflowId)}`}>Open automation</NavLink></Button>}</div><p className="break-all text-xs text-muted-foreground">{selectedRun.target} · {selectedRun.id}</p>{scanIds.length > 1 && <div className="flex flex-wrap gap-2" aria-label="Run reports">{scanIds.map((id, index) => <Button key={id} size="sm" variant={selectedScanId === id ? "secondary" : "ghost"} onClick={() => setReportId(id)}>Report {index + 1}</Button>)}</div>}</CardContent></Card>}
        {!selectedRun && !legacyScan ? <WorkspaceMain span><EmptyState title={routeId ? "Run not found" : "No run selected"} body={routeId ? "This run is not available on this host." : v("Start an assessment in {a mission} or run a saved workflow.")} action={<Button asChild><NavLink to="/console">{v("Open {mission}")}</NavLink></Button>} /></WorkspaceMain>
          : !selectedScanId ? <WorkspaceMain span><EmptyState title="No scan reports" body={v("This execution has no retained scan reports. Open its {mission} for activity and results.")} /></WorkspaceMain>
          : eventsQuery.isPending || findingsQuery.isPending ? <WorkspaceMain span><LoadingState label="Run report" /></WorkspaceMain>
          : eventsQuery.error || findingsQuery.error ? <WorkspaceMain span><ErrorState error={(eventsQuery.error ?? findingsQuery.error)!} /></WorkspaceMain>
          : eventsQuery.data && findingsQuery.data ? <ScanDetail events={eventsQuery.data} findings={findingsQuery.data} targetRuns={scans.filter(scan => scan.target === eventsQuery.data.scan.target)} /> : null}
      </div>
    </Workspace>
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
  const { openPanel, clearPanel } = useDashboardPanel();
  const latestIncident = useMemo(() => findLatestIncident(events.events), [events.events]);
  const panelContent = useMemo(
    () => (
      <div className="space-y-4 p-6">
        <InspectorPane title="Target">
          <CardList>
            <MetaTile label="Started" value={formatTime(scan.startedAt)} />
            <MetaTile
              label="Completed"
              value={scan.completedAt ? formatTime(scan.completedAt) : "In progress"}
            />
            <MetaTile label="Mode" value={`${scan.mode} / ${scan.depth}`} />
            <MetaTile label="Engine" value={scan.runtime} />
            <MetaTile label="Duration" value={formatDuration(scan.durationMs)} />
            <MetaTile label="Run ID" value={scan.id} mono />
          </CardList>
        </InspectorPane>
      </div>
    ),
    [scan.completedAt, scan.depth, scan.durationMs, scan.id, scan.mode, scan.runtime, scan.startedAt],
  );

  useEffect(() => {
    clearPanel();
    return () => clearPanel();
  }, [clearPanel, scan.id]);

  const openTargetPanel = useCallback(() => {
    openPanel({
      title: scan.target,
      description: "",
      content: panelContent,
    });
  }, [openPanel, panelContent, scan.target]);

  return (
    <WorkspaceMain span className="space-y-4">
      <InspectorPane
        title={scan.target}
        actions={(
          <div className="flex items-center gap-2">
            <StatusBadge value={scan.status} />
            {scan.mode !== "ci-import" ? <ScanResumeControl key={scan.id} scan={scan} /> : null}
            <ReportExportControl path={`/api/scans/${encodeURIComponent(scan.id)}/export`} />
            <Button variant="outline" size="sm" onClick={openTargetPanel}>
              Details
            </Button>
          </div>
        )}
      >

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

        <section className="grid gap-4 sm:grid-cols-3">
          <MetricCard
            icon={Activity}
            label="Findings"
            value={scan.summary.totalFindings}
            hint=""
            tone="accent"
          />
          <MetricCard
            icon={Siren}
            label="Critical"
            value={scan.summary.critical}
            hint=""
            tone="danger"
          />
          <MetricCard
            icon={AlertCircle}
            label="High"
            value={scan.summary.high}
            hint=""
            tone="warning"
          />
        </section>

        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle className="font-sans text-base font-medium">Findings</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {findings.groups.length === 0 ? (
              <CardEmpty>No findings in this run.</CardEmpty>
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

        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle className="font-sans text-base font-medium">Previous runs</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {targetRuns.filter((entry) => entry.id !== scan.id).length === 0 ? (
              <CardEmpty>No previous runs yet.</CardEmpty>
            ) : (
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
                        <NavLink to={`/runs/${entry.id}`} className="text-foreground hover:text-primary-text">
                          {formatTime(entry.startedAt)}
                        </NavLink>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{entry.summary.totalFindings}</TableCell>
                      <TableCell>
                        <StatusBadge value={entry.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <EventTimeline events={events.events} />
      </InspectorPane>
    </WorkspaceMain>
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

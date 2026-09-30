import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertCircle, Siren } from "lucide-react";
import { getScanEvents, getScanFindings, listConsoleSessions, listSavedConsoleSessions } from "@/api";
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
import { formatDuration, formatTime } from "@/lib/format";
import type { ScanEventsResponse, ScanFindingsResponse, ScanRecord } from "@/types";

type TargetRunGroup = {
  target: string;
  scans: ScanRecord[];
  latestScan: ScanRecord;
  activeRunCount: number;
  totalFindings: number;
};

export function ScansPage({ scans }: { scans: ScanRecord[] }) {
  const { scanId } = useParams<{ scanId?: string }>();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  const sessionsQuery = useQuery({ queryKey: ["console-sessions"], queryFn: ({ signal }) => listConsoleSessions(signal), refetchInterval: 2000 });
  const savedQuery = useQuery({ queryKey: ["console-saved"], queryFn: ({ signal }) => listSavedConsoleSessions(signal), refetchInterval: 5000 });
  const conversationIds = useMemo(() => new Set([
    ...(sessionsQuery.data ?? []).flatMap((session) => [session.id, ...(session.savedId ? [session.savedId] : [])]),
    ...(savedQuery.data ?? []).map((session) => session.id),
  ]), [sessionsQuery.data, savedQuery.data]);
  // Console records share the findings database, but are conversations rather than assessments.
  const assessments = useMemo(() => scans.filter((scan) => Boolean(scan.target.trim()) && !scan.id.startsWith("console-") && !conversationIds.has(scan.id)), [scans, conversationIds]);

  const groupedTargets = useMemo(() => {
    const grouped = new Map<string, ScanRecord[]>();
    for (const scan of assessments) {
      const existing = grouped.get(scan.target) ?? [];
      existing.push(scan);
      grouped.set(scan.target, existing);
    }

    return [...grouped.entries()]
      .map(([target, entries]) => {
        const sortedScans = [...entries].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
        return {
          target,
          scans: sortedScans,
          latestScan: sortedScans[0]!,
          activeRunCount: sortedScans.filter((scan) => scan.status === "running").length,
          totalFindings: sortedScans.reduce((sum, scan) => sum + scan.summary.totalFindings, 0),
        } satisfies TargetRunGroup;
      })
      .sort((left, right) => right.latestScan.startedAt.localeCompare(left.latestScan.startedAt));
  }, [assessments]);

  const filteredTargets = useMemo(() => {
    const normalized = deferredSearch.trim().toLowerCase();
    if (!normalized) return groupedTargets;
    return groupedTargets.filter((group) =>
      [group.target, ...group.scans.flatMap((scan) => [scan.depth, scan.runtime, scan.mode, scan.status, scan.id])]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [deferredSearch, groupedTargets]);

  const selectedScan = useMemo(
    () => scans.find((scan) => scan.id === scanId) ?? filteredTargets[0]?.latestScan ?? null,
    [filteredTargets, scanId, scans],
  );
  const selectedScanId = selectedScan?.id ?? null;
  const selectedConversation = Boolean(selectedScan && (selectedScan.id.startsWith("console-") || conversationIds.has(selectedScan.id)));
  const liveConversation = sessionsQuery.data?.find((session) => session.id === selectedScanId || session.savedId === selectedScanId);
  const selectedTarget = useMemo(
    () => (selectedScan ? groupedTargets.find((group) => group.target === selectedScan.target) ?? null : null),
    [groupedTargets, selectedScan],
  );

  useEffect(() => {
    if (!scanId && selectedScanId && !sessionsQuery.isPending && !savedQuery.isPending) {
      navigate(`/runs/${selectedScanId}`, { replace: true });
    }
  }, [navigate, scanId, selectedScanId, sessionsQuery.isPending, savedQuery.isPending]);

  const eventsQuery = useQuery({
    queryKey: ["scan-events", selectedScanId],
    queryFn: () => getScanEvents(selectedScanId!),
    enabled: Boolean(selectedScanId),
  });

  const findingsQuery = useQuery({
    queryKey: ["scan-findings", selectedScanId],
    queryFn: () => getScanFindings(selectedScanId!),
    enabled: Boolean(selectedScanId),
  });

  return (
    <div className="space-y-6">
      <Workspace className="xl:grid-cols-[22rem_minmax(0,1fr)]">
        <WorkspaceSidebar>
          <EntityList
            title="Assessment history"
            description="Past assessments by target"
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search assessments"
          >
            {filteredTargets.length === 0 ? (
              <CardEmpty className="py-8">No matches.</CardEmpty>
            ) : (
              filteredTargets.map((group) => (
                <NavLink key={group.target} to={`/runs/${group.latestScan.id}`}>
                  {({ isActive }) => (
                    <EntityListItem
                      selected={isActive}
                      title={group.target}
                      description={`${group.scans.length} assessment${group.scans.length === 1 ? "" : "s"}`}
                      meta={formatTime(group.latestScan.startedAt)}
                      badges={
                        <>
                          <StatusBadge value={group.latestScan.status} />
                          <Badge>{group.totalFindings} findings</Badge>
                        </>
                      }
                    />
                  )}
                </NavLink>
              ))
            )}
          </EntityList>
        </WorkspaceSidebar>

        {!selectedScanId ? (
          <WorkspaceMain span>
            <EmptyState
              title="No assessments yet"
              body="Start an assessment in a chat. Its results will appear here."
              action={<Button asChild><NavLink to="/console">Open chats</NavLink></Button>}
            />
          </WorkspaceMain>
        ) : selectedConversation ? (
          <WorkspaceMain span>
            <EmptyState
              title="Chat activity"
              body="This record belongs to a conversation, not a separate assessment. Open chats to continue the work and view its agents."
              action={<Button asChild><NavLink to={liveConversation ? `/console/${liveConversation.id}` : "/console"}>Open chat</NavLink></Button>}
            />
            {findingsQuery.data && findingsQuery.data.groups.length > 0 ? (
              <div className="mt-4 text-sm text-muted-foreground">
                {findingsQuery.data.groups.length} findings recorded. <NavLink to="/findings" className="text-primary-text hover:underline">View findings</NavLink>
              </div>
            ) : null}
          </WorkspaceMain>
        ) : eventsQuery.isLoading || findingsQuery.isLoading ? (
          <WorkspaceMain span>
            <LoadingState label="Assessment" />
          </WorkspaceMain>
        ) : eventsQuery.error ? (
          <WorkspaceMain span>
            <ErrorState error={eventsQuery.error} />
          </WorkspaceMain>
        ) : findingsQuery.error ? (
          <WorkspaceMain span>
            <ErrorState error={findingsQuery.error} />
          </WorkspaceMain>
        ) : eventsQuery.data && findingsQuery.data ? (
          <ScanDetail events={eventsQuery.data} findings={findingsQuery.data} targetRuns={selectedTarget?.scans ?? []} />
        ) : (
          <WorkspaceMain span>
            <EmptyState
              title="Assessment not found"
              body="This assessment couldn't be loaded."
            />
          </WorkspaceMain>
        )}
      </Workspace>
    </div>
  );
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
            <MetaTile label="Assessment ID" value={scan.id} mono />
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
            <Button variant="outline" size="sm" onClick={openTargetPanel}>
              Details
            </Button>
          </div>
        )}
      >

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
              <CardEmpty>No findings in this assessment.</CardEmpty>
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
                      <TableCell className="font-medium text-foreground">{group.latest.title}</TableCell>
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
              <CardTitle className="font-sans text-base font-medium">Previous assessments</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {targetRuns.filter((entry) => entry.id !== scan.id).length === 0 ? (
              <CardEmpty>No previous assessments yet.</CardEmpty>
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

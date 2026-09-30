import { useId, useMemo, useState, type ComponentType } from "react";
import { NavLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertCircle, Database, Play, Power, RefreshCcw, Siren, Trash2 } from "lucide-react";
import { getRecentEvents, launchRun, pruneStoppedWorkers, recoverStaleWorkers, resetDatabase, startDaemon, stopDaemon } from "@/api";
import { PageHeader } from "@/components/page-header";
import { PhaseBadge, ReviewBadge, SeverityBadge, StatusBadge } from "@/components/status-badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardEmpty, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select } from "@/components/ui/select";
import { formatDuration, formatTime } from "@/lib/format";
import type { DashboardResponse } from "@/types";

export function OverviewPage({ data }: { data: DashboardResponse }) {
  const queryClient = useQueryClient();
  const [controlMessage, setControlMessage] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<"deep" | "web" | "mcp">("deep");
  const [depth, setDepth] = useState<"quick" | "default" | "deep">("default");
  const [runtime, setRuntime] = useState<"auto" | "api" | "codex" | "claude" | "gemini">("auto");
  const recentEventsQuery = useQuery({
    queryKey: ["recent-events"],
    queryFn: () => getRecentEvents(12),
    refetchInterval: 5000,
  });

  const reviewQueue = data.groups.filter((group) => group.workflow.reviewGate !== "none");
  const blockedThreads = data.groups.filter((group) => group.workflow.phase === "blocked");
  const activeScans = data.scans.filter((scan) => scan.status === "running");
  const activeWorkers = data.workers.filter((worker) => worker.isActive && worker.status !== "stopped");
  const hasLiveDaemon = activeWorkers.length > 0;
  const isEmptyWorkspace = data.scans.length === 0 && data.groups.length === 0 && data.workers.length === 0;

  const refreshDashboard = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["scans"] }),
      queryClient.invalidateQueries({ queryKey: ["recent-events"] }),
    ]);
  };

  const recoverMutation = useMutation({
    mutationFn: () => recoverStaleWorkers(),
    onSuccess: async (result) => {
      setControlMessage(
        result.recovered > 0
          ? `Restarted ${result.recovered} stuck task${result.recovered === 1 ? "" : "s"}.`
          : "No stuck tasks.",
      );
      await refreshDashboard();
    },
    onError: (error) => {
      setControlMessage(error instanceof Error ? error.message : String(error));
    },
  });

  const pruneMutation = useMutation({
    mutationFn: () => pruneStoppedWorkers(),
    onSuccess: async (result) => {
      setControlMessage(
        result.deleted > 0
          ? `Cleared ${result.deleted} stopped worker${result.deleted === 1 ? "" : "s"}.`
          : "Nothing to clear.",
      );
      await refreshDashboard();
    },
    onError: (error) => {
      setControlMessage(error instanceof Error ? error.message : String(error));
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => resetDatabase("empty"),
    onSuccess: async (result) => {
      setControlMessage(`All data reset.`);
      await refreshDashboard();
    },
    onError: (error) => {
      setControlMessage(error instanceof Error ? error.message : String(error));
    },
  });

  const startDaemonMutation = useMutation({
    mutationFn: () => startDaemon({ label: "control-plane-1", pollIntervalMs: 2000 }),
    onSuccess: async () => {
      setControlMessage("Worker started.");
      await refreshDashboard();
    },
    onError: (error) => {
      setControlMessage(error instanceof Error ? error.message : String(error));
    },
  });

  const stopDaemonMutation = useMutation({
    mutationFn: () => stopDaemon(),
    onSuccess: async (result) => {
      setControlMessage(
        result.stopped > 0
          ? `Stopped ${result.stopped} worker${result.stopped === 1 ? "" : "s"}.`
          : "No worker was running.",
      );
      await refreshDashboard();
    },
    onError: (error) => {
      setControlMessage(error instanceof Error ? error.message : String(error));
    },
  });

  const launchMutation = useMutation({
    mutationFn: () => launchRun({
      target: target.trim(),
      depth,
      mode,
      runtime,
      ensureDaemon: true,
    }),
    onSuccess: async () => {
      setControlMessage(`Scan started for ${target.trim()}.`);
      setTarget("");
      await refreshDashboard();
    },
    onError: (error) => {
      setControlMessage(error instanceof Error ? error.message : String(error));
    },
  });

  const isMutating =
    recoverMutation.isPending
    || pruneMutation.isPending
    || resetMutation.isPending
    || startDaemonMutation.isPending
    || stopDaemonMutation.isPending
    || launchMutation.isPending;

  const needsAttention = [...data.groups]
    .filter(
      (group) =>
        group.workflow.reviewGate !== "none"
        || group.workflow.phase === "blocked"
        || !group.workflow.assignee,
    )
    .sort((left, right) => right.latest.timestamp - left.latest.timestamp)
    .slice(0, 8);

  const activeThreads = [...data.groups]
    .filter((group) => group.workflow.phase === "in_progress" || group.workflow.activeAgentRoles.length > 0)
    .sort((left, right) => right.latest.timestamp - left.latest.timestamp)
    .slice(0, 8);

  const recentRuns = [...data.scans]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, 8);
  const recentIncidents = useMemo(() => {
    const rows = recentEventsQuery.data?.events ?? [];
    const byScan = new Map<string, {
      scanId: string;
      scanTarget: string;
      stage: string;
      actor: string | null;
      headline: string;
      timestamp: number;
    }>();

    for (const event of rows) {
      const payload = event.payload ?? {};
      const summaryText =
        typeof payload.summary === "string" && payload.summary.trim()
          ? payload.summary.trim()
          : event.summary;
      const isExecutionStall =
        ["stage_complete", "agent_complete", "runtime_incompatible"].includes(event.eventType)
        && /max turns|did not emit required tool_call/i.test(summaryText);
      if (!["agent_error", "scan_error", "worker_failed"].includes(event.eventType) && !isExecutionStall) continue;
      if (byScan.has(event.scanId)) continue;
      const headline =
        typeof payload.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : typeof payload.summary === "string" && payload.summary.trim()
            ? payload.summary.trim()
            : event.summary;

      byScan.set(event.scanId, {
        scanId: event.scanId,
        scanTarget: event.scanTarget,
        stage: event.stage,
        actor: event.agentRole ?? null,
        headline,
        timestamp: event.timestamp,
      });
    }

    return [...byScan.values()].slice(0, 4);
  }, [recentEventsQuery.data?.events]);

  const latestThreads = [...data.groups]
    .sort(
      (left, right) =>
        Number(new Date(right.workflow.updatedAt ?? right.latest.timestamp))
        - Number(new Date(left.workflow.updatedAt ?? left.latest.timestamp)),
    )
    .slice(0, 8);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        summary=""
        actions={(
          <>
            <Button asChild variant="outline">
              <NavLink to="/runs">Activity</NavLink>
            </Button>
            <Button asChild variant="accent">
              <NavLink to="/findings">Findings</NavLink>
            </Button>
          </>
        )}
      />

      {isEmptyWorkspace ? (
        <section className="grid gap-4">
          <Card className="overflow-hidden">
            <CardHeader>
              <div>
                <CardTitle>Start your first scan</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Target</div>
                <Input
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  placeholder={mode === "mcp" ? "mcp://assistant-endpoint" : mode === "web" ? "https://app.example.com" : "https://api.example.com"}
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <SelectionField
                  label="Mode"
                  value={mode}
                  onValueChange={(value) => setMode(value as typeof mode)}
                  options={[
                    { value: "deep", label: "API/URL" },
                    { value: "web", label: "Web app" },
                    { value: "mcp", label: "MCP" },
                  ]}
                />
                <SelectionField
                  label="Depth"
                  value={depth}
                  onValueChange={(value) => setDepth(value as typeof depth)}
                  options={[
                    { value: "quick", label: "Quick" },
                    { value: "default", label: "Default" },
                    { value: "deep", label: "Deep" },
                  ]}
                />
                <SelectionField
                  label="Engine"
                  value={runtime}
                  onValueChange={(value) => setRuntime(value as typeof runtime)}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "api", label: "API" },
                    { value: "codex", label: "Codex" },
                    { value: "claude", label: "Claude" },
                    { value: "gemini", label: "Gemini" },
                  ]}
                />
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  variant="accent"
                  onClick={() => launchMutation.mutate()}
                  disabled={!target.trim() || isMutating}
                >
                  <Play />
                  Start scan
                </Button>
                <Button
                  variant="outline"
                  onClick={() => startDaemonMutation.mutate()}
                  disabled={hasLiveDaemon || isMutating}
                >
                  <Power />
                  Start worker
                </Button>
                <Button
                  variant="outline"
                  onClick={() => stopDaemonMutation.mutate()}
                  disabled={!hasLiveDaemon || isMutating}
                >
                  <Power />
                  Stop worker
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      ) : null}

      {!isEmptyWorkspace ? (
      <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Card className="overflow-hidden">
          <CardHeader>
              <div>
                <CardTitle>New scan</CardTitle>
              </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="min-w-0 space-y-2 sm:col-span-3">
                <div className="text-xs font-medium text-muted-foreground">Target</div>
                <Input
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  placeholder={mode === "mcp" ? "mcp://assistant-endpoint" : mode === "web" ? "https://app.example.com" : "https://api.example.com"}
                />
              </label>
              <SelectionField
                label="Mode"
                value={mode}
                onValueChange={(value) => setMode(value as typeof mode)}
                options={[
                  { value: "deep", label: "API/URL" },
                  { value: "web", label: "Web app" },
                  { value: "mcp", label: "MCP" },
                ]}
              />
              <SelectionField
                label="Depth"
                value={depth}
                onValueChange={(value) => setDepth(value as typeof depth)}
                options={[
                  { value: "quick", label: "Quick" },
                  { value: "default", label: "Default" },
                  { value: "deep", label: "Deep" },
                ]}
              />
              <SelectionField
                label="Engine"
                value={runtime}
                onValueChange={(value) => setRuntime(value as typeof runtime)}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "api", label: "API" },
                  { value: "codex", label: "Codex" },
                  { value: "claude", label: "Claude" },
                  { value: "gemini", label: "Gemini" },
                ]}
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                variant="accent"
                onClick={() => launchMutation.mutate()}
                disabled={!target.trim() || isMutating}
              >
                <Play />
                Start scan
              </Button>
              <Button
                variant={hasLiveDaemon ? "outline" : "default"}
                onClick={() => (hasLiveDaemon ? stopDaemonMutation.mutate() : startDaemonMutation.mutate())}
                disabled={isMutating}
              >
                <Power />
                {hasLiveDaemon ? "Stop worker" : "Start worker"}
              </Button>
              <Button variant="outline" onClick={() => recoverMutation.mutate()} disabled={isMutating}>
                <RefreshCcw />
                Retry stuck
              </Button>
              <Button variant="outline" onClick={() => pruneMutation.mutate()} disabled={isMutating}>
                <Trash2 />
                Clear stopped
              </Button>
              <Button
                variant="warning"
                onClick={() => resetMutation.mutate()}
                disabled={isMutating || hasLiveDaemon}
                title={hasLiveDaemon ? "Stop the worker first" : undefined}
              >
                <Database />
                Reset data
              </Button>
            </div>

            {controlMessage ? (
              <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                {controlMessage}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>Status</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <SituationStat icon={AlertCircle} label="To review" value={reviewQueue.length} />
            <SituationStat icon={Siren} label="Blocked" value={blockedThreads.length} />
            <SituationStat icon={Play} label="Active runs" value={activeScans.length} />
            <SituationStat icon={Activity} label="Workers" value={activeWorkers.length} />
          </CardContent>
        </Card>
      </section>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>Needs your attention</CardTitle>
            </div>
            <Button asChild variant="ghost" size="sm">
              <NavLink to="/findings">View all</NavLink>
            </Button>
          </CardHeader>
          <CardContent>
            {needsAttention.length === 0 ? (
              <CardEmpty className="text-left">Nothing needs you right now.</CardEmpty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Finding</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead className="w-[14rem]">State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {needsAttention.map((group) => (
                    <TableRow key={group.fingerprint}>
                      <TableCell className="font-medium">
                        <NavLink to={`/findings/${group.fingerprint}`} className="text-foreground hover:text-primary-text">
                          {group.latest.title}
                        </NavLink>
                      </TableCell>
                      <TableCell>
                        <SeverityBadge severity={group.latest.severity} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
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
              <CardTitle>Activity</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {activeThreads.length === 0 ? (
              <CardEmpty className="text-left">Nothing running right now.</CardEmpty>
            ) : (
              <div className="space-y-3">
                {activeThreads.map((group) => (
                  <div key={group.fingerprint} className="rounded-lg border border-border bg-background px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <NavLink to={`/findings/${group.fingerprint}`} className="text-sm font-medium text-foreground hover:text-primary-text">
                          {group.latest.title}
                        </NavLink>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {group.workflow.activeAgentRoles.length > 0
                            ? group.workflow.activeAgentRoles.join(", ")
                            : "Waiting"}
                        </div>
                      </div>
                      <PhaseBadge value={group.workflow.phase} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <CardTitle>Workers</CardTitle>
              </div>
              {activeWorkers.length === 0 ? (
                <CardEmpty className="text-left">No workers running.</CardEmpty>
              ) : (
                <div className="space-y-3">
                  {activeWorkers.slice(0, 4).map((worker) => (
                    <div key={worker.id} className="rounded-lg border border-border bg-background px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">{worker.label}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {worker.currentWorkItemTitle ?? worker.currentWorkItemId ?? "Idle"}
                            {worker.currentCaseTarget ? ` · ${worker.currentCaseTarget}` : ""}
                            {` · last seen ${formatTime(worker.heartbeatAt)}`}
                          </div>
                          {worker.lastError ? <div className="mt-1 text-xs text-destructive">{worker.lastError}</div> : null}
                        </div>
                        <StatusBadge value={worker.status} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>Recent runs</CardTitle>
            </div>
            <Button asChild variant="ghost" size="sm">
              <NavLink to="/runs">View all</NavLink>
            </Button>
          </CardHeader>
          <CardContent>
            {recentRuns.length === 0 ? (
              <CardEmpty className="text-left">No runs yet.</CardEmpty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Target</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead className="w-[12rem]">State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRuns.map((scan) => (
                    <TableRow key={scan.id}>
                      <TableCell className="font-medium">
                        <NavLink to={`/runs/${scan.id}`} className="text-foreground hover:text-primary-text">
                          {scan.target}
                        </NavLink>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatTime(scan.startedAt)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <StatusBadge value={scan.status} />
                          <span className="text-xs text-muted-foreground">
                            {formatDuration(scan.durationMs)}
                          </span>
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
              <CardTitle>Recent findings</CardTitle>
            </div>
            <Button asChild variant="ghost" size="sm">
              <NavLink to="/findings">View all</NavLink>
            </Button>
          </CardHeader>
          <CardContent>
            {latestThreads.length === 0 ? (
              <CardEmpty className="text-left">No findings yet.</CardEmpty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Finding</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-[12rem]">State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {latestThreads.map((group) => (
                    <TableRow key={group.fingerprint}>
                      <TableCell className="font-medium">
                        <NavLink to={`/findings/${group.fingerprint}`} className="text-foreground hover:text-primary-text">
                          {group.latest.title}
                        </NavLink>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatTime(group.workflow.updatedAt ?? group.latest.timestamp)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <SeverityBadge severity={group.latest.severity} />
                          <PhaseBadge value={group.workflow.phase} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      {recentIncidents.length > 0 ? (
        <Card className="overflow-hidden border-destructive/20">
          <CardHeader>
            <div>
              <CardTitle>Errors</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentIncidents.map((incident) => (
              <div key={`${incident.scanId}:${incident.timestamp}`} className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <NavLink to={`/runs/${incident.scanId}`} className="text-sm font-medium text-foreground hover:text-primary-text">
                      {incident.scanTarget}
                    </NavLink>
                    <div className="mt-1 text-sm leading-6 text-muted-foreground">{incident.headline}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{formatTime(incident.timestamp)}</div>
                  </div>
                  <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle>Recent activity</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {recentEventsQuery.isLoading ? (
            <CardEmpty>Loading…</CardEmpty>
          ) : recentEventsQuery.error ? (
            <CardEmpty>{recentEventsQuery.error instanceof Error ? recentEventsQuery.error.message : "Couldn't load activity."}</CardEmpty>
          ) : (recentEventsQuery.data?.events.length ?? 0) === 0 ? (
            <CardEmpty>No activity yet.</CardEmpty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Target</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead className="w-[12rem]">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentEventsQuery.data?.events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="font-medium">
                      <div className="space-y-1">
                        <NavLink to={`/runs/${event.scanId}`} className="text-foreground hover:text-primary-text">
                          {event.scanTarget}
                        </NavLink>
                        {event.findingFingerprint ? (
                          <div>
                            <NavLink to={`/findings/${event.findingFingerprint}`} className="text-xs text-muted-foreground hover:text-primary-text">
                              Open finding
                            </NavLink>
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{event.summary}</TableCell>
                    <TableCell className="text-muted-foreground">{formatTime(event.timestamp)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SituationStat({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-lg border border-border bg-background px-4 py-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

function SelectionField({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-2">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select id={id} aria-label={label} value={value} onValueChange={onValueChange} options={options} />
    </div>
  );
}

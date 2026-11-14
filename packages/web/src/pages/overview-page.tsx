import { v } from "@/lib/vocabulary";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Power, RefreshCcw, Trash2 } from "lucide-react";
import { CapyDatabaseIcon as Database, CapyPlayIcon as Play } from "@/ui/icons/capy";
import { useBackendApi } from "@/api";
import { PageHeader, PageContent } from "@/components/page-header";
import { SeverityBadge } from "@/components/status-badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { DashboardResponse } from "@/types";

export function OverviewPage({ data }: { data: DashboardResponse }) {
  const { launchRun, pruneStoppedWorkers, recoverStaleWorkers, resetDatabase, startDaemon, stopDaemon } = useBackendApi();
  const queryClient = useQueryClient();
  const [controlMessage, setControlMessage] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [depth, setDepth] = useState<"quick" | "default" | "deep">("default");

  const activeScans = data.scans.filter((scan) => scan.status === "running");
  const activeWorkers = data.workers.filter((worker) => worker.isActive && worker.status !== "stopped");
  const hasLiveDaemon = activeWorkers.length > 0;


  const refreshDashboard = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["scans"] }),
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
      setControlMessage("Engine started.");
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
          ? `Stopped ${result.stopped} engine${result.stopped === 1 ? "" : "s"}.`
          : "No engine was running.",
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
    }),
    onSuccess: async () => {
      setControlMessage(`Run started for ${target.trim()}.`);
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
    .filter((group) => group.workflow.reviewGate !== "none" || group.workflow.phase === "blocked" || !group.workflow.assignee)
    .sort((left, right) => right.latest.timestamp - left.latest.timestamp)
    .slice(0, 5);

  return (
    <PageContent>
      <PageHeader
        title="Dashboard"
        actions={(
          <Button asChild variant="outline">
            <NavLink to="/findings">All findings</NavLink>
          </Button>
        )}
      />

      {controlMessage ? (
        <div role="status" className="text-sm text-muted-foreground">
          {controlMessage}
          {launchMutation.data && <NavLink to={`/chats/${launchMutation.data.sessionId}`} className="ml-2 underline">{v("Open {mission}")}</NavLink>}
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">New run</h2>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => { event.preventDefault(); if (target.trim() && !isMutating) launchMutation.mutate(); }}
        >
          <Input
            className="min-w-0 flex-1"
            aria-label="Target"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="Repository path or https://app.example.com"
          />
          <Select
            aria-label="Depth"
            value={depth}
            onValueChange={(value) => setDepth(value as typeof depth)}
            options={[{ value: "quick", label: "Quick" }, { value: "default", label: "Default" }, { value: "deep", label: "Deep" }]}
          />
          <Button type="submit" variant="accent" disabled={!target.trim() || isMutating}><Play />Start</Button>
        </form>
      </section>

      {needsAttention.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">Needs your attention</h2>
          <ul className="divide-y divide-border/60">
            {needsAttention.map((group) => (
              <li key={group.fingerprint ?? group.latest.id}>
                <NavLink
                  to={group.fingerprint ? `/findings/${encodeURIComponent(group.fingerprint)}` : "/findings"}
                  className="flex min-h-11 items-center justify-between gap-3 rounded px-2 text-sm hover:bg-secondary"
                >
                  <span className="min-w-0 truncate text-foreground">{group.latest.title}</span>
                  <span className="shrink-0"><SeverityBadge severity={group.latest.severity} /></span>
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          {hasLiveDaemon ? `${activeWorkers.length} engine${activeWorkers.length === 1 ? "" : "s"} running` : "No engine running"}
          {activeScans.length > 0 ? ` · ${activeScans.length} active run${activeScans.length === 1 ? "" : "s"}` : ""}
        </span>
        <span className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => (hasLiveDaemon ? stopDaemonMutation : startDaemonMutation).mutate()} disabled={isMutating}>
            <Power />{hasLiveDaemon ? "Stop engine" : "Start engine"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => recoverMutation.mutate()} disabled={isMutating}><RefreshCcw />Retry stuck</Button>
          <Button variant="ghost" size="sm" onClick={() => pruneMutation.mutate()} disabled={isMutating}><Trash2 />Clear stopped</Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { if (window.confirm("Reset all data? This cannot be undone.")) resetMutation.mutate(); }}
            disabled={isMutating}
          ><Database />Reset data</Button>
        </span>
      </section>
    </PageContent>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowUpRight, RefreshCcw, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/format";
import { LoadingDots } from "./loading-state";

/** Read-only workspace activity below the chat welcome. Uses the operations data source. */
export function HomeAnalytics() {
  const { getDashboard, listConsoleSessions, listSavedConsoleSessions } = useBackendApi();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: getDashboard, refetchInterval: 5000 });
  const sessions = useQuery({ queryKey: ["console-sessions"], queryFn: ({ signal }) => listConsoleSessions(signal), refetchInterval: 2000 });
  const saved = useQuery({ queryKey: ["console-saved"], queryFn: ({ signal }) => listSavedConsoleSessions(signal), refetchInterval: 5000 });
  const conversationIds = new Set([
    ...(sessions.data ?? []).flatMap(session => [session.id, ...(session.savedId ? [session.savedId] : [])]),
    ...(saved.data ?? []).map(session => session.id),
  ]);
  const savedScans = (dashboard.data?.scans ?? [])
    .filter(scan => Boolean(scan.target.trim()) && !scan.id.startsWith("console-") && !conversationIds.has(scan.id))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const findings = [...(dashboard.data?.groups ?? [])].sort((left, right) => right.latest.timestamp - left.latest.timestamp);
  const activeChats = (sessions.data ?? []).filter(session => ["working", "waiting"].includes(session.status));
  const activeFindings = findings.filter(group => group.workflow.phase === "in_progress" || group.workflow.activeAgentRoles.length > 0);
  const activeWorkers = (dashboard.data?.workers ?? []).filter(worker => worker.isActive && worker.status !== "stopped");
  const error = dashboard.error ?? sessions.error ?? saved.error;
  const loading = dashboard.isPending || sessions.isPending || saved.isPending;
  const refreshing = dashboard.isFetching || sessions.isFetching || saved.isFetching;
  const refresh = () => void Promise.all([dashboard.refetch(), sessions.refetch(), saved.refetch()]);
  const linkClass = "group flex min-w-0 items-start justify-between gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-muted/60 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground/40 motion-reduce:transition-none";

  return <section aria-labelledby="home-activity-heading" className="mx-auto w-full max-w-3xl space-y-8 px-6 py-12">
    <div className="flex items-center justify-between gap-3"><h2 id="home-activity-heading" className="text-lg font-medium">Workspace activity</h2><Button variant="ghost" size="icon-sm" aria-label="Refresh workspace activity" title="Refresh workspace activity" disabled={refreshing} onClick={refresh}><RefreshCcw className="size-4" /></Button></div>
    {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoadingDots />Loading workspace activity…</p>}
    {error && <div role="alert" className="space-y-2 text-sm"><p className="text-destructive">Couldn't load workspace activity. {error instanceof Error ? error.message : "Try refreshing."}</p><Button variant="ghost" size="sm" disabled={refreshing} onClick={refresh}>Try again</Button></div>}
    {!loading && !error && dashboard.data && <>
      <dl className="grid grid-cols-3 gap-6">
        {[{ label: "Runs", value: savedScans.length }, { label: "Findings", value: findings.length }, { label: "Active chats", value: activeChats.length }].map(stat => <div key={stat.label}><dt className="text-xs text-muted-foreground">{stat.label}</dt><dd className="mt-2 text-2xl font-medium">{stat.value}</dd></div>)}
      </dl>
      {activeChats.length > 0 && <section className="space-y-3"><h3 className="text-sm font-medium">Live chats</h3>{activeChats.slice(0, 4).map(chat => <Link key={chat.id} to={`/console/${encodeURIComponent(chat.id)}`} className={linkClass}><span className="min-w-0 truncate text-sm">{chat.title}</span><span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><LoadingDots className="console-loading-dots-compact" />{chat.status === "waiting" ? "Waiting for you" : "Working"}</span></Link>)}</section>}

      <div className="grid gap-8 sm:grid-cols-2">
        <section className="min-w-0 space-y-3"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Recent runs</h3><Link to="/runs" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">Reports<ArrowUpRight className="size-3" /></Link></div>
          {savedScans.length ? <ul className="-mx-3">{savedScans.slice(0, 4).map(scan => <li key={scan.id}><Link to={`/runs/${encodeURIComponent(scan.id)}`} className={linkClass}><div className="min-w-0"><p className="truncate text-sm">{scan.target}</p><p className="mt-1 text-xs text-muted-foreground">{formatTime(scan.startedAt)} · {scan.summary.totalFindings} finding{scan.summary.totalFindings === 1 ? "" : "s"}</p></div><span className="shrink-0 text-xs capitalize text-muted-foreground">{scan.status}</span></Link></li>)}</ul> : <p className="py-3 text-sm text-muted-foreground">No runs yet. Ask 0 to plan a workflow above.</p>}
        </section>
        <section className="min-w-0 space-y-3"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Recent findings</h3><Link to="/findings" className="flex items-center gap-1 text-xs text-muted-foreground">View all<ArrowUpRight className="size-3" /></Link></div>
          {findings.length ? <ul className="-mx-3">{findings.slice(0, 4).map(group => <li key={group.fingerprint}><Link to={`/findings/${encodeURIComponent(group.fingerprint)}`} className={linkClass}><div className="min-w-0"><p className="truncate text-sm">{group.latest.title}</p><p className="mt-1 text-xs text-muted-foreground">{group.workflow.phase.replaceAll("_", " ")}{group.workflow.reviewGate !== "none" ? " · Awaiting review" : ""}</p></div><span className="shrink-0 text-xs capitalize text-muted-foreground">{group.latest.severity}</span></Link></li>)}</ul> : <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><ShieldCheck className="size-4 shrink-0" />No findings recorded yet.</p>}
        </section>
      </div>
      <section className="space-y-3"><h3 className="flex items-center gap-2 text-sm font-medium"><Activity className="size-4 text-muted-foreground" />Agents and tasks</h3>
        {activeFindings.length === 0 && activeWorkers.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No workflow tasks running right now.</p> : <div className="grid gap-2 sm:grid-cols-2">
          {activeFindings.slice(0, 4).map(group => <Link key={group.fingerprint} to={`/findings/${encodeURIComponent(group.fingerprint)}`} className={linkClass}><div className="min-w-0"><p className="truncate text-sm">{group.latest.title}</p><p className="mt-1 text-xs text-muted-foreground">{group.workflow.activeAgentRoles.length ? group.workflow.activeAgentRoles.join(", ") : "In progress"}</p></div><LoadingDots className="console-loading-dots-compact" /></Link>)}
          {activeWorkers.slice(0, 4).map(worker => <div key={worker.id} className="rounded-xl px-3 py-3"><div className="flex items-center justify-between gap-3"><p className="truncate text-sm">{worker.label}</p><span className="text-xs capitalize text-muted-foreground">{worker.status}</span></div><p className="mt-1 truncate text-xs text-muted-foreground">{worker.currentWorkItemTitle ?? (worker.currentWorkItemId ? "Working on a workflow task" : "Worker is idle")}</p>{worker.lastError && <p className="mt-1 text-xs text-destructive">{worker.lastError}</p>}</div>)}
        </div>}
      </section>
    </>}
  </section>;
}

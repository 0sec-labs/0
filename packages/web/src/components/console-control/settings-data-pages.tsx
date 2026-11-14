import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/queries";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { StatusIcon, SeverityIcon } from "@/components/findings/finding-icons";
import { SEVERITY_LABELS, SEVERITY_ORDER, normalizeSeverity } from "@/console/panel/views/findings-model";
import { FIXES_WORKFLOWS_PATH, fixesFromWorkflows, type PanelFix } from "@/console/panel/views/fixes-model";
import { MAX_FIX_SCANS } from "@/components/findings/use-finding-fixes";
import { formatRelativeAge } from "@/lib/relative-time";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/components/table";
import { CapyArrowUpRightIcon } from "@/ui/icons/capy";
import type { DashboardResponse } from "@/types";
import type { Workflow } from "./contracts";
import { QueryState } from "./control-ui";
import { GitHubPublicationControl, useGitHubPublicationAccount } from "./github-publication-control";
import { SettingsLinkRow, SettingsRow, SettingsSection, SettingsValueRow } from "./settings-section";
import { activityStats, countLabel, findingStateRows, pullRequestRows, safePullRequestUrl } from "./settings-data-model";

function useDashboard() {
  const { getDashboard, client } = useBackendApi();
  return useQuery({ queryKey: queryKeys.dashboard(client.backendId), queryFn: getDashboard, staleTime: 30_000 });
}

/** Fixes of the most recent missions that produced findings. Shares its cache with the Findings page; fixes live on mission workflows. */
function useRecentFixes(dashboard: DashboardResponse | undefined) {
  const { client, webFetchJson } = useBackendApi();
  const ids = useMemo(() => {
    const latest = new Map<string, number>();
    for (const group of dashboard?.groups ?? []) latest.set(group.latest.scanId, Math.max(latest.get(group.latest.scanId) ?? 0, group.latest.timestamp));
    return [...latest].sort((a, b) => b[1] - a[1]).slice(0, MAX_FIX_SCANS).map(([id]) => id);
  }, [dashboard]);
  const results = useQueries({ queries: ids.map(scanId => ({
    queryKey: queryKeys.findingFixes(client.backendId, scanId),
    queryFn: ({ signal }: { signal: AbortSignal }) => webFetchJson<{ workflows: Workflow[] }>(FIXES_WORKFLOWS_PATH(scanId), { signal }),
    staleTime: 30_000, retry: false,
  })) });
  const stamp = results.map(result => result.dataUpdatedAt).join(",");
  const fixes = useMemo<PanelFix[]>(() => results.flatMap((result, index) => fixesFromWorkflows(result.data?.workflows, ids[index])),
    // `stamp` captures every result change; `results` is a new array on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stamp, ids]);
  return { fixes, loading: results.some(result => result.isPending) };
}

/** The fixed finding states, with how many findings sit in each. */
export function FindingStatesSettings() {
  const dashboard = useDashboard();
  const rows = findingStateRows(dashboard.data?.groups ?? []);
  return <div className="flex flex-col gap-10">
    <QueryState pending={dashboard.isPending} error={dashboard.error} retry={dashboard.refetch} />
    {dashboard.data && <SettingsSection id="setting-finding-states" title="States" description="States are fixed. Every finding moves through these, and people can set Backlog, Todo, In progress, Blocked, Done or Cancelled.">
      {rows.map(row => <SettingsRow key={row.status} id={`setting-finding-state-${row.status}`} label={<span className="flex items-center gap-2"><StatusIcon status={row.status} className="size-(--icon-sm)" />{row.label}</span>} badge={row.isDefault ? "Default" : undefined} description={row.kind}>
        <span className="flex items-center gap-3"><span className="text-sm tabular-nums text-muted-foreground-1" aria-label={countLabel(row.count, "finding")}>{row.count}</span><Button variant="ghost" size="sm" render={<Link to="/findings" />}>View</Button></span>
      </SettingsRow>)}
    </SettingsSection>}
  </div>;
}

const KPI = "flex min-w-0 flex-col gap-1 rounded-(--radius-card) border-[0.5px] border-border-1 bg-card p-4";
function Kpi({ label, value, note }: { label: string; value: number; note?: string }) {
  return <div className={KPI}><span className="text-sm text-muted-foreground-2">{label}</span><span className="text-2xl font-medium tabular-nums text-foreground">{value}</span>{note && <span className="text-xs text-muted-foreground-2">{note}</span>}</div>;
}
const headClass = "h-8 px-0 pr-4 text-xs font-normal text-muted-foreground-1 select-none";

/** The last seven days of work on this engine, counted from records it already holds. */
export function ActivitySettings() {
  const { listConsoleSessions, client } = useBackendApi();
  const dashboard = useDashboard();
  const sessions = useQuery({ queryKey: queryKeys.consoleSessions(client.backendId), queryFn: ({ signal }) => listConsoleSessions(signal), staleTime: 15_000, retry: false });
  const { fixes, loading } = useRecentFixes(dashboard.data);
  const stats = useMemo(() => dashboard.data ? activityStats({ scans: dashboard.data.scans, groups: dashboard.data.groups, sessions: sessions.data ?? [], fixes, now: Date.now() }) : undefined, [dashboard.data, sessions.data, fixes]);
  const allTime = useMemo(() => { const counts = Object.fromEntries(SEVERITY_ORDER.map(level => [level, 0])) as Record<(typeof SEVERITY_ORDER)[number], number>; for (const group of dashboard.data?.groups ?? []) counts[normalizeSeverity(group.latest.severity)] += 1; return counts; }, [dashboard.data]);
  return <div className="flex flex-col gap-10">
    <QueryState pending={dashboard.isPending} error={dashboard.error} retry={dashboard.refetch} />
    {stats && <>
      <SettingsSection id="setting-activity-week" title="Last 7 days" description="Counted from this engine's own records.">
        {stats.empty && !loading
          ? <p role="status" className="p-4 text-sm text-muted-foreground-2">Nothing in the last 7 days. Start a mission or a scan and its results will be counted here.</p>
          : <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
            <Kpi label="Missions" value={stats.missions} />
            <Kpi label="Scans completed" value={stats.scansCompleted} />
            <Kpi label="Findings" value={stats.findingsFound} />
            <Kpi label="Fixes proposed" value={stats.fixesProposed} note="Since this engine started" />
            <Kpi label="Fixes applied" value={stats.fixesApplied} note="Since this engine started" />
            <Kpi label="Pull requests opened" value={stats.pullRequests} note="Since this engine started" />
          </div>}
      </SettingsSection>
      <SettingsSection id="setting-activity-severity" title="Findings by severity" description="This week next to everything on record.">
        <div className="-mx-0 px-4 py-2">
          <Table aria-label="Findings by severity" className="text-xs">
            <TableHeader><TableRow className="border-b-[0.5px] border-border-1 hover:bg-transparent"><TableHead className={headClass}>Severity</TableHead><TableHead className={`${headClass} text-right`}>Last 7 days</TableHead><TableHead className={`${headClass} text-right`}>All time</TableHead></TableRow></TableHeader>
            <TableBody>{SEVERITY_ORDER.map(level => <TableRow key={level} className="border-0 hover:bg-transparent"><TableCell className="h-8 p-0 pr-4"><span className="flex items-center gap-2 text-foreground"><SeverityIcon severity={level} />{SEVERITY_LABELS[level]}</span></TableCell><TableCell className="h-8 p-0 pr-4 text-right tabular-nums">{stats.findingsBySeverity[level]}</TableCell><TableCell className="h-8 p-0 text-right tabular-nums">{allTime[level]}</TableCell></TableRow>)}</TableBody>
          </Table>
        </div>
      </SettingsSection>
      <p className="text-sm text-muted-foreground-2">Fix records are kept in memory, so fix counts restart when the engine does. Time spent is not recorded.</p>
    </>}
  </div>;
}

/** Publication status, the GitHub sign-in, and the pull requests this engine has opened. */
export function GitSettings() {
  const github = useGitHubPublicationAccount();
  const dashboard = useDashboard();
  const { fixes, loading } = useRecentFixes(dashboard.data);
  const prs = pullRequestRows(fixes);
  return <div className="flex flex-col gap-10">
    <SettingsSection id="settings-git-connection" title="GitHub" description="A published fix goes to a new branch and opens a pull request against the repository's current branch. There are no branch or PR defaults to set.">
      <QueryState pending={github.isPending} error={github.error} retry={github.refetch} />
      {github.data && <>
        <SettingsValueRow id="setting-git-status" label="Connection" description={github.data.available ? undefined : "GitHub isn't available on this computer."} value={github.data.connected ? "Connected" : "Not connected"} />
        {github.data.account && <SettingsValueRow id="setting-git-account" label="Account" value={github.data.account} />}
        {github.data.connected && github.data.scopes.length > 0 && <SettingsValueRow id="setting-git-scopes" label="Permissions" value={github.data.scopes.join(", ")} />}
      </>}
    </SettingsSection>
    <GitHubPublicationControl secondary />
    <SettingsSection id="setting-git-prs" title="Pull requests opened by 0" description="Opened from fixes since this engine started. Whether they are merged is not tracked here.">
      {prs.length === 0
        ? <p role="status" className="p-4 text-sm text-muted-foreground-2">{loading ? "Looking for pull requests…" : "No pull requests opened yet. Propose a fix on a finding, then publish it."}</p>
        : prs.map(pr => { const url = safePullRequestUrl(pr.url); return <SettingsRow key={pr.id} id={`setting-git-pr-${pr.id}`} label={pr.title} description={`${pr.branch}${pr.baseBranch ? ` into ${pr.baseBranch}` : ""} · ${formatRelativeAge(Date.parse(pr.updatedAt))}`}>
          {url ? <Button variant="ghost" size="sm" render={<a href={url} target="_blank" rel="noopener noreferrer" />}>Open<CapyArrowUpRightIcon className="size-(--icon-sm)" /></Button> : null}
        </SettingsRow>; })}
    </SettingsSection>
    <SettingsSection id="settings-git-links" title="Related">
      <SettingsLinkRow id="setting-git-fixes" to="/fix" title="Fixes" subtitle="Review, test and publish proposed fixes." />
      <SettingsLinkRow id="setting-git-findings" to="/findings" title="Findings" subtitle="Every finding and its state." />
    </SettingsSection>
  </div>;
}

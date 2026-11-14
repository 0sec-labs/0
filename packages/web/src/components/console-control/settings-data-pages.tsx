import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/queries";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { FIXES_WORKFLOWS_PATH, fixesFromWorkflows, type PanelFix } from "@/console/panel/views/fixes-model";
import { MAX_FIX_SCANS } from "@/components/findings/use-finding-fixes";
import { formatRelativeAge } from "@/lib/relative-time";
import { CapyArrowUpRightIcon } from "@/ui/icons/capy";
import type { DashboardResponse } from "@/types";
import type { Workflow } from "./contracts";
import { RepositoriesSettings } from "./repositories-control";
import { GitHubPublicationControl, useGitHubPublicationAccount } from "./github-publication-control";
import { SettingsRow, SettingsSection, SettingsValueRow } from "./settings-section";
import { pullRequestRows, safePullRequestUrl } from "./settings-data-model";

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

/** GitHub connection, the repositories it can reach, and the pull requests this engine has opened. */
export function GitSettings() {
  const github = useGitHubPublicationAccount();
  const dashboard = useDashboard();
  const { fixes, loading } = useRecentFixes(dashboard.data);
  const prs = pullRequestRows(fixes);
  return <div className="flex flex-col gap-10">
    {github.data?.connected && <SettingsSection id="settings-git-connection" title="Connected account" description="A published fix goes to a new branch and opens a pull request against the repository's current branch.">
      <SettingsValueRow id="setting-git-status" label="Connection" value="Connected" />
      {github.data.account && <SettingsValueRow id="setting-git-account" label="Account" value={github.data.account} />}
      {github.data.scopes.length > 0 && <SettingsValueRow id="setting-git-scopes" label="Permissions" value={github.data.scopes.join(", ")} />}
    </SettingsSection>}
    <GitHubPublicationControl secondary />
    <RepositoriesSettings embedded />
    <SettingsSection id="setting-git-prs" title="Pull requests opened by 0" description="Opened from fixes since this engine started. Whether they are merged is not tracked here.">
      {prs.length === 0
        ? <p role="status" className="p-4 text-sm text-muted-foreground-2">{loading ? "Looking for pull requests…" : "No pull requests opened yet."}</p>
        : prs.map(pr => { const url = safePullRequestUrl(pr.url); return <SettingsRow key={pr.id} id={`setting-git-pr-${pr.id}`} label={pr.title} description={`${pr.branch}${pr.baseBranch ? ` into ${pr.baseBranch}` : ""} · ${formatRelativeAge(Date.parse(pr.updatedAt))}`}>
          {url ? <Button variant="ghost" size="sm" render={<a href={url} target="_blank" rel="noopener noreferrer" />}>Open<CapyArrowUpRightIcon className="size-(--icon-sm)" /></Button> : null}
        </SettingsRow>; })}
    </SettingsSection>
  </div>;
}

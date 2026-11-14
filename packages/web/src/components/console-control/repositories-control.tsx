import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import { queryKeys } from "@/queries";
import { useBackendApi } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CapyArrowUpRightIcon } from "@/ui/icons/capy";
import { useSentinels } from "@/sentinels/api";
import { VOCAB } from "@/lib/vocabulary";
import { QueryState } from "./control-ui";
import { GitHubPublicationControl, useGitHubPublicationAccount } from "./github-publication-control";
import { SettingsRow, SettingsSection } from "./settings-section";
import { filterRepositories, repositoriesState, sentinelUsage, usedByLabel, visibilityLabel, type RepositoriesResponse } from "./repositories-model";

const MAX_VISIBLE = 100;

/** Repositories the signed-in gh account can access, and which Sentinels watch them. Read-only. `embedded` hides the connect prompt for pages that already show the GitHub connection. */
export function RepositoriesSettings({ embedded = false }: { embedded?: boolean }) {
  const { webFetchJson } = useBackendApi();
  const github = useGitHubPublicationAccount();
  const sentinels = useSentinels({ poll: false });
  const [search, setSearch] = useState("");
  const refresh = useRef(false);
  const account = github.data?.connected ? github.data.account : null;
  const repositories = useQuery({
    queryKey: queryKeys.consoleRepositories(account),
    queryFn: ({ signal }) => {
      const suffix = refresh.current ? "?refresh=1" : "";
      refresh.current = false;
      return webFetchJson<RepositoriesResponse>(`/api/console/repositories${suffix}`, { signal });
    },
    staleTime: 5 * 60_000, enabled: !github.isPending,
  });
  const data = repositories.data;
  const state = repositoriesState(data, repositories.isPending);
  const usage = sentinelUsage(sentinels.sentinels);
  const matches = data ? filterRepositories(data.repositories, search) : [];
  const shown = matches.slice(0, MAX_VISIBLE);
  const noun = VOCAB.sentinel;
  return <div className="flex flex-col gap-10">
    <QueryState pending={repositories.isPending} error={repositories.error} retry={repositories.refetch} label="Loading repositories…" />
    {state === "unavailable" && <SettingsSection id="settings-repositories-unavailable" title="GitHub CLI not found" description="Listing repositories needs the GitHub CLI (gh) on the computer running the engine.">
      <p role="status" className="p-4 text-sm text-muted-foreground-2">Install gh, then refresh this page.</p>
    </SettingsSection>}
    {state === "disconnected" && !embedded && <>
      <p role="status" className="text-sm text-muted-foreground-2">Connect GitHub to see the repositories your account can access.</p>
      <GitHubPublicationControl />
    </>}
    {(state === "ready" || state === "empty" || state === "error") && data && <SettingsSection id="settings-repositories" title={data.account ? `Repositories for ${data.account}` : "Repositories"}
      description={`Used for pull request review. ${data.fetchedAt ? "Cached for five minutes." : ""}`.trim()}
      action={<Button variant="ghost" size="sm" disabled={repositories.isFetching} onClick={() => { refresh.current = true; void repositories.refetch(); }}><RefreshCcw className="size-4" />Refresh</Button>}>
      <SettingsRow id="setting-repositories-search" label="Search" description={`${data.repositories.length} ${data.repositories.length === 1 ? "repository" : "repositories"}${data.truncated ? " (list truncated)" : ""}`}>
        <Input aria-label="Search repositories" type="search" className="w-56" placeholder="owner/name" value={search} onChange={event => setSearch(event.target.value)} />
      </SettingsRow>
      {state === "error" && <p role="alert" className="p-4 text-sm text-destructive">{data.error}</p>}
      {state === "empty" && <p role="status" className="p-4 text-sm text-muted-foreground-2">This account can't see any repositories yet.</p>}
      {state === "ready" && shown.length === 0 && <p role="status" className="p-4 text-sm text-muted-foreground-2">No repositories match "{search}".</p>}
      {shown.map(row => <SettingsRow key={row.nameWithOwner} id={`setting-repository-${row.nameWithOwner}`} label={row.nameWithOwner} badge={visibilityLabel(row)}
        description={`${row.defaultBranch ? `Default branch ${row.defaultBranch} · ` : ""}${usedByLabel(usage.get(row.nameWithOwner.toLowerCase()) ?? 0, noun)}`}>
        {(usage.get(row.nameWithOwner.toLowerCase()) ?? 0) > 0 && <Badge variant="secondary">{usage.get(row.nameWithOwner.toLowerCase())}</Badge>}
        <Button variant="ghost" size="sm" render={<a href={row.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${row.nameWithOwner} on GitHub`} />}>Open<CapyArrowUpRightIcon className="size-(--icon-sm)" /></Button>
      </SettingsRow>)}
      {matches.length > shown.length && <p className="p-4 text-sm text-muted-foreground-2">Showing the first {MAX_VISIBLE} of {matches.length}. Search to narrow the list.</p>}
    </SettingsSection>}
  </div>;
}

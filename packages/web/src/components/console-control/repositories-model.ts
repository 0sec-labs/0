/** Wire shape of GET /api/console/repositories, plus the pure view model for the Repositories page. */
export interface RepositoryRow { nameWithOwner: string; owner: string; name: string; visibility: "public" | "private" | "internal"; defaultBranch: string; url: string; archived: boolean }
export interface RepositoriesResponse { available: boolean; connected: boolean; account: string | null; repositories: RepositoryRow[]; truncated: boolean; fetchedAt: string | null; error: string | null }

/** `owner/name` in lower case from a scope entry that may be a GitHub URL, an ssh remote or a `.git` name. Null when it is not a GitHub repository. */
export function repoKey(entry: string): string | null {
  let text = entry.trim().replace(/^git@github\.com:/i, "").replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  text = text.split(/[?#]/)[0]!;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/.*)?$/.exec(text);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** How many Sentinels list each repository in their scope. A Sentinel counts once per repository. */
export function sentinelUsage(sentinels: readonly { scope: { repos: readonly string[] } }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sentinel of sentinels) {
    const keys = new Set(sentinel.scope.repos.map(repoKey).filter((key): key is string => key !== null));
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export const usedByLabel = (count: number, noun: { singular: string; plural: string }): string =>
  count === 0 ? "Not used by any " + noun.singular : `Used by ${count} ${count === 1 ? noun.singular : noun.plural}`;

export function filterRepositories(rows: readonly RepositoryRow[], query: string): RepositoryRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? rows.filter(row => terms.every(term => `${row.nameWithOwner} ${row.visibility} ${row.defaultBranch}`.toLowerCase().includes(term))) : [...rows];
}

export const visibilityLabel = (row: RepositoryRow): string => `${row.visibility[0]!.toUpperCase()}${row.visibility.slice(1)}${row.archived ? " · archived" : ""}`;

export type RepositoriesState = "loading" | "unavailable" | "disconnected" | "error" | "empty" | "ready";
export function repositoriesState(data: RepositoriesResponse | undefined, pending: boolean): RepositoriesState {
  if (!data) return pending ? "loading" : "error";
  if (!data.available) return "unavailable";
  if (!data.connected) return "disconnected";
  if (data.error) return "error";
  return data.repositories.length === 0 ? "empty" : "ready";
}

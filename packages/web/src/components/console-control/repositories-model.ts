/** Wire shape of GET /api/console/repositories, plus the pure view model for the Repositories page. */
export interface RepositoryRow { nameWithOwner: string; owner: string; name: string; visibility: "public" | "private" | "internal"; defaultBranch: string; url: string; archived: boolean }
export interface RepositoriesResponse { available: boolean; connected: boolean; account: string | null; repositories: RepositoryRow[]; truncated: boolean; fetchedAt: string | null; error: string | null }

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

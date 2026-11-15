import { describe, expect, it } from "vitest";
import { filterRepositories, repoKey, repositoriesState, sentinelUsage, usedByLabel, type RepositoriesResponse, type RepositoryRow } from "./repositories-model";

const row = (nameWithOwner: string, patch: Partial<RepositoryRow> = {}): RepositoryRow => { const [owner, name] = nameWithOwner.split("/") as [string, string]; return { nameWithOwner, owner, name, visibility: "private", defaultBranch: "main", url: `https://github.com/${nameWithOwner}`, archived: false, ...patch }; };
const response = (patch: Partial<RepositoriesResponse>): RepositoriesResponse => ({ available: true, connected: true, account: "octo", repositories: [], truncated: false, fetchedAt: null, error: null, ...patch });

describe("repositories model", () => {
  it("normalises scope entries", () => {
    expect(repoKey("Acme/API")).toBe("acme/api");
    expect(repoKey("https://github.com/acme/api.git")).toBe("acme/api");
    expect(repoKey("git@github.com:acme/api.git")).toBe("acme/api");
    expect(repoKey("github.com/acme/api/tree/main")).toBe("acme/api");
    expect(repoKey("not a repo")).toBeNull();
    expect(repoKey("")).toBeNull();
  });
  it("counts each Agent once per repository", () => {
    const usage = sentinelUsage([{ scope: { repos: ["acme/api", "https://github.com/acme/api", "acme/web"] } }, { scope: { repos: ["ACME/api"] } }, { scope: { repos: [] } }]);
    expect(usage.get("acme/api")).toBe(2);
    expect(usage.get("acme/web")).toBe(1);
    expect(usedByLabel(0, { singular: "Agent", plural: "Agents" })).toBe("Not used by any Agent");
    expect(usedByLabel(1, { singular: "Agent", plural: "Agents" })).toBe("Used by 1 Agent");
    expect(usedByLabel(2, { singular: "Agent", plural: "Agents" })).toBe("Used by 2 Agents");
  });
  it("searches name, visibility and branch", () => {
    const rows = [row("acme/api"), row("acme/site", { visibility: "public", defaultBranch: "trunk" })];
    expect(filterRepositories(rows, "api").map(r => r.name)).toEqual(["api"]);
    expect(filterRepositories(rows, "public").map(r => r.name)).toEqual(["site"]);
    expect(filterRepositories(rows, "trunk")).toHaveLength(1);
    expect(filterRepositories(rows, "")).toHaveLength(2);
  });
  it("derives honest page states", () => {
    expect(repositoriesState(undefined, true)).toBe("loading");
    expect(repositoriesState(undefined, false)).toBe("error");
    expect(repositoriesState(response({ available: false, connected: false }), false)).toBe("unavailable");
    expect(repositoriesState(response({ connected: false }), false)).toBe("disconnected");
    expect(repositoriesState(response({ error: "x" }), false)).toBe("error");
    expect(repositoriesState(response({}), false)).toBe("empty");
    expect(repositoriesState(response({ repositories: [row("a/b")] }), false)).toBe("ready");
  });
});

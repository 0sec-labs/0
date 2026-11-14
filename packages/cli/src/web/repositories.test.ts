import { describe, expect, it, vi } from "vitest";
import { RepositoryCatalog, handleRepositoriesRequest, parseRepositoryLines, type RepositoryGh } from "./repositories.js";

const line = (full: string, extra: Record<string, unknown> = {}) => JSON.stringify(JSON.stringify({ f: full, v: "private", b: "main", u: `https://github.com/${full}`, a: false, ...extra }));
const connected = async () => ({ available: true, connected: true, account: "octo" });

describe("repository catalog", () => {
  it("parses gh lines, skipping malformed rows and unsafe urls", () => {
    const rows = parseRepositoryLines([line("acme/api"), "not json", line("bad name/x"), line("acme/web", { v: "public", u: "javascript:alert(1)", a: true })].join("\n"));
    expect(rows.map(row => row.nameWithOwner)).toEqual(["acme/api", "acme/web"]);
    expect(rows[1]).toMatchObject({ visibility: "public", url: "https://github.com/acme/web", archived: true, owner: "acme", name: "web", defaultBranch: "main" });
  });
  it("caches for five minutes per account and honours refresh", async () => {
    let now = 1_000;
    const run = vi.fn(async () => ({ stdout: line("acme/api") }));
    const catalog = new RepositoryCatalog({ status: connected, gh: { run } satisfies RepositoryGh, now: () => now });
    expect((await catalog.list()).repositories).toHaveLength(1);
    await catalog.list(); expect(run).toHaveBeenCalledTimes(1);
    now += 4 * 60_000; await catalog.list(); expect(run).toHaveBeenCalledTimes(1);
    await catalog.list({ refresh: true }); expect(run).toHaveBeenCalledTimes(2);
    now += 6 * 60_000; await catalog.list(); expect(run).toHaveBeenCalledTimes(3);
  });
  it("reports a disconnected or missing gh without calling it", async () => {
    const run = vi.fn();
    for (const status of [{ available: true, connected: false, account: null }, { available: false, connected: false, account: null }]) {
      const result = await new RepositoryCatalog({ status: async () => status, gh: { run } }).list();
      expect(result).toMatchObject({ ...status, repositories: [], error: null });
    }
    expect(run).not.toHaveBeenCalled();
  });
  it("hides gh errors (which can carry tokens) and does not cache failures", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("HTTP 401 token ghp_SECRET")).mockResolvedValueOnce({ stdout: line("acme/api") });
    const catalog = new RepositoryCatalog({ status: connected, gh: { run } });
    const failed = await catalog.list();
    expect(JSON.stringify(failed)).not.toContain("ghp_SECRET");
    expect(failed.error).toBeTruthy();
    expect((await catalog.list()).repositories).toHaveLength(1);
  });
  it("serves GET only on /repositories", async () => {
    const catalog = new RepositoryCatalog({ status: connected, gh: { run: async () => ({ stdout: line("acme/api") }) } });
    expect(await handleRepositoriesRequest(catalog, "settings", "GET", new URLSearchParams())).toBeNull();
    expect(await handleRepositoriesRequest(catalog, "repositories", "POST", new URLSearchParams())).toMatchObject({ status: 405 });
    expect(await handleRepositoriesRequest(catalog, "repositories", "GET", new URLSearchParams())).toMatchObject({ status: 200, data: { account: "octo" } });
  });
});

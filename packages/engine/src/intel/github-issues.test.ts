import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPublicReportQuery, searchGitHubIssues } from "./github-issues.js";

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

const SEARCH_RESPONSE = {
  total_count: 2,
  items: [
    {
      title: "Blob replication leaks remote credentials",
      html_url: "https://github.com/uber/kraken/issues/42",
      state: "open",
      number: 42,
      created_at: "2023-05-01T00:00:00Z",
      body: "  ReplicateToRemote\n\nsends the blob to the wrong host  ",
    },
    {
      title: "Fix ReplicateToRemote target",
      html_url: "https://github.com/uber/kraken/pull/43",
      state: "closed",
      number: 43,
      pull_request: { url: "https://api.github.com/repos/uber/kraken/pulls/43" },
      created_at: "2023-06-01T00:00:00Z",
      body: null,
    },
  ],
};

describe("github public-report search", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "0-issues-test-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("builds a scoped q string with repo, type qualifier, and free terms", () => {
    expect(buildPublicReportQuery({ repository: "uber/kraken", terms: "ReplicateToRemote remote", type: "issue" }))
      .toBe("repo:uber/kraken is:issue ReplicateToRemote remote");
    expect(buildPublicReportQuery({ repository: "https://github.com/uber/kraken", terms: "blob" }))
      .toBe("repo:uber/kraken blob");
    expect(buildPublicReportQuery({ terms: "SSRF" })).toBe("SSRF");
  });

  it("searches issues+PRs and returns bounded, snippet-trimmed leads", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.github.com/search/issues");
      expect(url.searchParams.get("q")).toContain("repo:uber/kraken");
      expect(url.searchParams.get("per_page")).toBe("10");
      return json(SEARCH_RESPONSE);
    }) as unknown as typeof fetch;

    const result = await searchGitHubIssues(
      { repository: "uber/kraken", terms: "ReplicateToRemote", limit: 10, cacheDir },
      { fetchImpl: fetchMock },
    );

    expect(result.query).toContain("repo:uber/kraken");
    expect(result.totalCount).toBe(2);
    expect(result.reports).toHaveLength(2);
    expect(result.reports[0]?.isPullRequest).toBe(false);
    expect(result.reports[0]?.bodySnippet).toBe("ReplicateToRemote sends the blob to the wrong host");
    expect(result.reports[1]?.isPullRequest).toBe(true);
    expect(result.provenance.unverified).toBe(true);
  });

  it("surfaces a descriptive rate-limit error on HTTP 403", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" },
    })) as unknown as typeof fetch;

    await expect(searchGitHubIssues(
      { repository: "uber/kraken", terms: "blob", cacheDir },
      { fetchImpl: fetchMock },
    )).rejects.toThrow(/rate limit/i);
  });

  it("throws on offline cache miss instead of hitting the network", async () => {
    const fetchMock = vi.fn(async () => json(SEARCH_RESPONSE)) as unknown as typeof fetch;
    await expect(searchGitHubIssues(
      { repository: "uber/kraken", terms: "blob", offline: true, cacheDir },
      { fetchImpl: fetchMock },
    )).rejects.toThrow(/offline cache miss/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires at least a repository or terms", async () => {
    await expect(searchGitHubIssues({ cacheDir })).rejects.toThrow(/repository/i);
  });

  it("authenticates search requests with an env GitHub token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_envtoken123");
    let sawAuth: string | null = null;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      sawAuth = new Headers(init?.headers).get("authorization");
      return json(SEARCH_RESPONSE);
    }) as unknown as typeof fetch;

    await searchGitHubIssues({ repository: "uber/kraken", terms: "blob", cacheDir }, { fetchImpl: fetchMock });
    expect(sawAuth).toBe("Bearer ghp_envtoken123");
  });
});

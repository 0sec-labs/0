import { cachedJson, IntelCache } from "./cache.js";
import { githubHeaders } from "./github.js";
import { normalizeRepositoryHint } from "./target-history.js";
import type {
  FetchOptions,
  PublicReport,
  PublicReportSearchInput,
  PublicReportSearchResult,
} from "./types.js";

/**
 * "Layer 3" public-report search (0sec#intel-advisories).
 *
 * For a candidate finding, searching GitHub ISSUES and PRs by specific code
 * terms (e.g. `repo:uber/kraken ReplicateToRemote remote blob replicate`)
 * surfaces public reports that never became formal advisories. This module
 * calls `GET /search/issues` — GitHub's combined issue+PR search — and returns
 * a bounded, unverified list of leads.
 *
 * Auth / rate-limit: githubHeaders() attaches `Authorization: Bearer <token>`
 * from GITHUB_TOKEN/GH_TOKEN when present. The search API is rate-limited far
 * more aggressively than the REST API (30 req/min authenticated, ~10/min
 * unauthenticated); on a 403/429 we surface a descriptive rate-limit error so
 * the caller can back off rather than silently returning zero leads.
 */

const GITHUB_SEARCH_URL = "https://api.github.com/search/issues";
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;
const SNIPPET_LENGTH = 280;

interface GitHubSearchIssue {
  title?: string;
  html_url?: string;
  state?: string;
  number?: number;
  pull_request?: unknown;
  created_at?: string;
  body?: string | null;
}

interface GitHubSearchResponse {
  total_count?: number;
  items?: GitHubSearchIssue[];
}

/**
 * Build the `q` string: `repo:owner/repo` (when a repository is given) followed
 * by an `is:issue`/`is:pr` qualifier (omitted for "any", the default, which
 * matches both) and the free-text code terms verbatim.
 */
export function buildPublicReportQuery(input: PublicReportSearchInput): string {
  const parts: string[] = [];
  const repo = normalizeRepositoryHint(input.repository) ?? input.repository?.trim();
  if (repo) parts.push(`repo:${repo}`);
  if (input.type === "issue") parts.push("is:issue");
  else if (input.type === "pr") parts.push("is:pr");
  const terms = input.terms?.trim();
  if (terms) parts.push(terms);
  return parts.join(" ").trim();
}

export async function searchGitHubIssues(
  input: PublicReportSearchInput,
  opts: FetchOptions = {},
): Promise<PublicReportSearchResult> {
  const q = buildPublicReportQuery(input);
  if (!q) {
    throw new Error("search_public_reports requires repository and/or terms");
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const cache = new IntelCache(input.cacheDir);
  const key = JSON.stringify({ q, limit });
  const raw = await cachedJson<GitHubSearchResponse>(
    cache,
    "github-issues",
    key,
    async () => {
      const query = new URLSearchParams({
        q,
        per_page: String(limit),
        sort: "updated",
        order: "desc",
      });
      return await fetchGitHubIssueSearch(`${GITHUB_SEARCH_URL}?${query}`, opts);
    },
    { offline: input.offline, ttlMs: input.ttlMs },
  );
  const reports = (raw.items ?? []).slice(0, limit).flatMap(parseIssue);
  return {
    query: q,
    totalCount: typeof raw.total_count === "number" ? raw.total_count : reports.length,
    reports,
    provenance: {
      source: "github",
      offline: input.offline || undefined,
      unverified: true,
    },
  };
}

async function fetchGitHubIssueSearch(url: string, opts: FetchOptions): Promise<GitHubSearchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      headers: githubHeaders(opts.headers),
      signal: controller.signal,
    });
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = res.headers.get("x-ratelimit-reset");
      throw new Error(
        `GitHub search rate limit (HTTP ${res.status}) for ${url}` +
        (remaining ? ` — remaining ${remaining}` : "") +
        (reset ? `, resets at ${reset}` : "") +
        " (set GITHUB_TOKEN/GH_TOKEN to raise the limit)",
      );
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json() as GitHubSearchResponse;
  } finally {
    clearTimeout(timer);
  }
}

function parseIssue(item: GitHubSearchIssue): PublicReport[] {
  if (!item.html_url || typeof item.number !== "number") return [];
  return [{
    title: item.title ?? `#${item.number}`,
    url: item.html_url,
    state: item.state ?? "unknown",
    number: item.number,
    isPullRequest: item.pull_request != null,
    createdAt: item.created_at,
    bodySnippet: snippet(item.body),
  }];
}

function snippet(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > SNIPPET_LENGTH ? `${collapsed.slice(0, SNIPPET_LENGTH)}…` : collapsed;
}

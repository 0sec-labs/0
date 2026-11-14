import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const CACHE_MS = 5 * 60_000;
const MAX_REPOSITORIES = 500;

export interface RepositoryRow { nameWithOwner: string; owner: string; name: string; visibility: "public" | "private" | "internal"; defaultBranch: string; url: string; archived: boolean }
export interface RepositoriesResponse {
  /** gh is installed on this host. */
  available: boolean;
  /** gh holds a signed-in github.com account. */
  connected: boolean;
  account: string | null;
  repositories: RepositoryRow[];
  truncated: boolean;
  fetchedAt: string | null;
  /** A short, token-free reason when the list could not be read although gh is connected. */
  error: string | null;
}
export interface RepositoryGh { run(args: string[]): Promise<{ stdout: string }> }
export interface RepositoryAccountStatus { available: boolean; connected: boolean; account: string | null }

export const defaultRepositoryGh: RepositoryGh = { run: args => execute("gh", args, { timeout: 60_000, maxBuffer: 16_000_000 }).then(({ stdout }) => ({ stdout })) };

const jq = "[.[] | {f: .full_name, v: (.visibility // (if .private then \"private\" else \"public\" end)), b: .default_branch, u: .html_url, a: .archived}] | .[] | @json";

/** Parses `gh api --paginate --jq` output: one compact JSON object per line. Malformed lines are skipped. */
export function parseRepositoryLines(stdout: string): RepositoryRow[] {
  const rows: RepositoryRow[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let value: unknown;
    try { value = JSON.parse(text); if (typeof value === "string") value = JSON.parse(value); } catch { continue; }
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const full = typeof item["f"] === "string" ? item["f"] : "";
    const match = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(full);
    if (!match) continue;
    const visibility = item["v"] === "private" || item["v"] === "internal" ? item["v"] : "public";
    const url = typeof item["u"] === "string" && /^https:\/\/github\.com\//.test(item["u"]) ? item["u"] : `https://github.com/${full}`;
    rows.push({ nameWithOwner: full, owner: match[1]!, name: match[2]!, visibility, defaultBranch: typeof item["b"] === "string" ? item["b"].slice(0, 200) : "", url, archived: item["a"] === true });
  }
  return rows;
}

/** Repositories the signed-in gh account can access, cached for five minutes per account. Read-only; the token never leaves gh. */
export class RepositoryCatalog {
  readonly #gh: RepositoryGh;
  readonly #status: () => Promise<RepositoryAccountStatus>;
  readonly #now: () => number;
  #cache: { account: string; at: number; value: RepositoriesResponse } | null = null;
  #inflight: Promise<RepositoriesResponse> | null = null;
  constructor(options: { status: () => Promise<RepositoryAccountStatus>; gh?: RepositoryGh; now?: () => number }) {
    this.#status = options.status; this.#gh = options.gh ?? defaultRepositoryGh; this.#now = options.now ?? Date.now;
  }

  async list(options: { refresh?: boolean } = {}): Promise<RepositoriesResponse> {
    const status = await this.#status();
    if (!status.available || !status.connected || !status.account) {
      this.#cache = null;
      return { available: status.available, connected: status.connected, account: status.account, repositories: [], truncated: false, fetchedAt: null, error: null };
    }
    const cached = this.#cache;
    if (!options.refresh && cached && cached.account === status.account && this.#now() - cached.at < CACHE_MS) return cached.value;
    if (this.#inflight) return this.#inflight;
    const account = status.account;
    this.#inflight = this.#fetch(account).finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  async #fetch(account: string): Promise<RepositoriesResponse> {
    const at = this.#now();
    try {
      const { stdout } = await this.#gh.run(["api", "--paginate", "--hostname", "github.com", "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member", "--jq", jq]);
      const all = parseRepositoryLines(stdout);
      const value: RepositoriesResponse = { available: true, connected: true, account, repositories: all.slice(0, MAX_REPOSITORIES), truncated: all.length > MAX_REPOSITORIES, fetchedAt: new Date(at).toISOString(), error: null };
      this.#cache = { account, at, value };
      return value;
    } catch {
      // gh's stderr can echo request details; report a fixed reason instead and never cache a failure.
      return { available: true, connected: true, account, repositories: [], truncated: false, fetchedAt: null, error: "GitHub could not be read with the connected gh account. Try again in a moment." };
    }
  }
}

export interface RepositoriesRoute { status: number; data: unknown }
/** GET /api/console/repositories. Returns null for any other path so the caller keeps routing. */
export async function handleRepositoriesRequest(catalog: RepositoryCatalog, path: string, method: string, query: URLSearchParams): Promise<RepositoriesRoute | null> {
  if (path !== "repositories") return null;
  if (method !== "GET" && method !== "HEAD") return { status: 405, data: { error: "Method not allowed." } };
  return { status: 200, data: await catalog.list({ refresh: query.get("refresh") === "1" }) };
}

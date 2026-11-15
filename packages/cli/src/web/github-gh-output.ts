/** Pure parsers for GitHub CLI output. Nothing here runs a process or sees a token. */

export const GITHUB_DEVICE_URL = "https://github.com/login/device";
/** Scopes pull requests and repository listing need on a classic/OAuth login. */
export const REQUIRED_GITHUB_SCOPES: readonly string[] = ["repo"];
export const GITHUB_SCOPE_REFRESH_HINT = "gh auth refresh -s repo";
export const GITHUB_SIGN_IN_SCOPES = "repo,read:org";

export type GithubTokenSource = "cli" | "environment";
export interface GithubAuthStatus { connected: boolean; account: string | null; scopes: string[]; source: GithubTokenSource | null }

const codePattern = /(?:one-time|device|verification) code[^A-Z0-9]*([A-Z0-9]{4}-[A-Z0-9]{4})\b/i;

/** Extracts the one-time code from `gh auth login --web` output. The URL is always GitHub's fixed device page, never taken from output. */
export function parseDeviceCode(output: string): { userCode: string; verificationUrl: string } | null {
  const code = codePattern.exec(output.slice(-8_000))?.[1];
  return code ? { userCode: code.toUpperCase(), verificationUrl: GITHUB_DEVICE_URL } : null;
}

export function splitScopes(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
  return [...new Set(list.filter((item): item is string => typeof item === "string").map(item => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean))].slice(0, 50);
}

/** Reads `gh auth status --json hosts` defensively. Malformed input is "not connected". */
export function parseAuthStatus(stdout: string): GithubAuthStatus {
  const none: GithubAuthStatus = { connected: false, account: null, scopes: [], source: null };
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return none; }
  const hosts = parsed && typeof parsed === "object" && "hosts" in parsed ? parsed.hosts : null;
  const accounts = hosts && typeof hosts === "object" && "github.com" in hosts ? hosts["github.com"] : null;
  if (!Array.isArray(accounts)) return none;
  const entry = accounts.find((item: unknown) => item && typeof item === "object" && "active" in item && item.active === true);
  if (!entry || typeof entry !== "object") return none;
  const record = entry as Record<string, unknown>;
  const login = typeof record["login"] === "string" && /^[A-Za-z0-9-]{1,39}$/.test(record["login"]) ? record["login"] : null;
  const tokenSource = typeof record["tokenSource"] === "string" ? record["tokenSource"] : "";
  return {
    connected: record["state"] === "success",
    account: login,
    scopes: splitScopes(record["scopes"]),
    source: record["state"] === "success" ? (/^(?:GH|GITHUB)_[A-Z_]*TOKEN$/.test(tokenSource) ? "environment" : "cli") : null,
  };
}

/**
 * Scopes a classic or OAuth login lacks. Fine-grained tokens report no scopes at all, so an empty list
 * is "unknown" and never reported as missing.
 */
export function missingScopes(scopes: readonly string[]): string[] {
  if (scopes.length === 0) return [];
  return REQUIRED_GITHUB_SCOPES.filter(required => !scopes.includes(required));
}

/** `github-authentication-token-expiration: 2026-12-01 00:00:00 UTC` from `gh api --include` output. */
export function parseTokenExpiry(headers: string): string | null {
  const value = /^github-authentication-token-expiration:\s*(.+?)\s*$/im.exec(headers)?.[1];
  if (!value) return null;
  const time = Date.parse(value.replace(/ UTC$/, "Z").replace(" ", "T"));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Maps `gh auth login --with-token` stderr to a user-safe failure. Never echoes the raw text. */
export function classifyLoginFailure(stderr: string): "rejected" | "storage" | "unknown" {
  if (/keyring|keychain|write|permission denied|read-only/i.test(stderr)) return "storage";
  if (/401|bad credentials|invalid|authentication failed|not accept|scope|token/i.test(stderr)) return "rejected";
  return "unknown";
}

/** Environment for a sign-in child process: a fixed allowlist, so ambient GH_TOKEN/GITHUB_TOKEN or proxies with credentials never reach it. */
export function scrubbedGhEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TMPDIR|TERM|XDG_[A-Z_]+|SSL_CERT_FILE|SSL_CERT_DIR|SYSTEMROOT|APPDATA|LOCALAPPDATA|USERPROFILE|GH_CONFIG_DIR)$/;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && allowed.test(key)) env[key] = value;
  env["BROWSER"] = "true"; env["GH_BROWSER"] = "true"; env["NO_COLOR"] = "1";
  return env;
}

export type GitHubPhase = "idle" | "running" | "connected" | "failed" | "cancelled" | "timeout" | "unavailable";
export interface GitHubPublicationAccount {
  available: boolean;
  connected: boolean;
  account: string | null;
  scopes: string[];
  missingScopes: string[];
  refreshCommand: string | null;
  source: "cli" | "environment" | null;
  expiresAt: string | null;
  computer: string;
  deviceAuth: { phase: GitHubPhase; message: string; verificationUrl?: string; userCode?: string };
}

export type GitHubCardKind = "unavailable" | "not-connected" | "signing-in" | "needs-permissions" | "connected";
export type GitHubMethod = "cli" | "sign-in" | "token";

export const GITHUB_INSTALL_COMMAND = "brew install gh";
export const GITHUB_INSTALL_URL = "https://cli.github.com";
export const GITHUB_DEVICE_PAGE = "https://github.com/login/device";

export function githubCardKind(account: GitHubPublicationAccount): GitHubCardKind {
  if (account.deviceAuth.phase === "running") return "signing-in";
  if (account.connected) return account.missingScopes.length > 0 ? "needs-permissions" : "connected";
  return account.available ? "not-connected" : "unavailable";
}

export function githubSourceLabel(source: GitHubPublicationAccount["source"]): string {
  return source === "environment" ? "token" : "GitHub CLI";
}

/** Headline for the card: who is connected and through what, or what is missing. */
export function githubHeadline(account: GitHubPublicationAccount): string {
  const kind = githubCardKind(account);
  const who = account.account ?? "GitHub";
  if (kind === "connected") return `Connected as ${who} via ${githubSourceLabel(account.source)}`;
  if (kind === "needs-permissions") return `Needs permissions: ${account.missingScopes.join(", ")}`;
  if (kind === "signing-in") return "Signing in";
  return "Not connected";
}

/** Ordered connection options. The CLI login is only listed once it exists on this computer. */
export function githubMethods(account: GitHubPublicationAccount): { value: GitHubMethod; label: string }[] {
  const methods: { value: GitHubMethod; label: string }[] = [];
  if (account.connected && account.source === "cli" && account.account) methods.push({ value: "cli", label: `GitHub CLI login (${account.account})` });
  methods.push({ value: "sign-in", label: "Sign in with GitHub" }, { value: "token", label: "Fine-grained token" });
  return methods;
}

/** One selector only when several methods exist and they ask for different input; one method is just a Connect button. */
export function showMethodSelector(methods: readonly { value: GitHubMethod }[]): boolean {
  const input = (method: GitHubMethod) => method === "token" ? "token" : "none";
  return methods.length > 1 && new Set(methods.map(item => input(item.value))).size > 1;
}

/** The sign-in button repeats nothing the selector already says. */
export const githubConnectLabel = (account: Pick<GitHubPublicationAccount, "connected">): string => account.connected ? "Sign in with another account" : "Connect";

export function defaultGitHubMethod(account: GitHubPublicationAccount): GitHubMethod {
  return githubMethods(account)[0]!.value;
}

/** Text for the live device sign-in status. */
export function deviceStatusText(auth: GitHubPublicationAccount["deviceAuth"]): string | null {
  if (auth.phase === "running") return auth.userCode ? `Enter code ${auth.userCode} at github.com/login/device` : "Waiting for a code from GitHub";
  if (auth.phase === "timeout") return "The code expired. Try again.";
  if (auth.phase === "cancelled") return "Sign-in cancelled.";
  if (auth.phase === "failed") return auth.message || "Sign-in failed.";
  return null;
}

/** The URL is only opened when it is exactly GitHub's device page. */
export function safeDeviceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.port && /^\/login\/device\/?$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

/** GitHub's fine-grained token page, prefilled with what pull requests need. Permissions are `name=level`. */
export function guidedTokenUrl(computer?: string): string {
  const params = new URLSearchParams({
    name: "0 security".slice(0, 40),
    description: `Pull requests and repository access for 0${computer ? ` on ${computer}` : ""}`,
    expires_in: "90",
    metadata: "read",
    contents: "write",
    pull_requests: "write",
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

export function validToken(value: string): boolean {
  const token = value.trim();
  return token.length > 0 && token.length <= 16384 && !/\s/.test(token);
}

export function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

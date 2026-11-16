import { describe, expect, it } from "vitest";
import { defaultGitHubMethod, deviceStatusText, formatExpiry, githubCardKind, githubHeadline, githubConnectLabel, githubMethods, guidedTokenUrl, showMethodSelector, safeDeviceUrl, validToken, type GitHubPublicationAccount } from "./github-connection-model";

const account = (patch: Partial<GitHubPublicationAccount> = {}): GitHubPublicationAccount => ({
  available: true, connected: false, account: null, scopes: [], missingScopes: [], refreshCommand: null, source: null, expiresAt: null, computer: "mini", deviceAuth: { phase: "idle", message: "" }, ...patch,
});
const connected = (patch: Partial<GitHubPublicationAccount> = {}) => account({ connected: true, account: "octocat", source: "cli", scopes: ["repo"], ...patch });

describe("github card states", () => {
  it("covers every state", () => {
    expect(githubCardKind(account({ available: false }))).toBe("unavailable");
    expect(githubCardKind(account())).toBe("not-connected");
    expect(githubCardKind(account({ deviceAuth: { phase: "running", message: "" } }))).toBe("signing-in");
    expect(githubCardKind(connected())).toBe("connected");
    expect(githubCardKind(connected({ missingScopes: ["repo"], refreshCommand: "gh auth refresh -s repo" }))).toBe("needs-permissions");
  });
  it("words the headline plainly", () => {
    expect(githubHeadline(connected())).toBe("Connected as octocat via GitHub CLI");
    expect(githubHeadline(connected({ source: "environment" }))).toBe("Connected as octocat via token");
    expect(githubHeadline(connected({ missingScopes: ["repo"] }))).toBe("Needs permissions: repo");
    expect(githubHeadline(account())).toBe("Not connected");
  });
});

describe("github options", () => {
  it("lists the CLI login first only when it exists", () => {
    expect(githubMethods(connected()).map(item => item.value)).toEqual(["cli", "sign-in", "token"]);
    expect(githubMethods(connected())[0]!.label).toBe("GitHub CLI login (octocat)");
    expect(githubMethods(account()).map(item => item.value)).toEqual(["sign-in", "token"]);
    expect(githubMethods(connected({ source: "environment" })).map(item => item.value)).toEqual(["sign-in", "token"]);
    expect(defaultGitHubMethod(connected())).toBe("cli");
    expect(defaultGitHubMethod(account())).toBe("sign-in");
  });
});

describe("device sign-in", () => {
  it("shows the live status", () => {
    expect(deviceStatusText({ phase: "running", message: "", userCode: "ABCD-1234" })).toBe("Enter code ABCD-1234 at github.com/login/device");
    expect(deviceStatusText({ phase: "running", message: "" })).toBe("Waiting for a code from GitHub");
    expect(deviceStatusText({ phase: "timeout", message: "" })).toMatch(/expired/);
    expect(deviceStatusText({ phase: "cancelled", message: "" })).toMatch(/cancelled/);
    expect(deviceStatusText({ phase: "failed", message: "" })).toBe("Sign-in failed.");
    expect(deviceStatusText({ phase: "connected", message: "" })).toBeNull();
  });
  it("only opens GitHub's device page", () => {
    expect(safeDeviceUrl("https://github.com/login/device")).toBe("https://github.com/login/device");
    for (const bad of ["http://github.com/login/device", "https://github.com.evil.test/login/device", "https://u@github.com/login/device", "https://github.com/login/oauth", "javascript:alert(1)", "nope", undefined]) expect(safeDeviceUrl(bad)).toBeNull();
  });
});

describe("guided token", () => {
  it("prefills the fine-grained token page", () => {
    const url = new URL(guidedTokenUrl("mini"));
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ contents: "write", pull_requests: "write", metadata: "read", expires_in: "90" });
    expect(url.searchParams.get("name")!.length).toBeLessThanOrEqual(40);
    expect(url.searchParams.get("description")).toContain("mini");
  });
  it("validates pasted tokens and expiry", () => {
    expect(validToken(" github_pat_abc ")).toBe(true);
    expect(validToken("")).toBe(false);
    expect(validToken("a b")).toBe(false);
    expect(formatExpiry("2030-01-02T03:04:05.000Z")).toBe("2030-01-02");
    expect(formatExpiry(null)).toBeNull();
    expect(formatExpiry("x")).toBeNull();
  });
});

describe("method selector", () => {
  it("appears only when methods need different input", () => {
    expect(showMethodSelector([{ value: "sign-in" }, { value: "token" }])).toBe(true);
    expect(showMethodSelector([{ value: "sign-in" }])).toBe(false);
    expect(showMethodSelector([{ value: "cli" }, { value: "sign-in" }])).toBe(false);
  });
  it("labels the sign-in button so it never repeats the selector", () => {
    expect(githubConnectLabel({ connected: false })).toBe("Connect");
    expect(githubConnectLabel({ connected: true })).toBe("Sign in with another account");
  });
});

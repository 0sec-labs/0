import { describe, expect, it } from "vitest";
import { GITHUB_DEVICE_URL, classifyLoginFailure, missingScopes, parseAuthStatus, parseDeviceCode, parseTokenExpiry, scrubbedGhEnv, splitScopes } from "./github-gh-output.js";

const status = (entry: Record<string, unknown>) => JSON.stringify({ hosts: { "github.com": [entry] } });

describe("parseDeviceCode", () => {
  it("reads the one-time code and always pins the verification URL", () => {
    const out = "! First copy your one-time code: ab12-CD34\nPress Enter to open https://evil.example/login in your browser...";
    expect(parseDeviceCode(out)).toEqual({ userCode: "AB12-CD34", verificationUrl: GITHUB_DEVICE_URL });
  });
  it("returns null for partial, unrelated or error output", () => {
    expect(parseDeviceCode("")).toBeNull();
    expect(parseDeviceCode("! First copy your one-time code: AB12")).toBeNull();
    expect(parseDeviceCode("error connecting to github.com")).toBeNull();
    expect(parseDeviceCode("code ABCD-1234")).toBeNull();
  });
  it("finds a code that arrives after earlier noise", () => {
    expect(parseDeviceCode(`${"x".repeat(20_000)}\none-time code: ZZZZ-9999\n`)?.userCode).toBe("ZZZZ-9999");
  });
});

describe("parseAuthStatus", () => {
  it("reads the active account, scopes and source", () => {
    expect(parseAuthStatus(status({ state: "success", active: true, login: "octocat", scopes: "repo, read:org", tokenSource: "keyring" })))
      .toEqual({ connected: true, account: "octocat", scopes: ["repo", "read:org"], source: "cli" });
  });
  it("marks environment tokens", () => {
    expect(parseAuthStatus(status({ state: "success", active: true, login: "octocat", scopes: "", tokenSource: "GH_TOKEN" })).source).toBe("environment");
    expect(parseAuthStatus(status({ state: "success", active: true, login: "octocat", scopes: "", tokenSource: "GITHUB_TOKEN" })).source).toBe("environment");
  });
  it("treats failures, inactive entries and malformed input as not connected", () => {
    const none = { connected: false, account: null, scopes: [], source: null };
    expect(parseAuthStatus(status({ state: "error", active: true, login: "octocat" }))).toMatchObject({ connected: false, source: null });
    expect(parseAuthStatus(status({ state: "success", active: false, login: "octocat" }))).toEqual(none);
    expect(parseAuthStatus("not json")).toEqual(none);
    expect(parseAuthStatus("{}")).toEqual(none);
    expect(parseAuthStatus(JSON.stringify({ hosts: { "github.com": "x" } }))).toEqual(none);
  });
  it("drops a login that is not a valid GitHub username", () => {
    expect(parseAuthStatus(status({ state: "success", active: true, login: "a b<script>" })).account).toBeNull();
  });
});

describe("scopes", () => {
  it("splits strings and arrays", () => {
    expect(splitScopes("repo, 'gist'  read:org")).toEqual(["repo", "gist", "read:org"]);
    expect(splitScopes(["repo", 3, "repo"])).toEqual(["repo"]);
    expect(splitScopes(null)).toEqual([]);
  });
  it("reports repo missing only when scopes are known", () => {
    expect(missingScopes(["gist"])).toEqual(["repo"]);
    expect(missingScopes(["repo", "gist"])).toEqual([]);
    expect(missingScopes([])).toEqual([]);
  });
});

describe("misc parsers", () => {
  it("reads token expiry", () => {
    expect(parseTokenExpiry("HTTP/2.0 200 OK\ngithub-authentication-token-expiration: 2026-12-01 00:00:00 UTC\n")).toBe("2026-12-01T00:00:00.000Z");
    expect(parseTokenExpiry("HTTP/2.0 200 OK\n")).toBeNull();
    expect(parseTokenExpiry("github-authentication-token-expiration: soon")).toBeNull();
  });
  it("classifies login failures without echoing them", () => {
    expect(classifyLoginFailure("error validating token: HTTP 401: Bad credentials")).toBe("rejected");
    expect(classifyLoginFailure("failed to write to keyring")).toBe("storage");
    expect(classifyLoginFailure("")).toBe("unknown");
  });
  it("scrubs the sign-in environment", () => {
    const env = scrubbedGhEnv({ PATH: "/bin", HOME: "/h", GH_TOKEN: "x", GITHUB_TOKEN: "y", HTTPS_PROXY: "http://u:p@h", OPENAI_API_KEY: "z" });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", BROWSER: "true" });
    expect(Object.keys(env)).not.toContain("GH_TOKEN");
    expect(Object.keys(env)).not.toContain("GITHUB_TOKEN");
    expect(Object.keys(env)).not.toContain("HTTPS_PROXY");
    expect(Object.keys(env)).not.toContain("OPENAI_API_KEY");
  });
});

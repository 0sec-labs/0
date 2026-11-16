import { describe, expect, it } from "vitest";
import type { GitHubPublicationAuth, GithubAccount } from "./github-auth.js";
import { GitHubConnector } from "./github-connector.js";

const account = (over: Partial<GithubAccount> = {}): GithubAccount => ({ available: true, connected: false, account: null, scopes: [], missingScopes: [], refreshCommand: null, source: null, expiresAt: null, computer: "box", deviceAuth: { phase: "idle", message: "" }, ...over });
/** A fake of the one `gh`-backed class: no process is started and no token exists. */
const fake = (state: GithubAccount) => {
  const calls: string[] = [];
  const auth = { status: async () => state, start: async (m: string) => { calls.push(`start:${m}`); return state; }, connect: async (v: { token: string }) => { calls.push(`connect:${v.token.length}`); return state; }, cancel: async () => { calls.push("cancel"); return state; } } as unknown as GitHubPublicationAuth;
  return { adapter: new GitHubConnector(auth), calls };
};

describe("GitHub connector adapter", () => {
  it("maps the card states to the contract's states", async () => {
    expect((await fake(account({ available: false, deviceAuth: { phase: "unavailable", message: "GitHub CLI is not installed on this computer." } })).adapter.status())).toMatchObject({ state: "unavailable" });
    expect(await fake(account()).adapter.status()).toMatchObject({ state: "not-connected", account: null });
    expect(await fake(account({ connected: true, account: "ada", source: "cli" })).adapter.status()).toMatchObject({ state: "connected", account: "ada", detail: "via GitHub CLI", health: "ok" });
    expect(await fake(account({ connected: true, account: "ada", source: "environment" })).adapter.status()).toMatchObject({ detail: "via token" });
    expect(await fake(account({ connected: true, account: "ada", missingScopes: ["repo"] })).adapter.status()).toMatchObject({ state: "needs-attention", detail: "Needs permissions: repo" });
  });
  it("reports the one-time code while a device sign-in waits", async () => {
    const s = await fake(account({ deviceAuth: { phase: "running", message: "", userCode: "ABCD-1234", verificationUrl: "https://github.com/login/device" } })).adapter.status();
    expect(s).toMatchObject({ state: "signing-in", device: { userCode: "ABCD-1234", verificationUrl: "https://github.com/login/device" } });
  });
  it("drives the existing sign-in, token and cancel paths", async () => {
    const { adapter, calls } = fake(account());
    await adapter.signIn(); await adapter.connectToken("abcdef"); await adapter.cancel();
    expect(calls).toEqual(["start:login", "connect:6", "cancel"]);
  });

  it("refuses a malformed token before any gh process starts and never reports it connected", async () => {
    const { GitHubPublicationAuth: Real } = await import("./github-auth.js");
    const adapter = new GitHubConnector(new Real({ computer: "box" }));
    for (const bad of ["", "   ", "has a space", "x".repeat(16_001)]) await expect(adapter.connectToken(bad)).rejects.toMatchObject({ statusCode: 400 });
  });
});

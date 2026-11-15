import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubPublicationAuth, parseAuthMode } from "./github-auth.js";

/** A fake `gh` that keeps its state under $HOME/.fakegh and records every call, including whether `auth token` was ever used. */
const FAKE_GH = `#!/bin/sh
D="$HOME/.fakegh"; mkdir -p "$D"
echo "$*" >> "$D/calls"
case "$1 $2" in
  "--version "*) echo "gh version 2.0.0"; exit 0;;
  "auth status")
    if [ -f "$D/user" ]; then
      SC=$(cat "$D/scopes" 2>/dev/null)
      printf '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"%s","tokenSource":"keyring","scopes":"%s"}]}}' "$(cat "$D/user")" "$SC"; exit 0
    fi
    echo '{"hosts":{}}'; exit 1;;
  "auth token") echo called >> "$D/token-called"; echo SECRET-TOKEN; exit 0;;
  "auth login")
    env | grep -E '^(GH_TOKEN|GITHUB_TOKEN)=' >> "$D/leaked-env"
    case "$*" in
      *--with-token*) read T; if [ "$T" = "good-token" ]; then echo octocat > "$D/user"; echo "" > "$D/scopes"; exit 0; fi; echo "error validating token: HTTP 401: Bad credentials" >&2; exit 1;;
      *--web*)
        echo "! First copy your one-time code: ABCD-1234"; echo "Press Enter to open github.com in your browser..."; read L
        i=0; while [ ! -f "$D/approve" ] && [ ! -f "$D/deny" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
        if [ -f "$D/approve" ]; then echo octocat > "$D/user"; echo "repo, read:org" > "$D/scopes"; echo "Logged in as octocat"; exit 0; fi
        exit 1;;
    esac;;
  "auth refresh") echo "! First copy your one-time code: WXYZ-5678"; read L; echo "repo, gist" > "$D/scopes"; exit 0;;
  "auth logout") rm -f "$D/user"; exit 0;;
  "api --include") printf 'HTTP/2.0 200 OK\\ngithub-authentication-token-expiration: 2030-01-02 03:04:05 UTC\\n\\n{"login":"octocat"}'; exit 0;;
esac
exit 2
`;

let root = "";
let state = "";
const saved = { PATH: process.env["PATH"], HOME: process.env["HOME"], GH_TOKEN: process.env["GH_TOKEN"] };
const setState = (name: string, value = "") => { mkdirSync(state, { recursive: true }); writeFileSync(join(state, name), value ? `${value}\n` : ""); };
const calls = () => existsSync(join(state, "calls")) ? readFileSync(join(state, "calls"), "utf8") : "";
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i += 1) { const value = await read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("timed out waiting");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fake-gh-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "gh"), FAKE_GH);
  chmodSync(join(root, "bin", "gh"), 0o755);
  state = join(root, "home", ".fakegh");
  mkdirSync(state, { recursive: true });
  process.env["PATH"] = `${join(root, "bin")}:${saved.PATH}`;
  process.env["HOME"] = join(root, "home");
  process.env["GH_TOKEN"] = "ambient-secret";
});
afterEach(() => {
  process.env["PATH"] = saved.PATH; process.env["HOME"] = saved.HOME;
  if (saved.GH_TOKEN === undefined) delete process.env["GH_TOKEN"]; else process.env["GH_TOKEN"] = saved.GH_TOKEN;
  rmSync(root, { recursive: true, force: true });
});

describe("GitHubPublicationAuth with a fake gh", () => {
  it("reports an existing GitHub CLI login with scopes, expiry and the computer, without reading the token", async () => {
    setState("user", "octocat"); setState("scopes", "repo, read:org");
    const github = new GitHubPublicationAuth({ computer: "mini" });
    const account = await github.status();
    expect(account).toMatchObject({ available: true, connected: true, account: "octocat", source: "cli", scopes: ["repo", "read:org"], missingScopes: [], refreshCommand: null, computer: "mini", expiresAt: "2030-01-02T03:04:05.000Z" });
    expect(JSON.stringify(account)).not.toContain("SECRET-TOKEN");
    expect(existsSync(join(state, "token-called"))).toBe(false);
  });

  it("names the missing scope and the exact refresh command", async () => {
    setState("user", "octocat"); setState("scopes", "gist");
    const account = await new GitHubPublicationAuth().status();
    expect(account).toMatchObject({ connected: true, missingScopes: ["repo"], refreshCommand: "gh auth refresh -s repo" });
  });

  it("reports gh as unavailable when it is not installed", async () => {
    process.env["PATH"] = join(root, "empty");
    const account = await new GitHubPublicationAuth().status();
    expect(account).toMatchObject({ available: false, connected: false, deviceAuth: { phase: "unavailable" } });
  });

  it("runs the device flow: code and URL, then connected, with a scrubbed environment and the right arguments", async () => {
    const github = new GitHubPublicationAuth();
    const started = await github.start();
    expect(started.connected).toBe(false);
    const waiting = await until(() => github.status(), value => Boolean(value.deviceAuth.userCode));
    expect(waiting.deviceAuth).toMatchObject({ phase: "running", userCode: "ABCD-1234", verificationUrl: "https://github.com/login/device" });
    expect(calls()).toContain("auth login --hostname github.com --git-protocol https --web --scopes repo,read:org");
    // A second start while running is single-flight.
    await github.start();
    expect(calls().split("\n").filter(line => line.includes("--web")).length).toBe(1);
    setState("approve");
    const done = await until(() => github.status(), value => value.connected);
    expect(done).toMatchObject({ connected: true, account: "octocat", deviceAuth: { phase: "connected" } });
    expect(readFileSync(join(state, "leaked-env"), "utf8")).toBe("");
    expect(existsSync(join(state, "token-called"))).toBe(false);
  });

  it("reports a failed sign-in", async () => {
    const github = new GitHubPublicationAuth();
    await github.start();
    await until(() => github.status(), value => Boolean(value.deviceAuth.userCode));
    setState("deny");
    const failed = await until(() => github.status(), value => value.deviceAuth.phase === "failed");
    expect(failed.connected).toBe(false);
    expect(failed.deviceAuth.userCode).toBeUndefined();
  });

  it("cancels a running sign-in and kills the process", async () => {
    const github = new GitHubPublicationAuth();
    await github.start();
    await until(() => github.status(), value => Boolean(value.deviceAuth.userCode));
    expect((await github.cancel()).deviceAuth).toMatchObject({ phase: "cancelled" });
    // A new attempt is possible afterwards.
    expect((await github.start()).deviceAuth.phase).toBe("running");
    await github.cancel();
  });

  it("times out and releases the single flight", async () => {
    const github = new GitHubPublicationAuth({ timeoutMs: 200 });
    await github.start();
    const timedOut = await until(() => github.status(), value => value.deviceAuth.phase === "timeout");
    expect(timedOut.deviceAuth.userCode).toBeUndefined();
    expect((await github.start()).deviceAuth.phase).toBe("running");
    github.dispose();
  });

  it("refreshes scopes through the same flow", async () => {
    setState("user", "octocat"); setState("scopes", "gist");
    const github = new GitHubPublicationAuth();
    await github.start("refresh");
    const done = await until(() => github.status(), value => value.missingScopes.length === 0);
    expect(calls()).toContain("auth refresh --hostname github.com --scopes repo");
    expect(done.connected).toBe(true);
  });

  it("validates a pasted token before saving it and never echoes a rejected one", async () => {
    const github = new GitHubPublicationAuth();
    await expect(github.connect({ token: "bad-token-123" })).rejects.toMatchObject({ statusCode: 422, message: "GitHub did not accept this token." });
    await expect(github.connect({ token: "has space" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(github.connect({})).rejects.toMatchObject({ statusCode: 400 });
    expect(existsSync(join(state, "user"))).toBe(false);
    const account = await github.connect({ token: "good-token" });
    expect(account).toMatchObject({ connected: true, account: "octocat" });
    expect(JSON.stringify(account)).not.toContain("good-token");
    expect(readFileSync(join(state, "leaked-env"), "utf8")).toBe("");
  });

  it("disconnects by signing the GitHub CLI out", async () => {
    setState("user", "octocat"); setState("scopes", "repo");
    const account = await new GitHubPublicationAuth().disconnect();
    expect(account.connected).toBe(false);
    expect(calls()).toContain("auth logout --hostname github.com --user octocat");
  });
});

describe("parseAuthMode", () => {
  it("defaults to login and rejects unknown modes", () => {
    expect(parseAuthMode({})).toBe("login");
    expect(parseAuthMode(null)).toBe("login");
    expect(parseAuthMode({ mode: "refresh" })).toBe("refresh");
    expect(() => parseAuthMode({ mode: "--with-token" })).toThrow(/Unknown sign-in mode/);
    expect(() => parseAuthMode({ mode: 3 })).toThrow();
  });
});

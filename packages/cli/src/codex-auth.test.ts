import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { maybeLoadCodexAuth } from "./codex-auth.js";
import { LlmApiRuntime } from "@0/engine";

let dir: string;

/** A fresh env per test — nothing leaks in from the ambient shell. */
function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...overrides };
}

/** Write an auth.json with the given tokens and return its path. */
function writeAuth(name: string, tokens: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ tokens }), "utf8");
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "0-codex-auth-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("maybeLoadCodexAuth", () => {
  it("honours ZERO_CHATGPT_AUTH_FILE — the variable the runtime and docs use", () => {
    const e = env({ "ZERO_CHATGPT_AUTH_FILE": writeAuth("primary.json", { access_token: "acc-primary" }) });
    maybeLoadCodexAuth({ env: e, home: dir });
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBe("acc-primary");
  });

  it("still accepts the deprecated ZERO_CODEX_AUTH_JSON_PATH when the primary is unset", () => {
    const e = env({ "ZERO_CODEX_AUTH_JSON_PATH": writeAuth("legacy.json", { refresh_token: "ref-legacy" }) });
    maybeLoadCodexAuth({ env: e, home: dir });
    expect(e["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"]).toBe("ref-legacy");
  });

  it("prefers the primary over the deprecated variable when both are set", () => {
    const e = env({
      "ZERO_CHATGPT_AUTH_FILE": writeAuth("primary.json", { access_token: "acc-primary" }),
      "ZERO_CODEX_AUTH_JSON_PATH": writeAuth("legacy.json", { access_token: "acc-legacy" }),
    });
    maybeLoadCodexAuth({ env: e, home: dir });
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBe("acc-primary");
  });

  it("falls back to ~/.codex/auth.json when neither override is set", () => {
    mkdirSync(join(dir, ".codex"));
    writeAuth(join(".codex", "auth.json"), { access_token: "acc-home", refresh_token: "ref-home" });
    const e = env();
    maybeLoadCodexAuth({ env: e, home: dir });
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBe("acc-home");
    expect(e["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"]).toBe("ref-home");
  });

  it("treats an empty override as unset instead of stat'ing the empty path", () => {
    mkdirSync(join(dir, ".codex"));
    writeAuth(join(".codex", "auth.json"), { access_token: "acc-home" });
    const e = env({ "ZERO_CHATGPT_AUTH_FILE": "" });
    maybeLoadCodexAuth({ env: e, home: dir });
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBe("acc-home");
  });

  it("reloads only its own bootstrapped tokens after the CLI writes a new login", () => {
    const path = writeAuth("latest.json", { access_token: "old-access", refresh_token: "old-refresh" });
    const e = env({ ZERO_CHATGPT_AUTH_FILE: path });
    maybeLoadCodexAuth({ env: e });
    const captured = new LlmApiRuntime({ type: "api", timeout: 1000, provider: "chatgpt-codex", model: "fixture-model", env: { ...e, ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_FORCE_PROVIDER: "", ZERO_LLM_FALLBACK: "" } });
    const identity = captured.connectionIdentity();
    writeFileSync(path, JSON.stringify({ tokens: { access_token: "new-access", refresh_token: "new-refresh" } }));
    maybeLoadCodexAuth({ env: e });
    expect(e.ZERO_CHATGPT_ACCESS_TOKEN).toBe("new-access");
    expect(e.ZERO_CHATGPT_OAUTH_REFRESH_TOKEN).toBe("new-refresh");
    expect(captured.connectionIdentity()).toBe(identity);
    const next = new LlmApiRuntime({ type: "api", timeout: 1000, provider: "chatgpt-codex", model: "fixture-model", env: { ...e, ZERO_SKIP_PROVIDER_BANNER: "1", ZERO_FORCE_PROVIDER: "", ZERO_LLM_FALLBACK: "" } });
    expect(next.connectionIdentity()).not.toBe(identity);
  });

  it("stops tracking file credentials after the operator replaces an env token", () => {
    const path = writeAuth("tracked.json", { access_token: "file-access", refresh_token: "file-refresh" });
    const e = env({ ZERO_CHATGPT_AUTH_FILE: path });
    maybeLoadCodexAuth({ env: e });
    e.ZERO_CHATGPT_ACCESS_TOKEN = "operator-access";
    e.ZERO_CHATGPT_OAUTH_REFRESH_TOKEN = "operator-refresh";
    writeFileSync(path, JSON.stringify({ tokens: { access_token: "new-file-access", refresh_token: "new-file-refresh" } }));
    maybeLoadCodexAuth({ env: e });
    expect(e.ZERO_CHATGPT_ACCESS_TOKEN).toBe("operator-access");
    expect(e.ZERO_CHATGPT_OAUTH_REFRESH_TOKEN).toBe("operator-refresh");
  });

  it("replaces the complete bootstrapped token pair without retaining an older refresh token", () => {
    const path = writeAuth("access-only.json", { access_token: "old-access", refresh_token: "old-refresh" });
    const e = env({ ZERO_CHATGPT_AUTH_FILE: path });
    maybeLoadCodexAuth({ env: e });
    writeFileSync(path, JSON.stringify({ tokens: { access_token: "new-access-only" } }));
    maybeLoadCodexAuth({ env: e });
    expect(e.ZERO_CHATGPT_ACCESS_TOKEN).toBe("new-access-only");
    expect(e.ZERO_CHATGPT_OAUTH_REFRESH_TOKEN).toBeUndefined();
  });

  it("does not overwrite an access token that is already exported", () => {
    const e = env({
      "ZERO_CHATGPT_ACCESS_TOKEN": "acc-from-shell",
      "ZERO_CHATGPT_AUTH_FILE": writeAuth("primary.json", { access_token: "acc-file", refresh_token: "ref-file" }),
    });
    maybeLoadCodexAuth({ env: e, home: dir });
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBe("acc-from-shell");
    // An explicit export wins wholesale: the file's refresh token must not be
    // spliced in alongside, or the process would mix credentials from two
    // different logins.
    expect(e["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"]).toBeUndefined();
  });

  it("replaces stale process tokens after an explicit OAuth reconnect", () => {
    const e = env({
      "ZERO_CHATGPT_ACCESS_TOKEN": "stale-access",
      "ZERO_CHATGPT_OAUTH_REFRESH_TOKEN": "stale-refresh",
      "ZERO_CHATGPT_AUTH_FILE": writeAuth("fresh.json", {
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
      }),
    });
    maybeLoadCodexAuth({ env: e, home: dir, force: true });
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBe("fresh-access");
    expect(e["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"]).toBe("fresh-refresh");
  });

  it("does not overwrite a refresh token that is already exported", () => {
    const e = env({
      "ZERO_CHATGPT_OAUTH_REFRESH_TOKEN": "ref-from-shell",
      "ZERO_CHATGPT_AUTH_FILE": writeAuth("primary.json", { access_token: "acc-file" }),
    });
    maybeLoadCodexAuth({ env: e, home: dir });
    expect(e["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"]).toBe("ref-from-shell");
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBeUndefined();
  });

  it("is a silent no-op when the file is missing", () => {
    const e = env({ "ZERO_CHATGPT_AUTH_FILE": join(dir, "nope.json") });
    expect(() => maybeLoadCodexAuth({ env: e, home: dir })).not.toThrow();
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBeUndefined();
    expect(e["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"]).toBeUndefined();
  });

  it("is a silent no-op when the home default does not exist either", () => {
    const e = env();
    expect(() => maybeLoadCodexAuth({ env: e, home: join(dir, "no-such-home") })).not.toThrow();
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBeUndefined();
  });

  it("is a silent no-op on malformed JSON", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{not json", "utf8");
    const e = env({ "ZERO_CHATGPT_AUTH_FILE": path });
    expect(() => maybeLoadCodexAuth({ env: e, home: dir })).not.toThrow();
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBeUndefined();
  });

  it("is a silent no-op when the file carries no tokens object", () => {
    const path = join(dir, "empty.json");
    writeFileSync(path, JSON.stringify({ OPENAI_API_KEY: "sk-unrelated" }), "utf8");
    const e = env({ "ZERO_CHATGPT_AUTH_FILE": path });
    maybeLoadCodexAuth({ env: e, home: dir });
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBeUndefined();
  });

  it("ignores non-string token values rather than exporting them", () => {
    const e = env({ "ZERO_CHATGPT_AUTH_FILE": writeAuth("junk.json", { access_token: null, refresh_token: 42 }) });
    maybeLoadCodexAuth({ env: e, home: dir });
    expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBeUndefined();
    expect(e["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"]).toBeUndefined();
  });

  it("is a silent no-op when the file is unreadable", () => {
    const path = writeAuth("locked.json", { access_token: "acc-locked" });
    chmodSync(path, 0o000);
    const e = env({ "ZERO_CHATGPT_AUTH_FILE": path });
    let threw = false;
    try {
      maybeLoadCodexAuth({ env: e, home: dir });
    } catch {
      threw = true;
    } finally {
      chmodSync(path, 0o600);
    }
    expect(threw).toBe(false);
    // Running as root defeats the permission bit, so only assert the env is
    // untouched when the chmod actually denied us.
    if (process.getuid?.() !== 0) {
      expect(e["ZERO_CHATGPT_ACCESS_TOKEN"]).toBeUndefined();
    }
  });

  it("defaults to the real process.env when called with no arguments", () => {
    // The call site in index.ts is zero-arg; the options must stay optional.
    const saved = {
      access: process.env["ZERO_CHATGPT_ACCESS_TOKEN"],
      refresh: process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"],
      file: process.env["ZERO_CHATGPT_AUTH_FILE"],
      legacy: process.env["ZERO_CODEX_AUTH_JSON_PATH"],
    };
    try {
      delete process.env["ZERO_CHATGPT_ACCESS_TOKEN"];
      delete process.env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"];
      delete process.env["ZERO_CODEX_AUTH_JSON_PATH"];
      process.env["ZERO_CHATGPT_AUTH_FILE"] = writeAuth("ambient.json", { access_token: "acc-ambient" });
      maybeLoadCodexAuth();
      expect(process.env["ZERO_CHATGPT_ACCESS_TOKEN"]).toBe("acc-ambient");
    } finally {
      restore("ZERO_CHATGPT_ACCESS_TOKEN", saved.access);
      restore("ZERO_CHATGPT_OAUTH_REFRESH_TOKEN", saved.refresh);
      restore("ZERO_CHATGPT_AUTH_FILE", saved.file);
      restore("ZERO_CODEX_AUTH_JSON_PATH", saved.legacy);
    }
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

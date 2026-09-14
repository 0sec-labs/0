import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type AccountRecord,
  type AccountStore,
  accountEnvPatch,
  addAccount,
  credentialEnvPatch,
  credentialsFilePath,
  getActiveAccount,
  listAccounts,
  loadAccountStore,
  loadCredentials,
  logoutProvider,
  normalizeAccountStore,
  normalizeCredentials,
  redactSecret,
  removeAccount,
  saveAccountStore,
  saveCredentials,
  setActiveAccount,
  type StoredCredentials,
} from "./credential-store.js";
import { PROVIDERS } from "./provider-status.js";

/** Temp homes created by a test, torn down after it regardless of outcome. */
const tempHomes: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "0sec-credential-store-"));
  tempHomes.push(dir);
  return dir;
}

/** Permission bits only — the file-type bits in `mode` are not ours to assert. */
function permissionsOf(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  while (tempHomes.length > 0) {
    const dir = tempHomes.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("credentialsFilePath", () => {
  it("places the file inside the shared 0sec state directory", () => {
    expect(credentialsFilePath("/home/someone")).toBe("/home/someone/.0sec/credentials.json");
  });

  it("defaults the home directory when none is given", () => {
    expect(credentialsFilePath().endsWith(join(".0sec", "credentials.json"))).toBe(true);
  });
});

describe("normalizeCredentials", () => {
  // The file is hand-editable and therefore corruptible; each of these has to
  // produce a usable map rather than an exception inside a running console.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "anthropic=sk-ant-secret"],
    ["an array", ["anthropic", "sk-ant-secret"]],
    ["an array of objects", [{ anthropic: "sk-ant-secret" }]],
    ["a boolean", true],
  ])("returns an empty map for %s", (_label, raw) => {
    expect(normalizeCredentials(raw)).toEqual({});
  });

  it("keeps known providers with non-blank string values", () => {
    expect(normalizeCredentials({ anthropic: "sk-ant-secret", openai: "sk-openai-secret" })).toEqual({
      anthropic: "sk-ant-secret",
      openai: "sk-openai-secret",
    });
  });

  it("drops provider ids the runtime cannot authenticate", () => {
    // "google" and "mistral" exist in the pricing table but have no env-var
    // path in PROVIDERS, so a key stored under them could never be used.
    expect(normalizeCredentials({ google: "key", mistral: "key", anthropic: "sk-ant-secret" })).toEqual({
      anthropic: "sk-ant-secret",
    });
  });

  it("drops non-string values, including nested objects", () => {
    expect(
      normalizeCredentials({
        anthropic: { key: "sk-ant-secret" },
        openai: ["sk-openai-secret"],
        deepseek: 12345,
        xai: null,
        qwen: true,
        kimi: "kimi-secret",
      }),
    ).toEqual({ kimi: "kimi-secret" });
  });

  it("drops empty and whitespace-only values", () => {
    // A `$(cat key.txt)` newline or an `export KEY=` is not a credential;
    // keeping it would show the provider as configured and fail every call.
    expect(normalizeCredentials({ anthropic: "", openai: "   ", xai: "\n\t ", kimi: "kimi-secret" })).toEqual({
      kimi: "kimi-secret",
    });
  });

  it("trims surrounding whitespace off a pasted secret", () => {
    expect(normalizeCredentials({ anthropic: "  sk-ant-secret\n" })).toEqual({ anthropic: "sk-ant-secret" });
  });

  it("does not let a prototype-shaped key through", () => {
    const parsed: unknown = JSON.parse('{"__proto__": "polluted", "constructor": "polluted"}');
    const result = normalizeCredentials(parsed);
    expect(result).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const raw = { anthropic: " sk-ant-secret ", google: "dropped" };
    normalizeCredentials(raw);
    expect(raw).toEqual({ anthropic: " sk-ant-secret ", google: "dropped" });
  });
});

describe("saveCredentials / loadCredentials", () => {
  it("round-trips through a real file", () => {
    const home = makeHome();
    const creds: StoredCredentials = { anthropic: "sk-ant-secret", openrouter: "sk-or-secret" };

    expect(saveCredentials(creds, home)).toBe(true);
    expect(loadCredentials(home)).toEqual(creds);
  });

  it("normalises on the way out so an unknown provider never reaches disk", () => {
    const home = makeHome();
    saveCredentials({ anthropic: "sk-ant-secret", google: "unusable", openai: "  " }, home);

    // The file is now the v2 account store; only the anthropic key survives,
    // stored as a tagged api_key record under the default account.
    const written: unknown = JSON.parse(readFileSync(credentialsFilePath(home), "utf8"));
    expect(written).toEqual({
      version: 2,
      providers: {
        anthropic: { activeAccountId: "default", accounts: { default: { kind: "api_key", secret: "sk-ant-secret" } } },
      },
    });
  });

  it("writes the file owner-only (0600) and the directory owner-only (0700)", () => {
    const home = makeHome();
    expect(saveCredentials({ anthropic: "sk-ant-secret" }, home)).toBe(true);

    const path = credentialsFilePath(home);
    expect(permissionsOf(path)).toBe(0o600);
    expect(permissionsOf(join(home, ".0sec"))).toBe(0o700);
  });

  it("tightens a pre-existing world-readable file instead of leaving it alone", () => {
    const home = makeHome();
    const dir = join(home, ".0sec");
    const path = join(dir, "credentials.json");
    // An older build, a restored backup or a hand-edit can leave the secret
    // readable by every local account; `mode` on writeFileSync does nothing
    // for a file that already exists, so the explicit chmod is what saves us.
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    writeFileSync(path, '{"anthropic":"sk-ant-old"}\n', "utf8");
    chmodSync(path, 0o644);
    expect(permissionsOf(path)).toBe(0o644);

    expect(saveCredentials({ anthropic: "sk-ant-new" }, home)).toBe(true);
    expect(permissionsOf(path)).toBe(0o600);
    expect(permissionsOf(dir)).toBe(0o700);
    expect(loadCredentials(home)).toEqual({ anthropic: "sk-ant-new" });
  });

  it("returns an empty map when the file does not exist", () => {
    expect(loadCredentials(makeHome())).toEqual({});
  });

  it("returns an empty map for invalid JSON rather than throwing", () => {
    const home = makeHome();
    mkdirSync(join(home, ".0sec"), { recursive: true });
    writeFileSync(credentialsFilePath(home), "{ not json,,, ", "utf8");

    expect(() => loadCredentials(home)).not.toThrow();
    expect(loadCredentials(home)).toEqual({});
  });

  it("returns an empty map for well-formed JSON of the wrong shape", () => {
    const home = makeHome();
    mkdirSync(join(home, ".0sec"), { recursive: true });
    writeFileSync(credentialsFilePath(home), '["anthropic","sk-ant-secret"]', "utf8");

    expect(loadCredentials(home)).toEqual({});
  });

  it("returns false instead of throwing when the path is unwritable", () => {
    // A regular file where the state directory belongs makes mkdir fail with
    // ENOTDIR for any user, including root — unlike a chmod-based trap, which
    // a root test runner would walk straight through.
    const parent = makeHome();
    const blocked = join(parent, "home-that-is-a-file");
    writeFileSync(blocked, "not a directory", "utf8");

    expect(() => saveCredentials({ anthropic: "sk-ant-secret" }, blocked)).not.toThrow();
    expect(saveCredentials({ anthropic: "sk-ant-secret" }, blocked)).toBe(false);
  });
});

describe("credentialEnvPatch", () => {
  it("refuses to map an OAuth subscription through the generic API-key store", () => {
    expect(credentialEnvPatch({ "chatgpt-codex": "oauth-secret" }, {})).toEqual({});
  });

  it("covers every provider that accepts an API key", () => {
    const creds: StoredCredentials = Object.fromEntries(
      PROVIDERS.map((info) => [info.id, `secret-for-${info.id}`]),
    );
    const patch = credentialEnvPatch(creds, {});

    // A provider is reachable through the flat key store when it accepts an
    // API key at all — including xai/kimi, which prefer OAuth but keep a key as
    // a secondary method. Only an OAuth-only provider (chatgpt-codex) is out.
    expect(Object.keys(patch).sort()).toEqual(
      PROVIDERS.filter((info) => info.methods.includes("api-key")).map((info) => info.envVars[0]).sort(),
    );
  });

  it("never overrides an env var that already carries a credential", () => {
    // The shell export is an explicit choice; a stored key shadowing it would
    // make "which key did that run use?" unanswerable after a 401.
    const patch = credentialEnvPatch(
      { anthropic: "sk-ant-stored", openai: "sk-openai-stored" },
      { ANTHROPIC_API_KEY: "sk-ant-from-shell" },
    );

    expect(patch).toEqual({ OPENAI_API_KEY: "sk-openai-stored" });
  });

  it("fills a variable that is exported but empty", () => {
    expect(credentialEnvPatch({ anthropic: "sk-ant-stored" }, { ANTHROPIC_API_KEY: "" })).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-stored",
    });
  });

  it("fills a variable that is exported but whitespace-only", () => {
    expect(credentialEnvPatch({ anthropic: "sk-ant-stored" }, { ANTHROPIC_API_KEY: " \n" })).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-stored",
    });
  });

  it("leaves a provider alone when a lower-preference var of its own is set", () => {
    // The shell already configured chatgpt-codex via the refresh token;
    // injecting a stored access token would mix two credential sources into
    // one auth attempt, with ours winning — the silent override we forbid.
    expect(
      credentialEnvPatch(
        { "chatgpt-codex": "stored-access-token" },
        { "0SEC_CHATGPT_OAUTH_REFRESH_TOKEN": "shell-refresh-token" },
      ),
    ).toEqual({});
  });

  it("ignores stored entries for unknown providers and blank values", () => {
    expect(credentialEnvPatch({ google: "unusable", anthropic: "   " }, {})).toEqual({});
  });

  it("returns an empty patch for an empty store", () => {
    expect(credentialEnvPatch({}, { ANTHROPIC_API_KEY: "sk-ant-from-shell" })).toEqual({});
  });

  it("does not mutate either input", () => {
    const creds: StoredCredentials = { anthropic: "sk-ant-stored", openai: "sk-openai-stored" };
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-openai-from-shell", PATH: "/usr/bin" };

    credentialEnvPatch(creds, env);

    expect(creds).toEqual({ anthropic: "sk-ant-stored", openai: "sk-openai-stored" });
    expect(env).toEqual({ OPENAI_API_KEY: "sk-openai-from-shell", PATH: "/usr/bin" });
  });

  it("reads only the passed environment, never process.env", () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-ambient";
    try {
      expect(credentialEnvPatch({ anthropic: "sk-ant-stored" }, {})).toEqual({
        ANTHROPIC_API_KEY: "sk-ant-stored",
      });
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe("redactSecret", () => {
  it.each([
    ["an empty string", ""],
    ["one character", "a"],
    ["three characters", "abc"],
    ["four characters", "abcd"],
    ["eleven characters", "abcdefghijk"],
  ])("fully masks %s", (_label, secret) => {
    const redacted = redactSecret(secret);
    expect(redacted).not.toContain(secret === "" ? " " : secret);
    expect(redacted).toBe("••••••••");
  });

  it("masks short inputs to a constant width so length does not leak", () => {
    expect(redactSecret("a")).toBe(redactSecret("abcdefghijk"));
  });

  it("shows only a tail for a mid-length secret", () => {
    const secret = "abcdefghijklmno";
    const redacted = redactSecret(secret);

    expect(redacted).toBe("••••••••lmno");
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("abcdef");
  });

  it("shows a short prefix and the last four characters of a real key", () => {
    expect(redactSecret("sk-ant-api03-0123456789abcdefa4f2")).toBe("sk-ant…a4f2");
  });

  it("never returns the full secret, at any length", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const lengths = [1, 3, 4, 8, 11, 12, 15, 19, 20, 40, 108];
    for (const length of lengths) {
      const secret = Array.from({ length }, (_unused, index) => alphabet[index % alphabet.length]).join("");
      const redacted = redactSecret(secret);
      expect(redacted).not.toBe(secret);
      expect(redacted.length).toBeLessThan(secret.length + 8);
      expect(redacted).not.toContain(secret);
    }
  });

  it("ignores surrounding whitespace rather than counting it as entropy", () => {
    expect(redactSecret("  abcd  ")).toBe("••••••••");
  });
});

/** A minimal empty store. */
function empty(): AccountStore {
  return { version: 2, providers: {} };
}

const OAUTH: AccountRecord = {
  kind: "oauth",
  tokens: { accessToken: "at-primary", refreshToken: "rt-primary", expiresAt: 1_700_000_000_000 },
  identity: { label: "work", email: "op@example.com", accountId: "acct-1" },
};

describe("normalizeAccountStore", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "anthropic=sk"],
    ["an array", ["anthropic", "sk"]],
    ["a boolean", true],
  ])("degrades %s to an empty store", (_label, raw) => {
    expect(normalizeAccountStore(raw)).toEqual(empty());
  });

  it("migrates the legacy flat map forward to tagged api_key accounts", () => {
    const migrated = normalizeAccountStore({ anthropic: "  sk-ant-secret\n", google: "dropped", openai: "" });
    expect(migrated).toEqual({
      version: 2,
      providers: {
        anthropic: { activeAccountId: "default", accounts: { default: { kind: "api_key", secret: "sk-ant-secret" } } },
      },
    });
  });

  it("keeps a well-formed v2 store, dropping unknown providers", () => {
    const store: unknown = {
      version: 2,
      providers: {
        anthropic: { activeAccountId: "default", accounts: { default: { kind: "api_key", secret: "sk" } } },
        "chatgpt-codex": { activeAccountId: "a1", accounts: { a1: OAUTH } },
        google: { activeAccountId: "x", accounts: { x: { kind: "api_key", secret: "nope" } } },
      },
    };
    const normalized = normalizeAccountStore(store);
    expect(Object.keys(normalized.providers).sort()).toEqual(["anthropic", "chatgpt-codex"]);
    expect(getActiveAccount(normalized, "chatgpt-codex")).toEqual(OAUTH);
  });

  it("refuses an api_key record for an oauth-only provider and vice versa", () => {
    const normalized = normalizeAccountStore({
      version: 2,
      providers: {
        // chatgpt-codex supports only oauth: an api_key record is dropped.
        "chatgpt-codex": { accounts: { a: { kind: "api_key", secret: "sk" } } },
        // anthropic supports only api-key: an oauth record is dropped.
        anthropic: { accounts: { a: { kind: "oauth", tokens: { accessToken: "at" } } } },
      },
    });
    expect(normalized.providers).toEqual({});
  });

  it("drops an oauth record that carries no usable token", () => {
    const normalized = normalizeAccountStore({
      version: 2,
      providers: { "chatgpt-codex": { accounts: { a: { kind: "oauth", tokens: { accessToken: "  " } } } } },
    });
    expect(normalized.providers).toEqual({});
  });

  it("keeps a refresh-only oauth account (access token minted at runtime)", () => {
    const normalized = normalizeAccountStore({
      version: 2,
      providers: { "chatgpt-codex": { accounts: { a: { kind: "oauth", tokens: { refreshToken: "rt" } } } } },
    });
    expect(getActiveAccount(normalized, "chatgpt-codex")).toEqual({ kind: "oauth", tokens: { refreshToken: "rt" } });
  });

  it("repoints activeAccountId at a surviving account when it dangles", () => {
    const normalized = normalizeAccountStore({
      version: 2,
      providers: {
        anthropic: { activeAccountId: "gone", accounts: { real: { kind: "api_key", secret: "sk" } } },
      },
    });
    expect(normalized.providers.anthropic?.activeAccountId).toBe("real");
  });

  it("does not let a prototype-shaped provider id or account id through", () => {
    const parsed: unknown = JSON.parse(
      '{"version":2,"providers":{"__proto__":{"accounts":{"a":{"kind":"api_key","secret":"x"}}},' +
        '"anthropic":{"accounts":{"__proto__":{"kind":"api_key","secret":"y"},"ok":{"kind":"api_key","secret":"z"}}}}}',
    );
    const normalized = normalizeAccountStore(parsed);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(normalized.providers)).toEqual(["anthropic"]);
    expect(Object.keys(normalized.providers.anthropic?.accounts ?? {})).toEqual(["ok"]);
  });

  it("trims and validates token fields", () => {
    const normalized = normalizeAccountStore({
      version: 2,
      providers: {
        "chatgpt-codex": {
          accounts: {
            a: {
              kind: "oauth",
              tokens: { accessToken: "  at  ", refreshToken: "", expiresAt: "not-a-number", scope: " read " },
            },
          },
        },
      },
    });
    expect(getActiveAccount(normalized, "chatgpt-codex")).toEqual({ kind: "oauth", tokens: { accessToken: "at", scope: "read" } });
  });
});

describe("loadAccountStore / saveAccountStore", () => {
  it("round-trips an api_key account through a real file", () => {
    const home = makeHome();
    const store = addAccount(empty(), "anthropic", { kind: "api_key", secret: "sk-ant" }).store;
    expect(saveAccountStore(store, home)).toBe(true);
    expect(loadAccountStore(home)).toEqual(store);
  });

  it("round-trips an oauth account with tokens and identity", () => {
    const home = makeHome();
    const store = addAccount(empty(), "chatgpt-codex", OAUTH, { accountId: "a1" }).store;
    expect(saveAccountStore(store, home)).toBe(true);
    const loaded = loadAccountStore(home);
    expect(getActiveAccount(loaded, "chatgpt-codex")).toEqual(OAUTH);
  });

  it("reads a legacy flat file as a migrated store", () => {
    const home = makeHome();
    mkdirSync(join(home, ".0sec"), { recursive: true });
    writeFileSync(credentialsFilePath(home), '{"anthropic":"sk-ant-old","openai":"sk-openai"}\n', "utf8");
    const loaded = loadAccountStore(home);
    expect(getActiveAccount(loaded, "anthropic")).toEqual({ kind: "api_key", secret: "sk-ant-old" });
    expect(getActiveAccount(loaded, "openai")).toEqual({ kind: "api_key", secret: "sk-openai" });
  });

  it("degrades a corrupt file to an empty store rather than throwing", () => {
    const home = makeHome();
    mkdirSync(join(home, ".0sec"), { recursive: true });
    writeFileSync(credentialsFilePath(home), "{ not json,,,", "utf8");
    expect(() => loadAccountStore(home)).not.toThrow();
    expect(loadAccountStore(home)).toEqual(empty());
  });

  it("returns an empty store when the file is absent", () => {
    expect(loadAccountStore(makeHome())).toEqual(empty());
  });

  it("writes the file 0600 and the directory 0700, re-tightening a loose file", () => {
    const home = makeHome();
    const dir = join(home, ".0sec");
    const path = join(dir, "credentials.json");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    writeFileSync(path, '{"anthropic":"sk-old"}\n', "utf8");
    chmodSync(path, 0o644);

    const store = addAccount(empty(), "chatgpt-codex", OAUTH).store;
    expect(saveAccountStore(store, home)).toBe(true);
    expect(permissionsOf(path)).toBe(0o600);
    expect(permissionsOf(dir)).toBe(0o700);
  });

  it("returns false instead of throwing when the path is unwritable", () => {
    const parent = makeHome();
    const blocked = join(parent, "home-that-is-a-file");
    writeFileSync(blocked, "not a directory", "utf8");
    const store = addAccount(empty(), "anthropic", { kind: "api_key", secret: "sk" }).store;
    expect(() => saveAccountStore(store, blocked)).not.toThrow();
    expect(saveAccountStore(store, blocked)).toBe(false);
  });
});

describe("account transforms (add / active / remove / logout)", () => {
  it("adds an account, makes it active by default, and is pure over the input", () => {
    const base = empty();
    const { store, accountId } = addAccount(base, "anthropic", { kind: "api_key", secret: "sk" });
    expect(accountId).toBe("default");
    expect(getActiveAccount(store, "anthropic")).toEqual({ kind: "api_key", secret: "sk" });
    expect(base.providers).toEqual({}); // input untouched
  });

  it("supports multiple accounts per provider and switching the active one", () => {
    let store = empty();
    store = addAccount(store, "chatgpt-codex", { kind: "oauth", tokens: { accessToken: "at-a" } }, { accountId: "a", makeActive: true }).store;
    store = addAccount(store, "chatgpt-codex", { kind: "oauth", tokens: { accessToken: "at-b" } }, { accountId: "b", makeActive: false }).store;

    expect(listAccounts(store, "chatgpt-codex").map((a) => a.accountId).sort()).toEqual(["a", "b"]);
    expect(listAccounts(store, "chatgpt-codex").find((a) => a.active)?.accountId).toBe("a");

    store = setActiveAccount(store, "chatgpt-codex", "b");
    expect(getActiveAccount(store, "chatgpt-codex")).toEqual({ kind: "oauth", tokens: { accessToken: "at-b" } });
  });

  it("leaves the store unchanged when switching to an unknown account", () => {
    const store = addAccount(empty(), "anthropic", { kind: "api_key", secret: "sk" }).store;
    expect(setActiveAccount(store, "anthropic", "nope")).toBe(store);
    expect(setActiveAccount(store, "openai", "any")).toBe(store);
  });

  it("removes one account and repoints active to a survivor", () => {
    let store = empty();
    store = addAccount(store, "chatgpt-codex", { kind: "oauth", tokens: { accessToken: "at-a" } }, { accountId: "a" }).store;
    store = addAccount(store, "chatgpt-codex", { kind: "oauth", tokens: { accessToken: "at-b" } }, { accountId: "b" }).store;
    // b is active (added last); removing it repoints to a.
    store = removeAccount(store, "chatgpt-codex", "b");
    expect(listAccounts(store, "chatgpt-codex").map((a) => a.accountId)).toEqual(["a"]);
    expect(getActiveAccount(store, "chatgpt-codex")).toEqual({ kind: "oauth", tokens: { accessToken: "at-a" } });
  });

  it("drops the provider entirely when its last account is removed", () => {
    let store = addAccount(empty(), "anthropic", { kind: "api_key", secret: "sk" }, { accountId: "only" }).store;
    store = removeAccount(store, "anthropic", "only");
    expect(store.providers.anthropic).toBeUndefined();
  });

  it("logs a provider out completely", () => {
    let store = empty();
    store = addAccount(store, "chatgpt-codex", OAUTH, { accountId: "a" }).store;
    store = addAccount(store, "chatgpt-codex", { kind: "oauth", tokens: { accessToken: "at-b" } }, { accountId: "b" }).store;
    store = logoutProvider(store, "chatgpt-codex");
    expect(store.providers["chatgpt-codex"]).toBeUndefined();
    expect(getActiveAccount(store, "chatgpt-codex")).toBeUndefined();
  });

  it("throws on an unknown provider or an unsupported record kind, never leaking the secret", () => {
    expect(() => addAccount(empty(), "meta", { kind: "api_key", secret: "top-secret" })).toThrow(/unknown provider/);
    try {
      addAccount(empty(), "anthropic", { kind: "oauth", tokens: { accessToken: "top-secret" } });
      throw new Error("expected addAccount to throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("top-secret");
      expect((err as Error).message).toMatch(/does not support/);
    }
  });
});

describe("accountEnvPatch", () => {
  it("maps an api_key account to the provider's key env var", () => {
    const store = addAccount(empty(), "anthropic", { kind: "api_key", secret: "sk-ant" }).store;
    expect(accountEnvPatch(store, {})).toEqual({ ANTHROPIC_API_KEY: "sk-ant" });
  });

  it("maps an oauth account's access and refresh tokens to their env vars", () => {
    const store = addAccount(empty(), "chatgpt-codex", {
      kind: "oauth",
      tokens: { accessToken: "at-1", refreshToken: "rt-1" },
    }).store;
    expect(accountEnvPatch(store, {})).toEqual({
      "0SEC_CHATGPT_ACCESS_TOKEN": "at-1",
      "0SEC_CHATGPT_OAUTH_REFRESH_TOKEN": "rt-1",
    });
  });

  it("maps a refresh-only oauth account to only the refresh var", () => {
    const store = addAccount(empty(), "chatgpt-codex", { kind: "oauth", tokens: { refreshToken: "rt-only" } }).store;
    expect(accountEnvPatch(store, {})).toEqual({ "0SEC_CHATGPT_OAUTH_REFRESH_TOKEN": "rt-only" });
  });

  it("respects env-wins for api_key (a set shell var is never overridden)", () => {
    const store = addAccount(empty(), "anthropic", { kind: "api_key", secret: "sk-stored" }).store;
    expect(accountEnvPatch(store, { ANTHROPIC_API_KEY: "sk-shell" })).toEqual({});
  });

  it("respects env-wins for oauth across ALL of the provider's vars", () => {
    // The shell configured codex via the refresh token; injecting a stored
    // access token would mix two credential sources into one auth attempt.
    const store = addAccount(empty(), "chatgpt-codex", {
      kind: "oauth",
      tokens: { accessToken: "at-stored", refreshToken: "rt-stored" },
    }).store;
    expect(accountEnvPatch(store, { "0SEC_CHATGPT_OAUTH_REFRESH_TOKEN": "rt-shell" })).toEqual({});
  });

  it("treats an exported-but-blank var as absent and fills it", () => {
    const store = addAccount(empty(), "anthropic", { kind: "api_key", secret: "sk-stored" }).store;
    expect(accountEnvPatch(store, { ANTHROPIC_API_KEY: "  " })).toEqual({ ANTHROPIC_API_KEY: "sk-stored" });
  });

  it("only projects the active account, not the others", () => {
    let store = empty();
    store = addAccount(store, "chatgpt-codex", { kind: "oauth", tokens: { accessToken: "at-a" } }, { accountId: "a" }).store;
    store = addAccount(store, "chatgpt-codex", { kind: "oauth", tokens: { accessToken: "at-b" } }, { accountId: "b", makeActive: true }).store;
    expect(accountEnvPatch(store, {})).toEqual({ "0SEC_CHATGPT_ACCESS_TOKEN": "at-b" });
  });

  it("does not mutate its inputs and never reads process.env", () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ambient";
    try {
      const store = addAccount(empty(), "anthropic", { kind: "api_key", secret: "sk-stored" }).store;
      const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
      const snapshot = JSON.stringify(store);
      expect(accountEnvPatch(store, env)).toEqual({ ANTHROPIC_API_KEY: "sk-stored" });
      expect(JSON.stringify(store)).toBe(snapshot);
      expect(env).toEqual({ PATH: "/usr/bin" });
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe("legacy flat helpers over the v2 store", () => {
  it("saveCredentials then loadAccountStore surfaces tagged api_key records", () => {
    const home = makeHome();
    expect(saveCredentials({ anthropic: "sk-ant", openai: "sk-oai" }, home)).toBe(true);
    const store = loadAccountStore(home);
    expect(getActiveAccount(store, "anthropic")).toEqual({ kind: "api_key", secret: "sk-ant" });
    expect(getActiveAccount(store, "openai")).toEqual({ kind: "api_key", secret: "sk-oai" });
  });

  it("saveCredentials preserves an existing oauth account it does not manage", () => {
    const home = makeHome();
    const withOauth = addAccount(empty(), "chatgpt-codex", OAUTH, { accountId: "a1" }).store;
    expect(saveAccountStore(withOauth, home)).toBe(true);

    // An old caller saves an API key; the codex oauth account must survive.
    expect(saveCredentials({ anthropic: "sk-ant" }, home)).toBe(true);
    const store = loadAccountStore(home);
    expect(getActiveAccount(store, "chatgpt-codex")).toEqual(OAUTH);
    expect(getActiveAccount(store, "anthropic")).toEqual({ kind: "api_key", secret: "sk-ant" });
  });

  it("loadCredentials projects only api_key accounts, hiding oauth", () => {
    const home = makeHome();
    let store = addAccount(empty(), "anthropic", { kind: "api_key", secret: "sk-ant" }).store;
    store = addAccount(store, "chatgpt-codex", OAUTH).store;
    saveAccountStore(store, home);
    expect(loadCredentials(home)).toEqual({ anthropic: "sk-ant" });
  });
});

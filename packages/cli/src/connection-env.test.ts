import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredentials } from "./state/credential-store.js";
import { saveConnectionConfig } from "./web/connection-config.js";
import { savedConnectionEnvPatch } from "./connection-env.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it("restores a saved Together key and its exact endpoint together without mutating the caller", () => {
  const home = mkdtempSync(join(tmpdir(), "0-connection-env-")); homes.push(home);
  saveCredentials({ together: "synthetic-saved-key" }, home);
  saveConnectionConfig("together", { baseUrl: "https://saved.fixture/api/v1" }, home);
  const env = {};
  expect(savedConnectionEnvPatch(env, home)).toEqual({ TOGETHER_API_KEY: "synthetic-saved-key", TOGETHER_BASE_URL: "https://saved.fixture/api/v1" });
  expect(env).toEqual({});
  expect(savedConnectionEnvPatch({ TOGETHER_API_KEY: "explicit-key", TOGETHER_BASE_URL: "https://explicit.fixture/api/v1" }, home)).toEqual({});
});

it("keeps removed-provider credentials and settings on disk across saves, without restoring them to the environment", () => {
  const home = mkdtempSync(join(tmpdir(), "0-connection-env-removed-")); homes.push(home);
  const dir = join(home, ".0"); mkdirSync(dir, { recursive: true });
  const credentials = { version: 2, providers: {
    cline: { activeAccountId: "default", accounts: { default: { kind: "api_key", secret: "stale-cline-secret" } } },
    copilot: { activeAccountId: "gh", accounts: { gh: { kind: "oauth", tokens: { accessToken: "stale-gh-token" } } } },
    google: { activeAccountId: "g", accounts: { g: { kind: "oauth", tokens: { refreshToken: "stale-google-refresh" }, oauthClient: { clientId: "c" } } } },
  } };
  writeFileSync(join(dir, "credentials.json"), JSON.stringify(credentials));
  writeFileSync(join(dir, "web-connections.json"), JSON.stringify({ cline: { baseUrl: "https://stale.example/api/v1" } }));
  // Removed providers contribute nothing to the environment.
  expect(savedConnectionEnvPatch({}, home)).toEqual({});
  // Saving an unrelated provider must not delete the removed ones.
  saveCredentials({ together: "new-key" }, home);
  saveConnectionConfig("together", { baseUrl: "https://together.example/v1" }, home);
  const after = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
  expect(after.providers.cline).toEqual(credentials.providers.cline);
  expect(after.providers.copilot).toEqual(credentials.providers.copilot);
  expect(after.providers.google).toEqual(credentials.providers.google);
  expect(after.providers.together.accounts.default.secret).toBe("new-key");
  expect(JSON.parse(readFileSync(join(dir, "web-connections.json"), "utf8")).cline).toEqual({ baseUrl: "https://stale.example/api/v1" });
});

it("preserves a legacy flat-file key for a removed provider when another key is saved", () => {
  const home = mkdtempSync(join(tmpdir(), "0-connection-env-flat-")); homes.push(home);
  const dir = join(home, ".0"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ cline: "flat-cline-key", openai: "flat-openai" }));
  saveCredentials({ openai: "flat-openai", together: "t" }, home);
  const after = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
  expect(after.providers.cline.accounts.default.secret).toBe("flat-cline-key");
});

import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredentials } from "./tui/credential-store.js";
import { saveConnectionConfig } from "./web/connection-config.js";
import { savedConnectionEnvPatch } from "./connection-env.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it("restores a saved Cline key and its exact endpoint together without mutating the caller", () => {
  const home = mkdtempSync(join(tmpdir(), "0-connection-env-")); homes.push(home);
  saveCredentials({ cline: "synthetic-saved-key" }, home);
  saveConnectionConfig("cline", { baseUrl: "https://saved.fixture/api/v1" }, home);
  const env = {};
  expect(savedConnectionEnvPatch(env, home)).toEqual({ CLINE_API_KEY: "synthetic-saved-key", CLINE_BASE_URL: "https://saved.fixture/api/v1" });
  expect(env).toEqual({});
  expect(savedConnectionEnvPatch({ CLINE_API_KEY: "explicit-key", CLINE_BASE_URL: "https://explicit.fixture/api/v1" }, home)).toEqual({});
});

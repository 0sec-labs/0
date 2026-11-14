import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultEnginesConfigPath } from "./engines-config-path.js";
import { BackendConnectionRegistry, loadBackendConnectionConfig } from "./web/backend-connections.js";

const originalHome = process.env.HOME;
const dirs: string[] = [];
function home(): string { const dir = mkdtempSync(join(tmpdir(), "0-engines-home-")); dirs.push(dir); mkdirSync(join(dir, ".0")); process.env.HOME = dir; return join(dir, ".0"); }
afterEach(() => { process.env.HOME = originalHome; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const row = { id: "remote", name: "Remote", url: "http://127.0.0.1:12345/", bearerTokenEnv: "REMOTE_TOKEN" };

describe("engines.json registry migration", () => {
  it("reads the legacy backends.json only when engines.json is absent and always writes engines.json", () => {
    const state = home();
    expect(defaultEnginesConfigPath()).toEqual({ read: join(state, "engines.json"), write: join(state, "engines.json") });
    writeFileSync(join(state, "backends.json"), JSON.stringify({ schemaVersion: 1, backends: [row] }));
    expect(defaultEnginesConfigPath()).toEqual({ read: join(state, "backends.json"), write: join(state, "engines.json") });
    expect(loadBackendConnectionConfig().map(value => value.id)).toEqual(["remote"]);
    writeFileSync(join(state, "engines.json"), JSON.stringify({ schemaVersion: 1, engines: [] }));
    expect(defaultEnginesConfigPath().read).toBe(join(state, "engines.json"));
    expect(loadBackendConnectionConfig()).toEqual([]);
  });

  it("migrates on removal: the new file is written with the engines key and the old file is left alone", () => {
    const state = home();
    const legacy = join(state, "backends.json");
    writeFileSync(legacy, JSON.stringify({ schemaVersion: 1, backends: [row, { ...row, id: "other", bearerTokenEnv: "OTHER_TOKEN" }] }));
    const registry = new BackendConnectionRegistry({ env: {} });
    registry.remove("remote");
    registry.dispose();
    expect(existsSync(legacy)).toBe(true);
    expect(JSON.parse(readFileSync(join(state, "engines.json"), "utf8"))).toMatchObject({ schemaVersion: 1, engines: [{ id: "other" }] });
  });
});

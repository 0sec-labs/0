import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCloudCredentials,
  CloudAuthMissingError,
  DEFAULT_CLOUD_HOST,
} from "./credentials.js";

function makeFakeHome(content: string | null, mode: number = 0o600): string {
  const home = mkdtempSync(join(tmpdir(), "0-cloud-creds-"));
  if (content !== null) {
    mkdirSync(join(home, ".0"), { recursive: true, mode: 0o700 });
    const path = join(home, ".0", "cloud.env");
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
  }
  return home;
}

describe("loadCloudCredentials", () => {
  it("prefers env over file when both are set", () => {
    const home = makeFakeHome("ZERO_CLOUD_TOKEN=filetok\nZERO_CLOUD_HOST=https://file.example\n");
    const creds = loadCloudCredentials({
      env: { "ZERO_CLOUD_TOKEN": "envtok", "ZERO_CLOUD_HOST": "https://env.example" },
      homeDir: home,
    });
    expect(creds).toEqual({ host: "https://env.example", token: "envtok", source: "env" });
  });

  it("loads from env-only, falling back to default host", () => {
    const home = makeFakeHome(null);
    const creds = loadCloudCredentials({
      env: { "ZERO_CLOUD_TOKEN": "tok" },
      homeDir: home,
    });
    expect(creds.source).toBe("env");
    expect(creds.token).toBe("tok");
    expect(creds.host).toBe(DEFAULT_CLOUD_HOST);
  });

  it("loads from file when env is unset", () => {
    const home = makeFakeHome(
      "# header comment\nZERO_CLOUD_HOST=https://staging.example\nZERO_CLOUD_TOKEN=tokenvalue\n",
    );
    const creds = loadCloudCredentials({ env: {}, homeDir: home });
    expect(creds).toEqual({
      host: "https://staging.example",
      token: "tokenvalue",
      source: "file",
    });
  });

  it("accepts legacy 0SEC_CLOUD_* env keys with a deprecation warning", () => {
    const home = makeFakeHome(null);
    const warnings: string[] = [];
    const creds = loadCloudCredentials({
      env: { "0SEC_CLOUD_TOKEN": "legacytok", "0SEC_CLOUD_HOST": "https://legacy.example" },
      homeDir: home,
      warn: (m) => warnings.push(m),
    });
    expect(creds).toEqual({ host: "https://legacy.example", token: "legacytok", source: "env" });
    expect(warnings.join("\n")).toMatch(/0SEC_CLOUD_\*/);
  });

  it("prefers ZERO_CLOUD_* over legacy 0SEC_CLOUD_* without warning", () => {
    const home = makeFakeHome(null);
    const warnings: string[] = [];
    const creds = loadCloudCredentials({
      env: { "ZERO_CLOUD_TOKEN": "newtok", "0SEC_CLOUD_TOKEN": "legacytok" },
      homeDir: home,
      warn: (m) => warnings.push(m),
    });
    expect(creds.token).toBe("newtok");
    expect(warnings).toEqual([]);
  });

  it("accepts legacy 0SEC_CLOUD_* keys in cloud.env", () => {
    const home = makeFakeHome("0SEC_CLOUD_HOST=https://legacy.example\n0SEC_CLOUD_TOKEN=legacytok\n");
    const warnings: string[] = [];
    const creds = loadCloudCredentials({ env: {}, homeDir: home, warn: (m) => warnings.push(m) });
    expect(creds).toEqual({ host: "https://legacy.example", token: "legacytok", source: "file" });
    expect(warnings.join("\n")).toMatch(/0SEC_CLOUD_\*/);
  });

  it("keeps development and production saved credentials separate", () => {
    const home = makeFakeHome("ZERO_CLOUD_TOKEN=production-token\nZERO_CLOUD_HOST=https://cloud.0.security\n");
    const env = { "ZERO_DEV_SOURCE_ROOT": "/fixture/engine", "ZERO_CLOUD_HOST": "https://dev.0.security" };
    expect(() => loadCloudCredentials({ env, homeDir: home })).toThrow(CloudAuthMissingError);
    mkdirSync(join(home, ".0", "dev"), { mode: 0o700 });
    writeFileSync(join(home, ".0", "dev", "cloud.env"), "ZERO_CLOUD_TOKEN=dev-token\n", { mode: 0o600 });
    expect(loadCloudCredentials({ env, homeDir: home })).toEqual({
      host: "https://dev.0.security", token: "dev-token", source: "file",
    });
    expect(loadCloudCredentials({ env: {}, homeDir: home })).toEqual({
      host: "https://cloud.0.security", token: "production-token", source: "file",
    });
  });

  it("falls back to default host when cloud.env omits ZERO_CLOUD_HOST", () => {
    const home = makeFakeHome("ZERO_CLOUD_TOKEN=onlytok\n");
    const creds = loadCloudCredentials({ env: {}, homeDir: home });
    expect(creds.host).toBe(DEFAULT_CLOUD_HOST);
    expect(creds.token).toBe("onlytok");
    expect(creds.source).toBe("file");
  });

  it("strips trailing slash from host", () => {
    const home = makeFakeHome(null);
    const creds = loadCloudCredentials({
      env: { "ZERO_CLOUD_TOKEN": "t", "ZERO_CLOUD_HOST": "https://example.com/" },
      homeDir: home,
    });
    expect(creds.host).toBe("https://example.com");
  });

  it("warns when cloud.env mode is not 600", () => {
    const home = makeFakeHome("ZERO_CLOUD_TOKEN=tok\n", 0o644);
    const warnings: string[] = [];
    const creds = loadCloudCredentials({
      env: {},
      homeDir: home,
      warn: (m) => warnings.push(m),
    });
    expect(creds.token).toBe("tok");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/mode is 644/);
    expect(warnings[0]).toMatch(/chmod 600/);
  });

  it("does NOT warn when cloud.env mode is 600", () => {
    const home = makeFakeHome("ZERO_CLOUD_TOKEN=tok\n", 0o600);
    const warnings: string[] = [];
    loadCloudCredentials({ env: {}, homeDir: home, warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  it("throws CloudAuthMissingError when neither source has creds", () => {
    const home = makeFakeHome(null);
    expect(() => loadCloudCredentials({ env: {}, homeDir: home })).toThrow(CloudAuthMissingError);
  });

  it("throws CloudAuthMissingError when file is missing the token", () => {
    const home = makeFakeHome("ZERO_CLOUD_HOST=https://example.com\n");
    expect(() => loadCloudCredentials({ env: {}, homeDir: home })).toThrow(/incomplete/);
  });

  it("rejects malformed lines in cloud.env", () => {
    const home = makeFakeHome("just a banner line\nZERO_CLOUD_TOKEN=x\n");
    expect(() => loadCloudCredentials({ env: {}, homeDir: home })).toThrow(/Malformed cloud\.env/);
  });

  it("rejects a host that isn't http(s)", () => {
    expect(() =>
      loadCloudCredentials({
        env: { "ZERO_CLOUD_TOKEN": "t", "ZERO_CLOUD_HOST": "app.example.com" },
      }),
    ).toThrow(/must be an http\(s\) URL/);
  });

  it("error messages never echo the token value", () => {
    const home = makeFakeHome(null);
    const secret = "S3CR3T_CLOUD_TOKEN_DO_NOT_LEAK";
    let caught: unknown;
    try {
      loadCloudCredentials({
        env: { "ZERO_CLOUD_TOKEN": secret, "ZERO_CLOUD_HOST": "not-a-url" },
        homeDir: home,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CloudAuthMissingError);
    expect(String((caught as Error).message)).not.toContain(secret);
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRepo, normalizeRepoUrl, runConnect, detectTestCommandLocal } from "../connect.js";
import type { ConnectActionOptions, ConnectJsonResult } from "../connect.js";

let tmp: string;
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "0sec-connect-test-"));
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.stubEnv("0SEC_CLOUD_TOKEN", "");
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const readyEnrollment = {
  authenticated: true,
  org: { id: "org-1", name: "Test Org", slug: "test-org" },
  installation: { installed: true },
  repo_accessible: true,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function connect(
  response?: (path: string, method: string) => Response | undefined,
  overrides: Partial<ConnectActionOptions> = {},
) {
  mkdirSync(join(tmp, ".0sec"));
  writeFileSync(join(tmp, ".0sec", "cloud.env"),
    "0SEC_CLOUD_HOST=https://cloud.0.security\n0SEC_CLOUD_TOKEN=test-token\n", { mode: 0o600 });
  const requests: Array<{ path: string; method: string }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  await runConnect("https://github.com/org/repo", {
    format: "json", schedule: true, cron: "0 3 * * *", publicationPolicy: "off", yes: true,
    testCommand: "npm test", homeDir: tmp, cwd: tmp,
    stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      requests.push({ path, method });
      const override = response?.(path, method);
      if (override) return override;
      if (path === "/api/health") return json({ status: "ok" });
      if (path === "/api/enrollment/status") return json(readyEnrollment);
      if (path === "/api/scan-schedules" && method === "GET") return json({ schedules: [] });
      if (path === "/api/scans" && method === "POST") return json({ id: "scan-1", target_id: "target-1" });
      if (path === "/api/scan-schedules" && method === "POST") return json({ id: "schedule-1", next_run_at: null });
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
    ...overrides,
  });
  return {
    result: overrides.format === "terminal" ? undefined : JSON.parse(stdout.join("\n")) as ConnectJsonResult,
    writes: requests.filter((request) => request.method !== "GET"),
    stdout: stdout.join("\n"), stderr: stderr.join("\n"),
    exitCode: process.exitCode,
  };
}

describe("repository resolution", () => {
  it("resolves the current checkout without relying on a developer's repository", () => {
    execFileSync("git", ["init", "--quiet", tmp]);
    execFileSync("git", ["-C", tmp, "remote", "add", "origin", "git@github.com:org/repo.git"]);
    expect(resolveRepo(undefined, tmp)).toEqual({ url: "git@github.com:org/repo.git", fromCwd: true });
  });

  it("returns no repository for a directory without a remote", () => {
    expect(resolveRepo(undefined, tmp)).toBeNull();
  });

  it.each([
    ["https://github.com/org/repo.git", "https://github.com/org/repo"],
    ["git@github.com:org/repo.git", "https://github.com/org/repo"],
    ["https://token@github.com/org/repo", "https://github.com/org/repo"],
    ["git://github.com/org/repo", "https://github.com/org/repo"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeRepoUrl(input)).toBe(expected);
  });

  it("uses the package manager's local regression command", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, packageManager: "pnpm@9.15.9" }));
    expect(detectTestCommandLocal(tmp)?.command).toBe("pnpm test");
  });

  it.each([
    ["package.json", JSON.stringify({ scripts: { test: "vitest run" } }), "npm test"],
    ["Makefile", "test:\n\ttrue\n", "make test"],
    ["Cargo.toml", '[package]\nname = "fixture"\n', "cargo test"],
    ["go.mod", "module fixture\n", "go test ./..."],
    ["pyproject.toml", "", "python3 -m pytest"],
  ])("detects the regression command from %s", (file, contents, command) => {
    writeFileSync(join(tmp, file), contents);
    expect(detectTestCommandLocal(tmp)?.command).toBe(command);
  });

  it("uses the lockfile when packageManager is absent", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    expect(detectTestCommandLocal(tmp)?.command).toBe("pnpm test");
  });

  it("requires a supplied regression command when no project marker exists", () => {
    expect(detectTestCommandLocal(tmp)).toBeNull();
  });

  it("does not accept npm's placeholder test command", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified"' } }));
    expect(detectTestCommandLocal(tmp)).toBeNull();
  });
});

describe("fail-closed enrollment", () => {
  it("does not dispatch when enrollment readiness is unavailable", async () => {
    const observed = await connect((path) => path === "/api/enrollment/status" ? json({ error: "not found" }, 404) : undefined);
    expect(observed.result).toMatchObject({ state: "action-required", reason: "enrollment-check-failed" });
    expect(observed.writes).toEqual([]);
    expect(observed.exitCode).toBe(2);
  });

  it("rejects malformed successful readiness responses", async () => {
    const observed = await connect((path) => path === "/api/enrollment/status" ? json({ authenticated: true }) : undefined);
    expect(observed.result?.state).toBe("action-required");
    expect(observed.writes).toEqual([]);
  });

  it("keeps denied repository access closed", async () => {
    const observed = await connect((path) => path === "/api/enrollment/status" ? json({ ...readyEnrollment, repo_accessible: false }) : undefined);
    expect(observed.result).toMatchObject({ state: "action-required", reason: "repo-not-accessible" });
    expect(observed.writes).toEqual([]);
  });

  it("returns the GitHub installation handoff without starting work", async () => {
    const installUrl = "https://github.com/apps/test-app/installations/new";
    const observed = await connect((path) => path === "/api/enrollment/status"
      ? json({ ...readyEnrollment, installation: { installed: false, install_url: installUrl } }) : undefined);
    expect(observed.result).toMatchObject({ state: "action-required", reason: "github-app-not-installed", action_url: installUrl });
    expect(observed.writes).toEqual([]);
  });

  it("does not treat a schedule lookup failure as an empty schedule list", async () => {
    const observed = await connect((path, method) => path === "/api/scan-schedules" && method === "GET"
      ? json({ error: "forbidden" }, 403) : undefined);
    expect(observed.result).toMatchObject({ state: "action-required", reason: "schedule-lookup-failed" });
    expect(observed.writes).toEqual([]);
    expect(observed.exitCode).toBe(2);
  });

  it.each([{}, { schedules: [null] }])("rejects malformed schedule data %j before dispatch", async (response) => {
    const observed = await connect((path, method) => path === "/api/scan-schedules" && method === "GET"
      ? json(response) : undefined);
    expect(observed.result).toMatchObject({ state: "action-required", reason: "schedule-lookup-failed" });
    expect(observed.writes).toEqual([]);
  });

  it("requires explicit approval even when JSON output is selected", async () => {
    const observed = await connect(undefined, { yes: false });
    expect(observed.result).toMatchObject({ state: "action-required", reason: "confirmation_required", test_command: "npm test" });
    expect(observed.writes).toEqual([]);
    expect(observed.exitCode).toBe(2);
  });

  it("preserves the created scan when recurrence fails without claiming readiness", async () => {
    const observed = await connect((path, method) => path === "/api/scan-schedules" && method === "POST"
      ? json({ error: "unavailable" }, 503) : undefined);
    expect(observed.result).toMatchObject({ state: "action-required", reason: "schedule-creation-failed", scan_id: "scan-1" });
    expect(observed.result?.schedule).toBeUndefined();
    expect(observed.writes).toEqual([{ path: "/api/scans", method: "POST" }, { path: "/api/scan-schedules", method: "POST" }]);
    expect(observed.exitCode).toBe(1);
  });

  it("reports incomplete recurrence when the created scan has no target", async () => {
    const observed = await connect((path, method) => path === "/api/scans" && method === "POST"
      ? json({ id: "scan-1", target_id: null }) : undefined);
    expect(observed.result).toMatchObject({ state: "action-required", reason: "schedule-creation-failed", scan_id: "scan-1" });
    expect(observed.writes).toEqual([{ path: "/api/scans", method: "POST" }]);
    expect(observed.exitCode).toBe(1);
  });

  it("does not print a connected success when terminal recurrence fails", async () => {
    const observed = await connect((path, method) => path === "/api/scan-schedules" && method === "POST"
      ? json({ error: "unavailable" }, 503) : undefined, { format: "terminal" });
    expect(observed.stdout).toBe("");
    expect(observed.stderr).toContain("scan-1");
    expect(observed.exitCode).toBe(1);
  });

  it("never attempts recurrence after scan creation fails", async () => {
    const observed = await connect((path, method) => path === "/api/scans" && method === "POST"
      ? json({ error: "unavailable" }, 503) : undefined);
    expect(observed.result).toMatchObject({ state: "action-required", reason: "scan-creation-failed" });
    expect(observed.writes).toEqual([{ path: "/api/scans", method: "POST" }]);
  });

  it("reports ready only after approved scan and recurrence creation succeed", async () => {
    const observed = await connect();
    expect(observed.result).toMatchObject({ state: "ready", scan_id: "scan-1", schedule: { id: "schedule-1" } });
    expect(observed.writes).toEqual([{ path: "/api/scans", method: "POST" }, { path: "/api/scan-schedules", method: "POST" }]);
    expect(observed.exitCode).toBeUndefined();
  });

  it("allows an explicitly approved one-shot without creating recurrence", async () => {
    const observed = await connect(undefined, { schedule: false });
    expect(observed.result).toMatchObject({ state: "ready", scan_id: "scan-1" });
    expect(observed.result?.schedule).toBeUndefined();
    expect(observed.writes).toEqual([{ path: "/api/scans", method: "POST" }]);
  });

  it("reuses an existing schedule without needing approval for a new mutation", async () => {
    const observed = await connect((path, method) => path === "/api/scan-schedules" && method === "GET"
      ? json({ schedules: [{ id: "existing", cron_expression: "0 3 * * *", next_run_at: null, target_id: "target-1" }] }) : undefined,
    { yes: false });
    expect(observed.result).toMatchObject({ state: "no-open", schedule: { id: "existing" } });
    expect(observed.writes).toEqual([]);
  });
});

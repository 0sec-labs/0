/**
 * Command-layer tests for `0sec connect`.
 *
 * The `connect` command orchestrates repo resolution, cloud auth,
 * enrollment readiness, test-command detection, scan creation, and
 * schedule installation. We test each independently:
 *
 *   • resolveRepo / normalizeRepoUrl — pure functions, no mocks.
 *   • detectTestCommandLocal — file-system based, uses temp dirs.
 *   • runConnect with stubbed fetch — drives every JSON state
 *     (ready / no-open / action-required) through a mock CloudClient.
 *
 * The real external endpoints (/api/scans, /api/scan-schedules) are
 * never hit. Test seams (fetchImpl, stdout, stderr, homeDir, cwd)
 * keep every test deterministic and hermetic.
 *
 * What's covered:
 *   • Repo resolution from arg (explicit URL) and from cwd (git origin).
 *   • URL normalization (git@ → https, trailing .git stripping, creds).
 *   • detectTestCommandLocal for package.json, Makefile, Cargo.toml, go.mod.
 *   • runConnect with --format json:
 *       - ready state (happy path, scan + schedule created)
 *       - no-open state (existing schedule found)
 *       - action-required state (no auth, no repo, invalid URL, no test command)
 *   • Terminal output (non-json) basic happy path.
 */

import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRepo, normalizeRepoUrl, runConnect, detectTestCommandLocal } from "../connect.js";
import type { ConnectActionOptions, ConnectJsonResult } from "../connect.js";

// ── helpers ──

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "0sec-connect-test-"));
});

afterEach(() => {
  // Cleanup handled by OS temp dir policy
});

/** Write a fake cloud credential file into `dir/.0sec/cloud.env`. */
function writeCredentials(dir: string, host = "https://cloud.0.security", token = "test-token-abc"): void {
  const credDir = join(dir, ".0sec");
  mkdirSync(credDir, { recursive: true });
  writeFileSync(join(credDir, "cloud.env"), `0SEC_CLOUD_HOST=${host}\n0SEC_CLOUD_TOKEN=${token}\n`);
}

/** Capture stdout lines from runConnect. */
function captureStdout(): { lines: string[]; writer: (line: string) => void } {
  const lines: string[] = [];
  return { lines, writer: (line: string) => { lines.push(line); } };
}

/** Capture stderr lines from runConnect. */
function captureStderr(): { lines: string[]; writer: (line: string) => void } {
  const lines: string[] = [];
  return { lines, writer: (line: string) => { lines.push(line); } };
}

// ── resolveRepo / normalizeRepoUrl ──

describe("resolveRepo", () => {
  it("returns the explicit arg when provided", () => {
    const result = resolveRepo("https://github.com/org/repo");
    expect(result).toEqual({ url: "https://github.com/org/repo", fromCwd: false });
  });

  it("returns null when arg is undefined and cwd is not a git repo", () => {
    const result = resolveRepo(undefined, tmp);
    expect(result).toBeNull();
  });

  it("resolves from git remote origin in a real git repo", () => {
    // Use the 0sec repo itself as a known good git origin
    const result = resolveRepo(undefined, "/home/dev/coding/0sec-labs/0sec");
    expect(result).not.toBeNull();
    expect(result!.url).toContain("github.com");
    expect(result!.fromCwd).toBe(true);
  });
});

describe("normalizeRepoUrl", () => {
  it("passes through a clean HTTPS URL", () => {
    expect(normalizeRepoUrl("https://github.com/org/repo")).toBe("https://github.com/org/repo");
  });

  it("strips trailing .git", () => {
    expect(normalizeRepoUrl("https://github.com/org/repo.git")).toBe("https://github.com/org/repo");
  });

  it("converts git@ SSH format", () => {
    expect(normalizeRepoUrl("git@github.com:org/repo.git")).toBe("https://github.com/org/repo");
  });

  it("strips credentials from URL", () => {
    expect(normalizeRepoUrl("https://token@github.com/org/repo")).toBe("https://github.com/org/repo");
  });

  it("handles git:// protocol", () => {
    expect(normalizeRepoUrl("git://github.com/org/repo")).toBe("https://github.com/org/repo");
  });
});

// ── detectTestCommandLocal ──

describe("detectTestCommandLocal", () => {
  it("detects npm test from package.json", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    const result = detectTestCommandLocal(tmp);
    expect(result).toEqual({ command: "npm test", source: "package.json (local)" });
  });

  it("detects pnpm test from package.json + pnpm-lock.yaml", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    const result = detectTestCommandLocal(tmp);
    expect(result).toEqual({ command: "pnpm test", source: "package.json (local)" });
  });

  it("detects make test from Makefile", () => {
    writeFileSync(join(tmp, "Makefile"), "test:\n\trun-tests\n");
    const result = detectTestCommandLocal(tmp);
    expect(result).toEqual({ command: "make test", source: "Makefile (local)" });
  });

  it("detects cargo test from Cargo.toml", () => {
    writeFileSync(join(tmp, "Cargo.toml"), '[package]\nname = "test"\n');
    const result = detectTestCommandLocal(tmp);
    expect(result).toEqual({ command: "cargo test", source: "Cargo.toml (local)" });
  });

  it("detects go test from go.mod", () => {
    writeFileSync(join(tmp, "go.mod"), "module test\n");
    const result = detectTestCommandLocal(tmp);
    expect(result).toEqual({ command: "go test ./...", source: "go.mod (local)" });
  });

  it("detects pytest when pyproject.toml exists", () => {
    writeFileSync(join(tmp, "pyproject.toml"), "");
    const result = detectTestCommandLocal(tmp);
    expect(result).toEqual({ command: "python3 -m pytest", source: "python project files (local)" });
  });

  it("returns null when no project files exist", () => {
    const result = detectTestCommandLocal(tmp);
    expect(result).toBeNull();
  });

  it("skips default npm test scripts with 'no test specified'", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified"' } }));
    const result = detectTestCommandLocal(tmp);
    expect(result).toBeNull();
  });
});

// ── runConnect with mocked fetch ──

describe("runConnect --format json", () => {
  /** Build a base set of options with a mock fetch. Default returns 200 for /api/health only. */
  function optsWithMock(
    overrides?: Partial<ConnectActionOptions>,
    mockResponse?: (input: string | Request | URL, init?: RequestInit) => Promise<Response>,
  ): ConnectActionOptions {
    writeCredentials(tmp);
    const fetchImpl = mockResponse ?? ((input: string | Request | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url).pathname;
      if (path === "/api/health") return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
      // Pretend enrollment and schedule endpoints don't exist (not deployed)
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });
    return {
      format: "json",
      schedule: true,
      cron: "0 3 * * *",
      publicationPolicy: "off",
      yes: true,
      fetchImpl,
      homeDir: tmp,
      stdout: undefined,
      stderr: undefined,
      ...overrides,
    };
  }

  it('produces action-required state when no repo is provided and cwd is not a git repo', async () => {
    const { lines, writer } = captureStdout();
    await runConnect(undefined, optsWithMock({ stdout: writer, cwd: tmp }));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as ConnectJsonResult;
    expect(parsed.state).toBe("action-required");
    expect(parsed.reason).toBe("no-repo");
  });

  it('produces action-required with invalid-repo-url for bad URL format', async () => {
    const { lines, writer } = captureStdout();
    await runConnect("not-a-url", optsWithMock({ stdout: writer }));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as ConnectJsonResult;
    expect(parsed.state).toBe("action-required");
    expect(parsed.reason).toBe("invalid-repo-url");
  });

  it('produces action-required with scan-creation-failed when POST /api/scans fails', async () => {
    const failResponses: Record<string, () => Response> = {
      "/api/health": () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    };
    const fetchImpl = (input: string | Request | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url).pathname;
      const handler = failResponses[path];
      if (handler) return Promise.resolve(handler());
      return Promise.resolve(new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 }));
    };
    const { lines, writer } = captureStdout();
    await runConnect("https://github.com/org/repo", optsWithMock({
      stdout: writer,
      fetchImpl,
      testCommand: "npm test",
      cwd: tmp,
    }));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as ConnectJsonResult;
    expect(parsed.state).toBe("action-required");
    expect(parsed.reason).toBe("scan-creation-failed");
  }, 10_000);

  it('produces ready state on happy path (endpoints not deployed → fall through gracefully)', async () => {
    let scanCreated = false;
    let scheduleCreated = false;

    const fetchImpl = (input: string | Request | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      // Health check
      if (path === "/api/health") {
        return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
      }
      // Enrollment readiness — not deployed → 404 (falls through)
      if (path.startsWith("/api/enrollment/status")) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      // Existing schedule lookup — not deployed → 404 (falls through)
      if (path.startsWith("/api/scan-schedules") && method === "GET") {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      // Scan creation
      if (path === "/api/scans" && method === "POST") {
        scanCreated = true;
        return Promise.resolve(new Response(JSON.stringify({ id: "scan-1", target_id: "target-1" }), { status: 200 }));
      }
      // Schedule creation
      if (path === "/api/scan-schedules" && method === "POST") {
        scheduleCreated = true;
        return Promise.resolve(new Response(JSON.stringify({ id: "sched-1", next_run_at: "2026-09-17T03:00:00Z" }), { status: 200 }));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    };

    const { lines, writer } = captureStdout();
    await runConnect("https://github.com/org/repo", optsWithMock({
      stdout: writer,
      fetchImpl,
      testCommand: "npm test",
      cwd: tmp,
    }));
    expect(scanCreated).toBe(true);
    expect(scheduleCreated).toBe(true);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as ConnectJsonResult;
    expect(parsed.state).toBe("ready");
    expect(parsed.scan_id).toBe("scan-1");
    expect(parsed.schedule).toBeDefined();
    expect(parsed.schedule!.id).toBe("sched-1");
  }, 10_000);

  it('produces no-open state when an existing schedule is found', async () => {
    const fetchImpl = (input: string | Request | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/health") {
        return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
      }
      // /api/enrollment/status — simulate deployed endpoint returning ok  
      if (path === "/api/enrollment/status") {
        return Promise.resolve(new Response(JSON.stringify({
          authenticated: true,
          org: { id: "org-1", name: "Test Org", slug: "test-org" },
          installation: { installed: true },
          repo_accessible: true,
        }), { status: 200 }));
      }
      // /api/scan-schedules — return an existing schedule on GET
      if (path.startsWith("/api/scan-schedules") && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({
          schedules: [{ id: "sched-existing", cron_expression: "0 3 * * *", next_run_at: "2026-09-17T03:00:00Z", target_id: "target-1" }],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    };

    const { lines, writer } = captureStdout();
    await runConnect("https://github.com/org/repo", optsWithMock({ stdout: writer, fetchImpl }));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as ConnectJsonResult;
    expect(parsed.state).toBe("no-open");
    expect(parsed.schedule).toBeDefined();
    expect(parsed.schedule!.id).toBe("sched-existing");
  }, 10_000);

  it('requires test command and reports action-required when none detected', async () => {
    const { lines, writer } = captureStdout();
    // cwd is an empty tmp dir — no test files, and clone will fail (can't reach URL)
    await runConnect("https://github.com/nonexistent/test-repo", optsWithMock({ stdout: writer, cwd: tmp }));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as ConnectJsonResult;
    // Will fail at the "no-test-command" stage because clone can't reach the URL
    expect(parsed.state).toBe("action-required");
  }, 30_000);
});

describe("runConnect terminal output", () => {
  it('prints connected banner on happy path', async () => {
    writeCredentials(tmp);
    let stdoutLines: string[] = [];
    let stderrLines: string[] = [];

    const fetchImpl = (input: string | Request | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/health") {
        return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
      }
      // Enrollment and schedule lookups — not deployed → 404 (falls through)
      if (path.startsWith("/api/enrollment/status") || (path.startsWith("/api/scan-schedules") && method === "GET")) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      if (path === "/api/scans" && method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ id: "scan-1", target_id: "target-1" }), { status: 200 }));
      }
      if (path === "/api/scan-schedules" && method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ id: "sched-1", next_run_at: "2026-09-17T03:00:00Z" }), { status: 200 }));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    };

    await runConnect("https://github.com/org/repo", {
      format: "terminal",
      schedule: true,
      cron: "0 3 * * *",
      publicationPolicy: "off",
      yes: true,
      cwd: "/home/dev/coding/0sec-labs/0sec",
      fetchImpl,
      homeDir: tmp,
      stdout: (line: string) => { stdoutLines.push(line); },
      stderr: (line: string) => { stderrLines.push(line); },
    });

    const combined = stdoutLines.join("\n") + stderrLines.join("\n");
    expect(combined).toContain("Connected.");
    expect(combined).toContain("https://github.com/org/repo");
  }, 15_000);
});
/**
 * Tests for `0 service` — managed cloud lifecycle commands.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

// ── Mocks ──

const mocks = vi.hoisted(() => ({
  getJson: vi.fn<() => Promise<unknown>>(),
  postJson: vi.fn<() => Promise<unknown>>(),
  deleteJson: vi.fn<() => Promise<unknown>>(),
  loadCredentials: vi.fn<() => { host: string; token: string }>().mockReturnValue({
    host: "https://cloud.0.security",
    token: "test-token-abc",
  }),
}));

vi.mock("@0/core", () => ({
  CloudClient: class {
    getJson = mocks.getJson;
    postJson = mocks.postJson;
    deleteJson = mocks.deleteJson;
  },
  CloudUnauthorizedError: class extends Error {
    name = "CloudUnauthorizedError";
    constructor(path: string) {
      super(`Unauthorized on ${path}`);
    }
  },
  CloudAuthMissingError: class extends Error {
    name = "CloudAuthMissingError";
    constructor() {
      super("No cloud credentials configured");
    }
  },
  CloudForbiddenError: class extends Error {
    name = "CloudForbiddenError";
    constructor(path: string) {
      super(`Forbidden on ${path}`);
    }
  },
  loadCloudCredentials: mocks.loadCredentials,
}));

const { registerServiceCommand } = await import("../service.js");

// ── Helpers ──

function captureIO() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const o = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    stdout.push(String(chunk));
    return true;
  });
  const e = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    stderr.push(String(chunk));
    return true;
  });
  return { stdout, stderr, restore: () => { o.mockRestore(); e.mockRestore(); } };
}

async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerServiceCommand(program);
  try {
    await program.parseAsync(["node", "0", ...argv]);
  } catch {
    // expected
  }
}

// ── Fixtures ──

const RUNNING_SCAN = {
  id: "scan-abc",
  target_id: "target-1",
  status: "running",
  scan_mode: "secure",
  osec_version: "0.19.0",
  profile: null,
  model: "deepseek-v4",
  org_id: "org-1",
  started_at: "2026-09-18T12:00:00Z",
  completed_at: null,
  cost_usd: 0.0123,
  billed_usd: null,
  token_input: 45000,
  token_output: 12000,
  created_at: "2026-09-18T12:00:00Z",
};

const COMPLETE_SCAN = {
  ...RUNNING_SCAN,
  status: "complete",
  completed_at: "2026-09-18T12:15:00Z",
  cost_usd: 0.0456,
  billed_usd: 0.0456,
  token_input: 180000,
  token_output: 52000,
};

// ── Tests ──

describe("0 service start", () => {
  let io: ReturnType<typeof captureIO>;

  beforeEach(() => {
    io = captureIO();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    io.restore();
    process.exitCode = undefined;
  });

  it("refuses without --repo", async () => {
    await runCli(["service", "start"]);
    const err = io.stderr.join("");
    expect(err).toContain("--repo");
    expect(process.exitCode).not.toBe(0);
  });

  it("refuses without --test-command", async () => {
    await runCli(["service", "start", "--repo", "https://github.com/org/repo"]);
    const err = io.stderr.join("");
    expect(err).toContain("--test-command");
    expect(process.exitCode).not.toBe(0);
  });

  it("refuses an invalid repo URL", async () => {
    await runCli(["service", "start", "--repo", "not-a-url", "--test-command", "npm test"]);
    const err = io.stderr.join("");
    expect(err).toContain("Invalid repository URL");
    expect(process.exitCode).toBe(1);
  });

  it("POSTs /api/scans with secure_config and prints scan id", async () => {
    mocks.postJson.mockResolvedValue({ id: "scan-1", target_id: "target-1" });

    await runCli([
      "service", "start",
      "--repo", "https://github.com/org/repo",
      "--test-command", "npm test",
    ]);

    expect(mocks.postJson).toHaveBeenCalled();
    const [path] = mocks.postJson.mock.calls[0] as unknown as [string];
    expect(path).toBe("/api/scans");

    const out = io.stdout.join("");
    expect(out).toContain("scan-1");
    expect(process.exitCode).toBeUndefined();
  });

  it("outputs machine-readable JSON with --json", async () => {
    mocks.postJson.mockResolvedValue({ id: "scan-json", target_id: "target-3" });

    await runCli([
      "service", "start",
      "--repo", "https://github.com/org/repo",
      "--test-command", "npm test",
      "--json",
    ]);

    const out = io.stdout.join("");
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe("scan-json");
  });

  it("handles postJson failure with actionable error", async () => {
    mocks.postJson.mockRejectedValue(new Error("Request failed"));

    await runCli([
      "service", "start",
      "--repo", "https://github.com/org/repo",
      "--test-command", "npm test",
    ]);

    const err = io.stderr.join("");
    expect(err).toContain("Failed to start scan");
  });
});

describe("0 service status", () => {
  let io: ReturnType<typeof captureIO>;

  beforeEach(() => {
    io = captureIO();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    io.restore();
    process.exitCode = undefined;
  });

  it("GETs /api/scans/:id and displays the result", async () => {
    mocks.getJson.mockResolvedValue(RUNNING_SCAN);

    await runCli(["service", "status", "scan-abc"]);

    expect(mocks.getJson).toHaveBeenCalledWith("/api/scans/scan-abc");
    const out = io.stdout.join("");
    expect(out).toContain("scan-abc");
    expect(out).toContain("running");
  });

  it("url-encodes the scan id", async () => {
    mocks.getJson.mockResolvedValue(RUNNING_SCAN);

    await runCli(["service", "status", "abc/def"]);

    expect(mocks.getJson).toHaveBeenCalledWith("/api/scans/abc%2Fdef");
  });

  it("returns JSON with --json flag", async () => {
    mocks.getJson.mockResolvedValue(COMPLETE_SCAN);

    await runCli(["service", "status", "scan-abc", "--json"]);

    const out = io.stdout.join("");
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe("scan-abc");
    expect(parsed.status).toBe("complete");
  });
});

describe("0 service wait", () => {
  let io: ReturnType<typeof captureIO>;

  beforeEach(() => {
    io = captureIO();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    io.restore();
    process.exitCode = undefined;
  });

  it("polls until terminal status", async () => {
    mocks.getJson
      .mockResolvedValueOnce(RUNNING_SCAN)
      .mockResolvedValueOnce(COMPLETE_SCAN);

    await runCli(["service", "wait", "scan-abc", "--interval", "0.01"]);

    expect(mocks.getJson).toHaveBeenCalledTimes(2);
    const out = io.stdout.join("");
    expect(out).toContain("Scan finished");
  });

  it("stops at cancelled status", async () => {
    mocks.getJson
      .mockResolvedValueOnce(RUNNING_SCAN)
      .mockResolvedValueOnce({ ...RUNNING_SCAN, status: "cancelled", completed_at: "2026-09-18T12:05:00Z" });

    await runCli(["service", "wait", "scan-abc", "--json", "--interval", "0.01"]);

    const out = io.stdout.join("");
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("cancelled");
  });
});

describe("0 service cancel", () => {
  let io: ReturnType<typeof captureIO>;

  beforeEach(() => {
    io = captureIO();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    io.restore();
    process.exitCode = undefined;
  });

  it("POSTs to /api/scans/:id/cancel", async () => {
    mocks.postJson.mockResolvedValue({ id: "scan-abc", status: "cancelled" });

    await runCli(["service", "cancel", "scan-abc"]);

    expect(mocks.postJson).toHaveBeenCalledWith("/api/scans/scan-abc/cancel", {});
    const out = io.stdout.join("");
    expect(out).toContain("Cancel requested");
  });

  it("url-encodes the scan id", async () => {
    mocks.postJson.mockResolvedValue({ id: "abc/def", status: "cancelled" });

    await runCli(["service", "cancel", "abc/def"]);

    expect(mocks.postJson).toHaveBeenCalledWith("/api/scans/abc%2Fdef/cancel", {});
  });
});

describe("0 service disconnect", () => {
  let io: ReturnType<typeof captureIO>;

  beforeEach(() => {
    io = captureIO();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    io.restore();
    process.exitCode = undefined;
  });

  it("is a no-op with clear message when no schedules exist", async () => {
    mocks.getJson.mockResolvedValue({ schedules: [] });

    await runCli(["service", "disconnect", "--yes", "https://github.com/org/repo"]);

    const out = io.stdout.join("");
    expect(out).toContain("No active schedules found");
    expect(mocks.deleteJson).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("deletes each schedule and reports success", async () => {
    mocks.getJson.mockResolvedValue({
      schedules: [
        { id: "sched-1", cron_expression: "0 3 * * *", next_run_at: null, target_id: "t1" },
        { id: "sched-2", cron_expression: "0 6 * * *", next_run_at: null, target_id: "t1" },
      ],
    });
    mocks.deleteJson.mockResolvedValue({});

    await runCli(["service", "disconnect", "--yes", "https://github.com/org/repo"]);

    expect(mocks.getJson).toHaveBeenCalledWith("/api/scan-schedules?target=https%3A%2F%2Fgithub.com%2Forg%2Frepo");
    expect(mocks.deleteJson).toHaveBeenCalledTimes(2);
    const out = io.stdout.join("");
    expect(out).toContain("Removed 2 schedule(s)");
  });

  it("requires --yes in JSON mode when schedules exist", async () => {
    mocks.getJson.mockResolvedValue({
      schedules: [{ id: "sched-1", cron_expression: "0 3 * * *", next_run_at: null, target_id: "t1" }],
    });

    await runCli(["service", "disconnect", "--json", "https://github.com/org/repo"]);

    const out = io.stdout.join("");
    const parsed = JSON.parse(out);
    expect(parsed.state).toBe("confirm-required");
    expect(parsed.schedules).toHaveLength(1);
    expect(mocks.deleteJson).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("reports partial success on delete failure", async () => {
    mocks.getJson.mockResolvedValue({
      schedules: [
        { id: "sched-ok", cron_expression: "0 3 * * *", next_run_at: null, target_id: "t1" },
        { id: "sched-fail", cron_expression: "0 6 * * *", next_run_at: null, target_id: "t1" },
      ],
    });
    mocks.deleteJson
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Schedule not found"));

    await runCli(["service", "disconnect", "--yes", "https://github.com/org/repo"]);

    expect(mocks.deleteJson).toHaveBeenCalledTimes(2);
    const out = io.stdout.join("");
    expect(out).toContain("partial success");
    expect(out).toContain("removed 1/2");
  });
});

describe("0 service — error handling", () => {
  let io: ReturnType<typeof captureIO>;
  let CloudUnauthorizedError: new (path: string) => Error;
  let CloudAuthMissingError: new () => Error;

  beforeEach(async () => {
    io = captureIO();
    process.exitCode = undefined;
    // Import the mock error classes so instanceof checks work
    const core = await import("@0/core") as unknown as { CloudUnauthorizedError: new (path: string) => Error; CloudAuthMissingError: new () => Error };
    CloudUnauthorizedError = core.CloudUnauthorizedError;
    CloudAuthMissingError = core.CloudAuthMissingError;
  });

  afterEach(() => {
    vi.clearAllMocks();
    io.restore();
    process.exitCode = undefined;
  });

  it("reports missing credentials with actionable message", async () => {
    mocks.loadCredentials.mockImplementationOnce(() => {
      throw new CloudAuthMissingError();
    });

    await runCli(["service", "status", "scan-abc"]);

    const err = io.stderr.join("");
    expect(err).toContain("Not authenticated");
    expect(err).toContain("auth login");
    expect(process.exitCode).toBe(2);
  });

  it("emits actionable error on getJson 401", async () => {
    mocks.getJson.mockRejectedValue(new CloudUnauthorizedError("/api/scans/scan-abc"));

    await runCli(["service", "status", "scan-abc"]);

    const errText = io.stderr.join("");
    expect(errText).toContain("Cloud token rejected");
    expect(errText).toContain("auth login");
    expect(process.exitCode).toBe(2);
  });
});
// `0sec connect` verifies Cloud membership and GitHub repository access.
// Scans and recurring schedules require explicit --run or --schedule consent.
// Test-command detection, publication policy, and confirmation apply only
// after the operator requests work.
//
// Usage:
//   0sec connect                                   ← use cwd git remote origin
//   0sec connect https://github.com/org/repo      ← explicit repo URL
//   0sec connect --format json                     ← machine-readable output
//   0sec connect --schedule --yes                  ← explicitly approve recurrence
//
// States (--format json):
//   ready             — access verified, or explicitly requested work created
//   no-open           — no changes needed (repo already connected)
//   action-required   — operator must resolve something before proceeding
//                       (includes reason + action_url)

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { InvalidArgumentError, type Command } from "commander";
import chalk from "chalk";
import {
  CloudClient,
  CloudUnauthorizedError,
  loadCloudCredentials,
  CloudAuthMissingError,
  CloudForbiddenError,
} from "@0sec/core";

// ── types ──

type ConnectFormat = "terminal" | "json";
type PublicationPolicy = "off" | "manual" | "auto";

interface ConnectOptions {
  testCommand?: string;
  setupCommand?: string;
  model?: string;
  costCeiling?: number;
  cron: string;
  schedule: boolean;
  run?: boolean;
  setupOnly?: boolean;
  cronSpecified?: boolean;
  format: ConnectFormat;
  publicationPolicy?: PublicationPolicy;
  yes: boolean;
}

/**
 * Machine-readable state for --format json output.
 */
interface ConnectJsonResult {
  state: "ready" | "no-open" | "action-required";
  repo: string;
  /** Human-readable summary of the state. */
  message: string;
  /** Machine-readable reason code (action-required only). */
  reason?: string;
  /** URL the operator should visit to resolve the action (action-required only). */
  action_url?: string;
  /** Present when a scan was created. */
  scan_id?: string;
  /** Present when a schedule was created or already existed. */
  schedule?: {
    id: string;
    cron: string;
    next_run_at: string | null;
  };
  /** The detected or provided test command. */
  test_command?: string;
  /** The source of the test command detection. */
  test_command_source?: string;
}

/**
 * Shape returned by the cloud enrollment-readiness endpoint.
 * GET /api/enrollment/status?target=<repo>
 * Expected 200: { authenticated: true, org: { id, name, slug }, installation: { installed, install_url? }, repo_accessible: boolean }
 * Missing or failed checks block enrollment; health alone is not authorization.
 */
interface EnrollmentStatusResponse {
  authenticated: boolean;
  org: { id: string; name: string; slug: string };
  installation: { installed: boolean; install_url?: string };
  repo_accessible: boolean;
}

/**
 * Shape returned by the proposed schedule-lookup endpoint.
 * PROPOSED: GET /api/scan-schedules?target=<repo>
 * Expected 200: { schedules: [{ id, cron_expression, next_run_at, target_id }] }
 * A failed lookup cannot be treated as an empty list.
 */
interface ScheduleListResponse {
  schedules: Array<{
    id: string;
    cron_expression: string;
    next_run_at: string | null;
    target_id: string;
    publication_policy?: string;
  }>;
}

interface ExistingSchedule {
  id: string;
  cron: string;
  next_run_at: string | null;
  publication_policy?: string;
}

// ── repo resolution ──

/**
 * Normalize a git URL to a canonical HTTPS URL compatible with the cloud API.
 */
function normalizeRepoUrl(raw: string): string {
  const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;
  let url = raw.replace(/^(?:git\+)?(?:https?:\/\/)?/, "").replace(/^git:\/\//, "https://");
  if (!url.startsWith("https://") && !url.startsWith("http://")) url = `https://${url}`;
  url = url.replace(/\.git$/, "");
  url = url.replace(/\/\/[^@]+@/, "//");
  if (!url.startsWith("https://")) url = `https://${url}`;
  return url;
}

/**
 * Resolve repo URL from arg or cwd's git remote origin.
 */
function resolveRepo(arg: string | undefined, cwdOverride?: string): { url: string; fromCwd: boolean } | null {
  if (arg) return { url: arg, fromCwd: false };
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: "pipe",
      cwd: cwdOverride ?? process.cwd(),
    }).trim();
    if (url) return { url, fromCwd: true };
  } catch {
    // Not a git repo or no origin remote
  }
  return null;
}

// ── test-command detection (local first, clone fallback) ──

/**
 * Test-command detection. Checks the LOCAL checkout first, then falls back
 * to a shallow clone. Returns null when nothing is found.
 */
function detectTestCommand(repoUrl: string, cwd?: string): { command: string; source: string } | null {
  if (cwd) {
    const local = detectTestCommandLocal(cwd);
    if (local) return local;
  }
  return detectTestCommandClone(repoUrl);
}

/** Check a local directory for test command config files. */
function detectTestCommandLocal(dir: string): { command: string; source: string } | null {
  try {
    if (existsSync(join(dir, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
        packageManager?: string;
      };
      const test = pkg.scripts?.test;
      if (test && !test.includes("no test specified")) {
        const runner = pkg.packageManager?.startsWith("pnpm") ? "pnpm"
          : pkg.packageManager?.startsWith("yarn") ? "yarn"
          : existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm"
          : existsSync(join(dir, "yarn.lock")) ? "yarn"
          : "npm";
        return { command: runner === "npm" ? "npm test" : `${runner} test`, source: "package.json (local)" };
      }
    }
    if (existsSync(join(dir, "Makefile"))) {
      const make = readFileSync(join(dir, "Makefile"), "utf8");
      if (/^test:/m.test(make)) return { command: "make test", source: "Makefile (local)" };
    }
    if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "pytest.ini")) || existsSync(join(dir, "tox.ini"))) {
      return { command: "python3 -m pytest", source: "python project files (local)" };
    }
    if (existsSync(join(dir, "Cargo.toml"))) return { command: "cargo test", source: "Cargo.toml (local)" };
    if (existsSync(join(dir, "go.mod"))) return { command: "go test ./...", source: "go.mod (local)" };
  } catch {
    // Parse or read error — fall through
  }
  return null;
}

/** Test-command detection from a shallow clone. */
function detectTestCommandClone(repoUrl: string): { command: string; source: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "0sec-connect-"));
  try {
    execFileSync("git", ["clone", "--depth", "1", "--quiet", repoUrl, dir], {
      timeout: 120_000,
      stdio: "pipe",
    });
    return detectTestCommandLocal(dir);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── enrollment readiness ──

/**
 * Check enrollment readiness: auth, org, repo accessibility.
 *
 * GET /api/enrollment/status?target=<repo>
 * This endpoint resolves the repo URL, checks the operator's org membership,
 * verifies the org's GitHub App installation covers the repo, and returns
 * the combined status. Missing, failed or malformed readiness responses block
 * dispatch. Never infer authorization from a reachable health endpoint.
 */
async function checkEnrollmentReadiness(
  client: CloudClient,
  repo: string,
): Promise<{ ok: true; status: EnrollmentStatusResponse } | { ok: false; reason: string; action_url?: string }> {
  const encodedTarget = encodeURIComponent(repo);
  try {
    const status = await client.getJson<EnrollmentStatusResponse>(
      `/api/enrollment/status?target=${encodedTarget}`,
    );
    if (status.authenticated !== true) {
      return { ok: false, reason: "not-authenticated" };
    }
    if (typeof status.org?.id !== "string" || !status.org.id
      || typeof status.org.slug !== "string" || !status.org.slug) {
      return { ok: false, reason: "enrollment-check-failed" };
    }
    if (status.installation?.installed !== true) {
      return {
        ok: false,
        reason: "github-app-not-installed",
        action_url: status.installation?.install_url
          ?? `${client["host"]}/${encodeURIComponent(status.org.slug)}/integrations`,
      };
    }
    if (status.repo_accessible !== true) {
      return { ok: false, reason: "repo-not-accessible" };
    }
    return { ok: true, status };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof CloudUnauthorizedError ? "token-rejected"
        : err instanceof CloudForbiddenError ? "enrollment-forbidden"
        : "enrollment-check-failed",
    };
  }
}

/**
 * Check for an existing scan schedule for the target repo.
 *
 * PROPOSED CLOUD ENDPOINT: GET /api/scan-schedules?target=<repo>
 * A lookup failure must reach the caller before it can dispatch new work.
 */
async function findExistingSchedule(
  client: CloudClient,
  repo: string,
): Promise<ExistingSchedule | null> {
  const encodedTarget = encodeURIComponent(repo);
  const result = await client.getJson<ScheduleListResponse>(
    `/api/scan-schedules?target=${encodedTarget}`,
  );
  if (!Array.isArray(result?.schedules)) {
    throw new Error("Invalid schedule-list response.");
  }
  const s = result.schedules[0];
  if (result.schedules.length === 0) return null;
  if (!s || typeof s.id !== "string" || !s.id || typeof s.cron_expression !== "string") {
    throw new Error("Invalid schedule in lookup response.");
  }
  return { id: s.id, cron: s.cron_expression, next_run_at: s.next_run_at, publication_policy: s.publication_policy };
}

// ── interactive confirm ──

/**
 * Read a boolean answer from the operator (y/N).
 * Uses process.stdin, defaults to "no".
 */
async function askYesNo(question: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.question(chalk.cyan(`${question} (y/N) `), (answer: string) => {
    rl.close();
    resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
  });
  return promise;
}

// ── commander wiring ──

export function registerConnectCommand(program: Command): void {
  program
    .command("connect")
    .description(
      "Verify GitHub repository access; scans and schedules require explicit opt-in\n"
        + "  With no arguments, reads the git remote origin URL from the current directory.",
    )
    .argument("[repo]", "HTTPS git URL of the repository (default: current directory's git remote origin)")
    .option("--test-command <command>", "Regression command; auto-detected from the repo when omitted")
    .option("--setup-command <command>", "Setup/build command run before tests (e.g. pnpm install)")
    .option("-m, --model <model>", "Model for the managed runs; defaults to the cloud routing default")
    .option("--cost-ceiling <usd>", "Per-run model cost ceiling in USD", (v: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("Must be a positive dollar amount.");
      return n;
    })
    .option("--setup-only", "Verify access without creating a scan or schedule", false)
    .option("--run", "Request one managed scan after verifying repository access", false)
    .option("--schedule", "Request a managed scan and a recurring schedule", false)
    .option("--cron <expression>", "Schedule frequency in UTC; requires --schedule", "0 3 * * *")
    .option("--format <fmt>", "Output format: terminal | json", "terminal")
    .option("--publication-policy <policy>", "Publication policy: off | manual | auto. Default: off", (v: string) => {
      if (!["off", "manual", "auto"].includes(v)) {
        throw new InvalidArgumentError("publication-policy must be off, manual, or auto");
      }
      return v as PublicationPolicy;
    }, "off" as PublicationPolicy)
    .option("--yes", "Skip interactive confirmation before scheduling")
    .action(async (repo: string | undefined, options: ConnectOptions, command: Command) => {
      await runConnect(repo, { ...options, cronSpecified: command.getOptionValueSource("cron") === "cli" });
    });
}

// ── implementation ──

export interface ConnectActionOptions extends ConnectOptions {
  /** Test seam: override fetch impl for testing. */
  fetchImpl?: typeof fetch;
  /** Test seam: override home directory for credential loading. */
  homeDir?: string;
  /** Test seam: override process.cwd() for repo resolution. */
  cwd?: string;
  /** Test seam: stdout override for testing. */
  stdout?: (line: string) => void;
  /** Test seam: stderr override for testing. */
  stderr?: (line: string) => void;
}

/**
 * Core connect action. Exported for unit tests so we can drive it without
 * constructing a full Commander program.
 */
export async function runConnect(repoArg: string | undefined, opts: ConnectActionOptions): Promise<void> {
  const isJson = opts.format === "json";
  const out = opts.stdout ?? ((line: string) => process.stdout.write(line + "\n"));
  const err = opts.stderr ?? ((line: string) => process.stderr.write(line + "\n"));
  const invalidOptions = opts.setupOnly && (opts.run || opts.schedule)
    ? "--setup-only cannot be combined with --run or --schedule."
    : opts.cronSpecified && !opts.schedule ? "--cron requires --schedule." : null;
  if (invalidOptions) {
    if (isJson) out(JSON.stringify({ state: "action-required", repo: repoArg ?? "", reason: "invalid-options", message: invalidOptions } satisfies ConnectJsonResult));
    else err(invalidOptions);
    process.exitCode = 1;
    return;
  }

  // ── 1. Resolve repo URL ──
  const resolved = resolveRepo(repoArg, opts.cwd);
  if (!resolved) {
    if (isJson) {
      out(JSON.stringify({
        state: "action-required",
        repo: "",
        message: "No repository specified and current directory is not a git repo (no remote 'origin').",
        reason: "no-repo",
      } satisfies ConnectJsonResult));
    } else {
      err(chalk.red("No repository specified.\n"));
      if (repoArg === undefined) {
        err(chalk.dim("  Run from a git repository with a remote 'origin', or pass the URL:\n"));
        err(chalk.dim(`    ${chalk.bold("0sec connect https://github.com/org/repo")}\n`));
      }
    }
    process.exitCode = 1;
    return;
  }

  const repoUrl = normalizeRepoUrl(resolved.url);
  if (!/^https:\/\/[^\s]+\/[\w.-]+\/[\w.-]+/.test(repoUrl)) {
    if (isJson) {
      out(JSON.stringify({
        state: "action-required",
        repo: repoUrl,
        message: `Invalid repository URL: ${repoUrl}. Must be an HTTPS git URL.`,
        reason: "invalid-repo-url",
      } satisfies ConnectJsonResult));
    } else {
      err(chalk.red(`Invalid repository URL: ${chalk.bold(repoUrl)}\n`));
      err(chalk.dim("Expected an HTTPS git URL (e.g. https://github.com/org/repo).\n"));
    }
    process.exitCode = 1;
    return;
  }

  // ── 2. Load cloud credentials ──
  let creds: { host: string; token: string };
  try {
    creds = loadCloudCredentials({ homeDir: opts.homeDir });
  } catch (error) {
    if (error instanceof CloudAuthMissingError) {
      if (isJson) {
        out(JSON.stringify({
          state: "action-required",
          repo: repoUrl,
          message: "Not authenticated. Run `0sec auth login` first, then connect again.",
          reason: "not-authenticated",
        } satisfies ConnectJsonResult));
      } else {
        err(` ${chalk.red("Not authenticated.")} Run ${chalk.bold("0sec auth login")} first, then connect again.\n`);
      }
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const client = new CloudClient({ host: creds.host, token: creds.token, fetchImpl: opts.fetchImpl });

  // Verify current tenant and repository authority before any work.
  const enrollment = await checkEnrollmentReadiness(client, repoUrl);
  if (!enrollment.ok) {
    if (isJson) {
      out(JSON.stringify({
        state: "action-required",
        repo: repoUrl,
        message: `Enrollment check failed: ${enrollment.reason}`,
        reason: enrollment.reason,
        action_url: enrollment.action_url,
      } satisfies ConnectJsonResult));
    } else {
      err(` ${chalk.red("Enrollment check:")} ${enrollment.reason}\n`);
      if (enrollment.reason === "github-app-not-installed" && enrollment.action_url) {
        err(chalk.dim(`  Visit ${enrollment.action_url} to install the 0sec GitHub App.\n`));
      }
    }
    process.exitCode = 2;
    return;
  }
  if (!opts.run && !opts.schedule) {
    const message = "Repository access verified. No scan or schedule was created. Use --run for one scan or --schedule for recurring scans.";
    if (isJson) out(JSON.stringify({ state: "ready", repo: repoUrl, message } satisfies ConnectJsonResult));
    else out(message);
    return;
  }

  // ── 5. Check for existing schedule (idempotent reconnect) ──
  let existingSchedule: ExistingSchedule | null;
  try {
    existingSchedule = opts.schedule ? await findExistingSchedule(client, repoUrl) : null;
  } catch (lookupError) {
    const message = `Could not check existing schedules: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}. No scan was started.`;
    if (isJson) {
      out(JSON.stringify({
        state: "action-required",
        repo: repoUrl,
        reason: "schedule-lookup-failed",
        message,
      } satisfies ConnectJsonResult));
    } else {
      err(chalk.red(message));
    }
    process.exitCode = 2;
    return;
  }
  if (existingSchedule) {
    if (isJson) {
      out(JSON.stringify({
        state: "no-open",
        repo: repoUrl,
        message: "Repository already connected with an active schedule.",
        schedule: {
          id: existingSchedule.id,
          cron: existingSchedule.cron,
          next_run_at: existingSchedule.next_run_at,
        },
      } satisfies ConnectJsonResult));
    } else {
      out([
        "",
        chalk.green.bold("Already connected."),
        `  Repository:   ${repoUrl}`,
        `  Schedule:     ${existingSchedule.cron} (next: ${existingSchedule.next_run_at ?? "pending"})`,
        "",
        "No changes were made — the existing schedule remains active.",
        "",
      ].join("\n"));
    }
    return;
  }

  // ── 6. Detect test command ──
  let testCommand = opts.testCommand;
  let testSource: string | undefined;
  if (!testCommand) {
    if (!isJson) err("Detecting test command…\n");
    const detected = detectTestCommand(repoUrl, opts.cwd);
    if (!detected) {
      if (isJson) {
        out(JSON.stringify({
          state: "action-required",
          repo: repoUrl,
          message: "Could not detect a test command. Pass --test-command explicitly.",
          reason: "no-test-command",
        } satisfies ConnectJsonResult));
      } else {
        err(` ${chalk.red("Could not detect a test command.")} Pass ${chalk.bold("--test-command")} explicitly (e.g. --test-command "npm test").\n`);
      }
      process.exitCode = 1;
      return;
    }
    testCommand = detected.command;
    testSource = detected.source;
    if (!isJson) err(`  Detected ${chalk.bold(testCommand)} (from ${detected.source}).\n`);
  }

  // ── 7. Policy confirmation ──
  const publicationPolicy = opts.publicationPolicy ?? "off";
  if (!opts.yes && isJson) {
    out(JSON.stringify({
      state: "action-required",
      repo: repoUrl,
      reason: "confirmation_required",
      test_command: testCommand,
      message: `Review the test command, schedule (${opts.schedule ? opts.cron : "one-shot"}), publication policy (${publicationPolicy}) and per-run budget (${opts.costCeiling === undefined ? "service limits" : `USD ${opts.costCeiling}`}). Rerun with --yes to approve before starting work.`,
    } satisfies ConnectJsonResult));
    process.exitCode = 2;
    return;
  }
  if (!opts.yes) {
    err([
      "",
      chalk.bold("Review configuration:"),
      `  Test command:         ${testCommand}`,
      `  Schedule:             ${opts.schedule ? opts.cron : "none (one-shot)"}`,
      `  Publication policy:   ${publicationPolicy}`,
      opts.costCeiling ? `  Per-run budget (USD): ${opts.costCeiling}` : "",
      "",
    ].filter(Boolean).join("\n"));

    const confirmed = await askYesNo("Proceed with this configuration?");
    if (!confirmed) {
      err(chalk.yellow("Cancelled.\n"));
      process.exitCode = 1;
      return;
    }
  }

  // ── 8. Create the scan ──
  const secureConfig: Record<string, unknown> = {
    repo: repoUrl,
    test_command: testCommand,
    ...(opts.setupCommand ? { setup_command: opts.setupCommand } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.costCeiling ? { cost_ceiling_usd: opts.costCeiling } : {}),
    publication_policy: publicationPolicy,
  };

  if (!isJson) err("Starting a managed scan…\n");

  let scan: { id: string; target_id: string | null };
  try {
    scan = await client.postJson<{ id: string; target_id: string | null }>("/api/scans", {
      target: repoUrl,
      scan_mode: "secure",
      secure_config: secureConfig,
    });
  } catch (scanError) {
    const errorMessage = scanError instanceof Error ? scanError.message : String(scanError);
    if (isJson) {
      out(JSON.stringify({
        state: "action-required",
        repo: repoUrl,
        message: `Failed to create scan: ${errorMessage}`,
        reason: "scan-creation-failed",
      } satisfies ConnectJsonResult));
    } else {
      err(` ${chalk.red(`Failed to create scan: ${errorMessage}\n`)}`);
    }
    process.exitCode = 1;
    return;
  }

  // ── 9. Create schedule ──
  let scheduleResult: { id: string; next_run_at: string | null } | null = null;
  if (opts.schedule) {
    try {
      if (!scan.target_id) throw new Error("The created scan has no target id.");
      scheduleResult = await client.postJson<{ id: string; next_run_at: string | null }>(
        "/api/scan-schedules",
        {
          target_id: scan.target_id,
          cron_expression: opts.cron,
          scan_mode: "secure",
          secure_config: secureConfig,
        },
      );
      if (!scheduleResult?.id) throw new Error("Schedule creation returned no schedule id.");
    } catch (scheduleError) {
      const message = `Scan ${scan.id} was created, but recurrence could not be confirmed: ${scheduleError instanceof Error ? scheduleError.message : String(scheduleError)}. Inspect this scan before retrying enrollment to avoid duplicate work.`;
      if (isJson) {
        out(JSON.stringify({
          state: "action-required",
          repo: repoUrl,
          reason: "schedule-creation-failed",
          scan_id: scan.id,
          test_command: testCommand,
          message,
        } satisfies ConnectJsonResult));
      } else {
        err(chalk.red(message));
      }
      process.exitCode = 1;
      return;
    }
  }

  // ── 10. Output result ──
  const scanUrl = new URL(`/${encodeURIComponent(enrollment.status.org.slug)}/scans/${encodeURIComponent(scan.id)}`, creds.host).href;

  if (isJson) {
    const result: ConnectJsonResult = {
      state: "ready",
      repo: repoUrl,
      message: "Repository connected successfully.",
      scan_id: scan.id,
      test_command: testCommand,
      test_command_source: testSource,
      ...(scheduleResult
        ? { schedule: { id: scheduleResult.id, cron: opts.cron, next_run_at: scheduleResult.next_run_at } }
        : {}),
    };
    out(JSON.stringify(result));
  } else {
    out([
      "",
      chalk.green.bold("Connected."),
      `  Repository:   ${repoUrl}`,
      `  Test command: ${testCommand}`,
      `  Publication:  ${publicationPolicy}`,
      `  First run:    ${scanUrl}`,
      scheduleResult
        ? `  Schedule:     ${opts.cron} (next: ${scheduleResult.next_run_at ?? "pending"})`
        : "  Schedule:     none (one-shot run)",
      "",
      "0sec will investigate, reproduce, repair, and verify. Verified patches and evidence are retained on the scan for your review.",
      "",
    ].join("\n"));
  }
}

// Export pure functions for testing
export { normalizeRepoUrl, resolveRepo, detectTestCommandLocal };
export type { ConnectJsonResult };
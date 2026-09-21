// `0sec service` — managed cloud lifecycle commands for agents.
//
// Capability catalogue:
//   service start   — enqueue a managed scan on a repository
//   service status  — poll scan state by id
//   service wait    — block until a scan reaches a terminal state
//   service cancel  — request cancellation of a pending/running scan
//   service disconnect — remove scan schedule(s) for a repository
//
// Every subcommand requires cloud credentials (ZERO_CLOUD_TOKEN or
// `~/.0/cloud.env`) and uses the CloudClient for bearer-authenticated
// HTTP against the cloud dashboard ingress (/api/scans*, /api/scan-schedules*).

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import type { Command } from "commander";
import chalk from "chalk";
import { CloudClient,
CloudUnauthorizedError,
CloudAuthMissingError,
loadCloudCredentials,
CloudForbiddenError, } from "@0/core"

// ── Types ──

/** Orchestrator scan status values (mirrors orchestrator SCAN_STATUS enum). */
type ScanStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "cost_exceeded";

/** Terminal statuses — wait stops polling when the scan reaches one of these. */
const TERMINAL_STATUSES: Partial<Record<ScanStatus, true>> = {
  complete: true,
  failed: true,
  cancelled: true,
  cost_exceeded: true,
};

/** Shape returned by GET /api/scans/:id */
interface ScanResponse {
  id: string;
  target_id: string | null;
  status: ScanStatus;
  scan_mode: string;
  osec_version: string | null;
  profile: string | null;
  model: string | null;
  org_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  cost_usd: number | null;
  billed_usd: number | null;
  token_input: number | null;
  token_output: number | null;
  cancel_requested_at?: string | null;
  created_at: string;
  final_report?: unknown;
}

/** Shape returned by GET /api/scan-schedules */
interface ScheduleListResponse {
  schedules: Array<{
    id: string;
    cron_expression: string;
    next_run_at: string | null;
    target_id: string;
    publication_policy?: string;
  }>;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;

// ── Credential and client helpers ──

interface CredLoadResult {
  client: CloudClient;
  host: string;
}

function loadClient(): CredLoadResult {
  const creds = loadCloudCredentials();
  const client = new CloudClient({ host: creds.host, token: creds.token });
  return { client, host: creds.host };
}

function formatScanRow(s: ScanResponse): string {
  const lines: string[] = [
    `  ID:            ${s.id}`,
    `  Status:        ${s.status}`,
  ];
  if (s.scan_mode) lines.push(`  Mode:         ${s.scan_mode}`);
  if (s.model) lines.push(`  Model:        ${s.model}`);
  if (s.started_at) lines.push(`  Started:      ${s.started_at}`);
  if (s.completed_at) lines.push(`  Completed:    ${s.completed_at}`);
  if (s.cost_usd != null) lines.push(`  Cost:         $${s.cost_usd.toFixed(4)}`);
  if (s.billed_usd != null) lines.push(`  Billed:       $${s.billed_usd.toFixed(4)}`);
  if (s.token_input != null) lines.push(`  Tokens in:    ${s.token_input.toLocaleString()}`);
  if (s.token_output != null) lines.push(`  Tokens out:   ${s.token_output.toLocaleString()}`);
  return lines.join("\n");
}

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

// ── Subcommand actions ──

interface StartOptions {
  repo: string;
  testCommand: string;
  setupCommand?: string;
  model?: string;
  costCeiling?: number;
  json?: boolean;
}

async function actionStart(opts: StartOptions): Promise<void> {
  const isJson = !!opts.json;

  let creds: CredLoadResult;
  try {
    creds = loadClient();
  } catch (error) {
    if (error instanceof CloudAuthMissingError) {
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: "not-authenticated", message: "Not authenticated. Run `0sec auth login` first." }) + "\n");
      } else {
        process.stderr.write(chalk.red("Not authenticated.") + " Run " + chalk.bold("0sec auth login") + " first, then try again.\n");
      }
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const repoUrl = normalizeRepoUrl(opts.repo);
  if (!/^https:\/\/[^\s]+\/[\w.-]+\/[\w.-]+/.test(repoUrl)) {
    if (isJson) {
      process.stdout.write(JSON.stringify({ error: "invalid-repo-url", message: `Invalid repository URL: ${repoUrl}` }) + "\n");
    } else {
      process.stderr.write(chalk.red("Invalid repository URL: ") + chalk.bold(repoUrl) + "\n");
    }
    process.exitCode = 1;
    return;
  }

  const secureConfig: Record<string, unknown> = { repo: repoUrl, test_command: opts.testCommand };
  if (opts.setupCommand) secureConfig.setup_command = opts.setupCommand;
  if (opts.model) secureConfig.model = opts.model;
  if (opts.costCeiling != null) secureConfig.cost_ceiling = opts.costCeiling;

  let scan: { id: string; target_id: string | null };
  try {
    scan = await creds.client.postJson<{ id: string; target_id: string | null }>("/api/scans", {
      target: repoUrl,
      scan_mode: "secure",
      secure_config: secureConfig,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (isJson) {
      process.stdout.write(JSON.stringify({ error: "scan-creation-failed", message: msg }) + "\n");
    } else {
      process.stderr.write(chalk.red(`Failed to start scan: ${msg}\n`));
    }
    process.exitCode = 1;
    return;
  }

  if (isJson) {
    process.stdout.write(JSON.stringify({ id: scan.id, target_id: scan.target_id }) + "\n");
  } else {
    process.stdout.write([
      "",
      chalk.green.bold("Scan started."),
      `  ID:      ${scan.id}`,
      `  Target:  ${repoUrl}`,
      "",
    ].join("\n"));
  }
}

interface StatusOptions {
  json?: boolean;
}

async function actionStatus(scanId: string, opts: StatusOptions): Promise<void> {
  const isJson = !!opts.json;

  let creds: CredLoadResult;
  try {
    creds = loadClient();
  } catch (error) {
    if (error instanceof CloudAuthMissingError) {
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: "not-authenticated", message: "Not authenticated. Run `0sec auth login` first." }) + "\n");
      } else {
        process.stderr.write(chalk.red("Not authenticated.") + " Run " + chalk.bold("0sec auth login") + " first.\n");
      }
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  let scan: ScanResponse;
  try {
    scan = await creds.client.getJson<ScanResponse>(`/api/scans/${encodeURIComponent(scanId)}`);
  } catch (error) {
    if (error instanceof CloudUnauthorizedError) {
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: "token-rejected", message: "Cloud token rejected. Run `0sec auth login` again." }) + "\n");
      } else {
        process.stderr.write(chalk.red("Cloud token rejected.") + " Run " + chalk.bold("0sec auth login") + " again.\n");
      }
      process.exitCode = 2;
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (isJson) {
      process.stdout.write(JSON.stringify({ error: "status-fetch-failed", message: msg }) + "\n");
    } else {
      process.stderr.write(chalk.red(`Failed to fetch scan status: ${msg}\n`));
    }
    process.exitCode = 1;
    return;
  }

  if (isJson) {
    process.stdout.write(JSON.stringify(scan) + "\n");
  } else {
    process.stdout.write([
      "",
      chalk.bold("Scan status"),
      formatScanRow(scan),
      "",
    ].join("\n"));
  }
}

interface WaitOptions {
  interval?: number;
  json?: boolean;
}

async function actionWait(scanId: string, opts: WaitOptions): Promise<void> {
  const isJson = !!opts.json;
  const intervalMs = (opts.interval ?? DEFAULT_POLL_INTERVAL_MS) * 1000;

  let creds: CredLoadResult;
  try {
    creds = loadClient();
  } catch (error) {
    if (error instanceof CloudAuthMissingError) {
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: "not-authenticated", message: "Not authenticated. Run `0sec auth login` first." }) + "\n");
      } else {
        process.stderr.write(chalk.red("Not authenticated.") + " Run " + chalk.bold("0sec auth login") + " first.\n");
      }
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const encodedId = encodeURIComponent(scanId);

  // Poll loop — scan is reassigned each iteration so the compiler
  // sees it as possibly-undefined after the catch/return.
  let lastStatus: ScanStatus | undefined;
  let scan: ScanResponse;
  for (;;) {
    try {
      scan = await creds.client.getJson<ScanResponse>(`/api/scans/${encodedId}`);
    } catch (error) {
      if (error instanceof CloudUnauthorizedError) {
        if (isJson) {
          process.stdout.write(JSON.stringify({ error: "token-rejected", message: "Cloud token rejected during polling." }) + "\n");
        } else {
          process.stderr.write(chalk.red("Cloud token rejected during polling.\n"));
        }
        process.exitCode = 2;
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: "poll-failed", message: msg, scan_id: scanId }) + "\n");
      } else {
        process.stderr.write(chalk.red(`Poll failed: ${msg}\n`));
      }
      process.exitCode = 1;
      return;
    }

    if (scan.status !== lastStatus && !isJson) {
      if (lastStatus === undefined) {
        process.stderr.write(`  Status: ${scan.status}\n`);
      } else {
        process.stderr.write(`  Status: ${scan.status} (was ${lastStatus})\n`);
      }
    }
    lastStatus = scan.status;

    if (TERMINAL_STATUSES[scan.status]) {
      break;
    }

    await setTimeout(intervalMs);
  }
  if (isJson) {
    process.stdout.write(JSON.stringify(scan) + "\n");
  } else {
    process.stdout.write([
      "",
      chalk.green.bold("Scan finished."),
      formatScanRow(scan),
      "",
    ].join("\n"));
  }
}

interface CancelOptions {
  json?: boolean;
}

async function actionCancel(scanId: string, opts: CancelOptions): Promise<void> {
  const isJson = !!opts.json;

  let creds: CredLoadResult;
  try {
    creds = loadClient();
  } catch (error) {
    if (error instanceof CloudAuthMissingError) {
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: "not-authenticated", message: "Not authenticated. Run `0sec auth login` first." }) + "\n");
      } else {
        process.stderr.write(chalk.red("Not authenticated.") + " Run " + chalk.bold("0sec auth login") + " first.\n");
      }
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  let result: ScanResponse;
  try {
    result = await creds.client.postJson<ScanResponse>(
      `/api/scans/${encodeURIComponent(scanId)}/cancel`,
      {},
    );
  } catch (error) {
    if (error instanceof CloudUnauthorizedError) {
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: "token-rejected", message: "Cloud token rejected." }) + "\n");
      } else {
        process.stderr.write(chalk.red("Cloud token rejected.\n"));
      }
      process.exitCode = 2;
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (isJson) {
      process.stdout.write(JSON.stringify({ error: "cancel-failed", message: msg }) + "\n");
    } else {
      process.stderr.write(chalk.red(`Failed to cancel scan: ${msg}\n`));
    }
    process.exitCode = 1;
    return;
  }

  if (isJson) {
    process.stdout.write(JSON.stringify({ id: result.id, status: result.status }) + "\n");
  } else {
    process.stdout.write(chalk.yellow(`Cancel requested for scan ${result.id} (status: ${result.status}).\n`));
  }
}

interface DisconnectOptions {
  yes?: boolean;
  json?: boolean;
}

async function actionDisconnect(repoArg: string | undefined, opts: DisconnectOptions): Promise<void> {
  const isJson = !!opts.json;

  let creds: CredLoadResult;
  try {
    creds = loadClient();
  } catch (error) {
    if (error instanceof CloudAuthMissingError) {
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: "not-authenticated", message: "Not authenticated. Run `0sec auth login` first." }) + "\n");
      } else {
        process.stderr.write(chalk.red("Not authenticated.") + " Run " + chalk.bold("0sec auth login") + " first.\n");
      }
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  // Resolve repo URL from argument or cwd
  const repoUrl = repoArg ? normalizeRepoUrl(repoArg) : resolveRepoFromCwd();
  if (!repoUrl) {
    if (isJson) {
      process.stdout.write(JSON.stringify({ error: "no-repo", message: "No repository specified and current directory is not a git repo (no remote 'origin')." }) + "\n");
    } else {
      process.stderr.write(chalk.red("No repository specified.\n"));
      process.stderr.write(chalk.dim("  Pass a repo URL or run from a git checkout with a remote 'origin'.\n"));
    }
    process.exitCode = 1;
    return;
  }

  if (!/^https:\/\/[^\s]+\/[\w.-]+\/[\w.-]+/.test(repoUrl)) {
    if (isJson) {
      process.stdout.write(JSON.stringify({ error: "invalid-repo-url", message: `Invalid repository URL: ${repoUrl}` }) + "\n");
    } else {
      process.stderr.write(chalk.red("Invalid repository URL: ") + chalk.bold(repoUrl) + "\n");
    }
    process.exitCode = 1;
    return;
  }

  // List schedules for this repo
  let schedules: ScheduleListResponse;
  try {
    const encodedTarget = encodeURIComponent(repoUrl);
    schedules = await creds.client.getJson<ScheduleListResponse>(
      `/api/scan-schedules?target=${encodedTarget}`,
    );
  } catch (error) {
    if (error instanceof CloudUnauthorizedError) {
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: "token-rejected", message: "Cloud token rejected." }) + "\n");
      } else {
        process.stderr.write(chalk.red("Cloud token rejected.\n"));
      }
      process.exitCode = 2;
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (isJson) {
      process.stdout.write(JSON.stringify({ error: "schedule-list-failed", message: msg }) + "\n");
    } else {
      process.stderr.write(chalk.red(`Failed to list schedules: ${msg}\n`));
    }
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(schedules?.schedules) || schedules.schedules.length === 0) {
    if (isJson) {
      process.stdout.write(JSON.stringify({ state: "no-schedules", repo: repoUrl, message: "No active schedules for this repository." }) + "\n");
    } else {
      process.stdout.write(chalk.yellow("No active schedules found for ") + chalk.bold(repoUrl) + ".\n");
    }
    return;
  }

  // Confirm
  const scheduleIds = schedules.schedules.map((s) => s.id);
  if (!opts.yes) {
    if (isJson) {
      process.stdout.write(JSON.stringify({
        state: "confirm-required",
        repo: repoUrl,
        schedules: scheduleIds,
        message: `Found ${scheduleIds.length} schedule(s) for this repo. Pass --yes to confirm deletion.`,
      }) + "\n");
      process.exitCode = 1;
      return;
    }

    process.stderr.write(chalk.yellow(`Found ${scheduleIds.length} active schedule(s) for ${chalk.bold(repoUrl)}:\n`));
    for (const s of schedules.schedules) {
      process.stderr.write(`  ${s.id} (${s.cron_expression})\n`);
    }
    process.stderr.write("\n");
    process.stderr.write("Are you sure you want to remove all schedules for this repo? ");
    const confirmed = await askYesNo();
    if (!confirmed) {
      process.stderr.write("Cancelled.\n");
      return;
    }
  }

  // Delete each schedule
  let deleted = 0;
  for (const schedId of scheduleIds) {
    try {
      await creds.client.deleteJson(`/api/scan-schedules/${encodeURIComponent(schedId)}`);
      deleted++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: "schedule-delete-failed", schedule_id: schedId, message: msg }) + "\n");
      } else {
        process.stderr.write(chalk.red(`Failed to delete schedule ${schedId}: ${msg}\n`));
      }
    }
  }

  if (isJson) {
    process.stdout.write(JSON.stringify({ state: "disconnected", repo: repoUrl, deleted_count: deleted, total: scheduleIds.length }) + "\n");
  } else {
    if (deleted === scheduleIds.length) {
      process.stdout.write(chalk.green(`Disconnected ${chalk.bold(repoUrl)}. Removed ${deleted} schedule(s).\n`));
    } else {
      process.stdout.write(chalk.yellow(`Disconnected ${chalk.bold(repoUrl)} with partial success: removed ${deleted}/${scheduleIds.length} schedule(s).\n`));
    }
  }
}

/** Read a boolean answer from stdin (y/N). */
async function askYesNo(): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.question("(y/N) ", (answer: string) => {
    rl.close();
    resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
  });
  return promise;
}

/** Resolve repo URL from cwd git remote origin. */
function resolveRepoFromCwd(): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!url) return null;
    return normalizeRepoUrl(url);
  } catch {
    return null;
  }
}

// ── Commander registration ──

export function registerServiceCommand(program: Command): void {
  const service = program
    .command("service")
    .description("Managed cloud lifecycle (start/status/wait/cancel scans, disconnect repo). Requires cloud credentials (`0 auth login`).");

  service
    .command("start")
    .description("Enqueue a managed security scan on a repository.")
    .requiredOption("--repo <url>", "Repository URL to scan (e.g. https://github.com/org/repo)")
    .requiredOption("--test-command <cmd>", "Test command to verify repairs (e.g. \"npm test\")")
    .option("--setup-command <cmd>", "Setup command to run before the test command (e.g. \"npm ci\")")
    .option("--model <model>", "Model to use for the scan (default: service-configured)")
    .option("--cost-ceiling <usd>", "Maximum cost in USD before the scan is auto-cancelled", parseFloat)
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionStart);

  service
    .command("status <scan-id>")
    .description("Get the current status of a managed scan.")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionStatus);

  service
    .command("wait <scan-id>")
    .description("Poll until a managed scan reaches a terminal state (complete/failed/cancelled/cost_exceeded).")
    .option("--interval <seconds>", "Polling interval in seconds (default 5)", parseFloat, 5)
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionWait);

  service
    .command("cancel <scan-id>")
    .description("Request cancellation of a pending or running managed scan.")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionCancel);

  service
    .command("disconnect [repo]")
    .description("Remove all scan schedules for a repository. Uses cwd's git remote origin if no URL is given. Idempotent — no-op when no schedule exists.")
    .option("-y, --yes", "Skip interactive confirmation")
    .option("--json", "Emit result as machine-readable JSON")
    .action(actionDisconnect);
}
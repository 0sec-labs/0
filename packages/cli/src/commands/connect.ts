// `0sec connect` — one-command onboarding: point 0sec at a repository and the
// managed cloud starts working on it. Verifies cloud auth, detects the
// project's test command, enqueues the first secure run immediately, and
// installs a recurring schedule. Two steps total for the user:
// `0sec auth login` (once) and `0sec connect <repo>`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import chalk from "chalk";
import {
  CloudClient,
  CloudUnauthorizedError,
  loadCloudCredentials,
  CloudAuthMissingError,
} from "@0sec/core";

interface ConnectOptions {
  testCommand?: string;
  setupCommand?: string;
  model?: string;
  costCeiling?: number;
  cron: string;
  noSchedule: boolean;
}

/** Test-command detection from a shallow clone. Ordered by ecosystem confidence. */
function detectTestCommand(repoUrl: string): { command: string; source: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "0sec-connect-"));
  try {
    execFileSync("git", ["clone", "--depth", "1", "--quiet", repoUrl, dir], {
      timeout: 120_000,
      stdio: "pipe",
    });
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
        return { command: runner === "npm" ? "npm test" : `${runner} test`, source: "package.json" };
      }
    }
    if (existsSync(join(dir, "Makefile"))) {
      const make = readFileSync(join(dir, "Makefile"), "utf8");
      if (/^test:/m.test(make)) return { command: "make test", source: "Makefile" };
    }
    if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "pytest.ini")) || existsSync(join(dir, "tox.ini"))) {
      return { command: "python3 -m pytest", source: "python project files" };
    }
    if (existsSync(join(dir, "Cargo.toml"))) return { command: "cargo test", source: "Cargo.toml" };
    if (existsSync(join(dir, "go.mod"))) return { command: "go test ./...", source: "go.mod" };
    return null;
  } catch {
    return null; // Clone or parse failure — caller falls back to explicit flag.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function registerConnectCommand(program: Command): void {
  program
    .command("connect")
    .description("Connect a repository: 0sec starts securing it now and keeps it secure on a schedule")
    .argument("<repo>", "HTTPS git URL of the repository you own or are authorized to assess")
    .option("--test-command <command>", "Regression command; auto-detected from the repo when omitted")
    .option("--setup-command <command>", "Setup/build command run before tests (e.g. pnpm install)")
    .option("-m, --model <model>", "Model for the managed runs; defaults to the cloud routing default")
    .option("--cost-ceiling <usd>", "Per-run model cost ceiling in USD", (v: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("Must be a positive dollar amount.");
      return n;
    })
    .option("--cron <expression>", "Recurring schedule (cron). Default: daily at 03:00 UTC", "0 3 * * *")
    .option("--no-schedule", "Only run once, do not install a recurring schedule", false)
    .action(async (repo: string, options: ConnectOptions) => {
      if (!/^https:\/\/[^\s]+\.git$|^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repo)) {
        throw new InvalidArgumentError("repo must be an HTTPS git URL (e.g. https://github.com/org/repo)");
      }

      let creds;
      try {
        creds = loadCloudCredentials();
      } catch (error) {
        if (error instanceof CloudAuthMissingError) {
          process.stderr.write(
            `${chalk.red("Not authenticated.")} Run ${chalk.bold("0sec auth login")} first, then connect again.\n`,
          );
          process.exitCode = 2;
          return;
        }
        throw error;
      }

      const client = new CloudClient({ host: creds.host, token: creds.token });
      try {
        await client.pingHealth();
      } catch (error) {
        if (error instanceof CloudUnauthorizedError) {
          process.stderr.write(`${chalk.red("Cloud token rejected.")} Run ${chalk.bold("0sec auth login")} again.\n`);
          process.exitCode = 2;
          return;
        }
        throw error;
      }

      let testCommand = options.testCommand;
      if (!testCommand) {
        process.stderr.write("Detecting test command…\n");
        const detected = detectTestCommand(repo);
        if (!detected) {
          process.stderr.write(
            `${chalk.red("Could not detect a test command.")} Pass ${chalk.bold("--test-command")} explicitly (e.g. --test-command "npm test").\n`,
          );
          process.exitCode = 1;
          return;
        }
        testCommand = detected.command;
        process.stderr.write(`Detected ${chalk.bold(testCommand)} (from ${detected.source}).\n`);
      }

      const secureConfig: Record<string, unknown> = {
        repo,
        test_command: testCommand,
        ...(options.setupCommand ? { setup_command: options.setupCommand } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.costCeiling ? { cost_ceiling_usd: options.costCeiling } : {}),
      };

      process.stderr.write("Starting the first secure run…\n");
      const scan = await client.postJson<{ id: string; target_id: string | null }>("/api/scans", {
        target: repo,
        scan_mode: "secure",
        secure_config: secureConfig,
      });

      let schedule: { id: string; next_run_at: string | null } | null = null;
      if (!options.noSchedule) {
        if (!scan.target_id) {
          process.stderr.write(chalk.yellow("Scan created without a target id — skipping schedule.\n"));
        } else {
          schedule = await client.postJson<{ id: string; next_run_at: string | null }>(
            "/api/scan-schedules",
            {
              target_id: scan.target_id,
              cron_expression: options.cron,
              scan_mode: "secure",
              secure_config: secureConfig,
            },
          );
        }
      }

      const scanUrl = `${creds.host}/cloud/scans/${scan.id}`;
      process.stdout.write(
        [
          "",
          chalk.green.bold("Connected."),
          `  Repository:   ${repo}`,
          `  Test command: ${testCommand}`,
          `  First run:    ${scanUrl}`,
          schedule
            ? `  Schedule:     ${options.cron} (next: ${schedule.next_run_at ?? "pending"})`
            : "  Schedule:     none (one-shot run)",
          "",
          "0sec will investigate, reproduce, repair, and verify. Verified patches and evidence are retained on the scan for your review.",
          "",
        ].join("\n"),
      );
    });
}

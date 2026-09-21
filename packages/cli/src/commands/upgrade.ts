/**
 * `0sec upgrade` — fetches and installs a 0sec binary via the canonical
 * install.sh script. Delegates to the shared {@link performAutoUpdate}
 * helper so that both manual `upgrade` and automatic policy use the same
 * single installer path.
 *
 * Windows support: install.sh does not target Windows, so we print the
 * download URL and tell the user to refresh manually.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { performAutoUpdate } from "../utils/update-check.js";
import { scanDependencies } from "./deps.js";

const RELEASES_URL = "https://github.com/0sec-labs/0sec/releases/latest";

interface UpgradeOptions {
  version?: string;
  installDir?: string;
  scanDependencies?: boolean;
  fixDependencies?: boolean;
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .alias("update")
    .description("Fetch and install the latest 0 binary (re-runs install.sh)")
    .option("--version <tag>", "Pin a specific release tag (e.g. v0.10.0)")
    .option("--install-dir <path>", "Override the install directory (default: ~/.0/bin)")
    .option("--scan-dependencies", "Scan the current project before upgrading")
    .option("--fix-dependencies", "Refuse upgrade when vulnerabilities are present; use `0 deps fix --yes` to remediate")
    .action(async (opts: UpgradeOptions) => {
      if (opts.fixDependencies || opts.scanDependencies) {
        const scan = await scanDependencies();
        console.log(`  dependency scan: ${scan.findings.length} vulnerable dependencies detected`);
        if (scan.findings.length) {
          console.error("  upgrade stopped; review findings and run `0sec deps fix --yes`.");
          process.exitCode = 1;
          return;
        }
      }
      if (process.platform === "win32") {
        console.log("");
        console.log(`  ${chalk.bold("0sec upgrade")} doesn't support Windows yet.`);
        console.log("");
        console.log(`  Download the latest ${chalk.cyan("0sec-windows-x64.exe")} from:`);
        console.log(`    ${chalk.cyan(RELEASES_URL)}`);
        console.log("");
        console.log(`  Replace your current binary in place.`);
        console.log("");
        process.exit(1);
      }
      console.log("");
      console.log(`  ${chalk.bold("0sec upgrade")} — fetching the latest binary\u2026`);
      if (opts.version) console.log(`    ${chalk.dim(`tag=${opts.version}`)}`);
      if (opts.installDir) console.log(`    ${chalk.dim(`install_dir=${opts.installDir}`)}`);
      const result = await performAutoUpdate({ version: opts.version, installDir: opts.installDir });
      if (result.signal) { process.kill(process.pid, result.signal); return; }
      if (result.success) {
        console.log("");
        console.log(`  ${chalk.green("\u2713")} ${chalk.bold("upgraded.")} run ${chalk.cyan("0sec --version")} to confirm.`);
        console.log("");
        process.exit(0);
      }
      console.error(chalk.red(`upgrade failed: ${result.error ?? "unknown error"}`));
      process.exit(result.exitCode ?? 1);
    });
}
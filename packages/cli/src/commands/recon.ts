import type { Command } from "commander";
import chalk from "chalk";
import { runRecon, ScopePolicy, isScopeEnforcementEnabled, getScopeEnforcementState, type ReconAsset, type ReconResult } from "@0/core";

interface ReconOptions {
  json?: boolean;
  timeout?: string;
  active?: boolean;
  scope?: string;
}

export function registerReconCommand(program: Command): void {
  program
    .command("recon")
    .description(
      "Map a domain's attack surface: subdomains, endpoints, API docs, and MCP servers.",
    )
    .argument("<domain>", "Target domain or origin, e.g. example.com or https://api.example.com")
    .option("--json", "Emit the asset inventory as machine-readable JSON")
    .option("--timeout <ms>", "Per-request probe timeout in milliseconds", "10000")
    .option(
      "--active",
      "Enable active DNS subdomain brute-force; the optional scope plugin enforces candidate authorization.",
    )
    .option(
      "--scope <file>",
      "JSON engagement policy; required for --active only while the scope plugin is enabled.",
    )
    .action(async (domain: string, opts: ReconOptions) => {
      let timeout = 10_000;
      if (opts.timeout !== undefined) {
        const parsed = Number(opts.timeout);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          console.error(chalk.red(`Invalid --timeout '${opts.timeout}': must be a positive number (ms).`));
          process.exitCode = 2;
          return;
        }
        timeout = parsed;
      }

      const scopeEnforcement = getScopeEnforcementState();
      console.error(chalk.dim(scopeEnforcement.message));
      let scope: ScopePolicy | undefined;
      if (opts.scope) {
        try {
          scope = ScopePolicy.fromJsonFile(opts.scope);
        } catch (err) {
          console.error(chalk.red(`Failed to load --scope '${opts.scope}': ${err instanceof Error ? err.message : String(err)}`));
          process.exitCode = 2;
          return;
        }
      }
      if (isScopeEnforcementEnabled() && opts.active && !scope) {
        console.error(
          chalk.red(
            "--active requires --scope <file>: active subdomain enumeration is deny-by-default (it issues DNS queries against the target). Pass an authorized scope file.",
          ),
        );
        process.exitCode = 2;
        return;
      }

      let result: ReconResult;
      try {
        result = await runRecon(domain, {
          timeout,
          ...(opts.active ? { activeSubdomains: { enabled: true, scope } } : {}),
        });
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 2;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      renderRecon(result);
    });
}

function renderRecon(result: ReconResult): void {
  console.log(chalk.bold(`recon: ${result.domain}`));
  console.log(`  assets: ${result.summary.total}`);
  for (const [kind, count] of Object.entries(result.summary.byKind)) {
    console.log(`    ${kind}: ${count}`);
  }
  console.log("");

  const groups: Record<string, ReconAsset[]> = {};
  for (const asset of result.assets) {
    (groups[asset.kind] ??= []).push(asset);
  }
  for (const [kind, assets] of Object.entries(groups)) {
    console.log(chalk.bold(kind));
    for (const asset of assets) {
      const meta = asset.metadata
        ? chalk.dim(
            ` (${Object.entries(asset.metadata)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")})`,
          )
        : "";
      console.log(`  ${asset.value}${meta}`);
    }
    console.log("");
  }

  if (result.warnings.length > 0) {
    console.log(chalk.yellow(`warnings (${result.warnings.length}):`));
    for (const w of result.warnings) console.log(chalk.dim(`  - ${w}`));
  }
}

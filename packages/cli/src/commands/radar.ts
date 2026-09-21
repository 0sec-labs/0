/**
 * `0 radar` — Continuous "diff radar": score recent commits for silent
 * security-fix signals via Jev. Only survivors consume deep review / variant-
 * hunt spend. Jev is advisory only — never removes candidates, never grants
 * authority, never verifies/dismisses a vulnerability.
 *
 * Exit codes:
 *   0 → completed (results may be empty)
 *   1 → Jev not enabled (missing ZERO_JEV_FEATURES=radar or provider)
 */

import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createJevEvaluator,
  jevConfigFromEnvironment,
} from "@0/shared";
import {
  radarCandidatesToSeedFindings,
  scanRepoCommitsWithJev,
} from "@0/core";

interface RadarOpts {
  repo?: string;
  since?: string;
  path?: string[];
  limit?: string;
  out?: string;
  seedsOut?: string;
}

function parsePositive(flag: string, raw: string | undefined, dflt: number): number {
  if (raw === undefined) return dflt;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${flag} '${raw}' (expected positive integer)`);
  return n;
}

async function radarAction(opts: RadarOpts): Promise<void> {
  if (!opts.repo) throw new Error("missing required flag: --repo <path>");
  const repo = resolve(opts.repo);
  try {
    execFileSync("git", ["-C", repo, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
  } catch {
    throw new Error(`--repo ${repo} is not a git working tree`);
  }

  const config = jevConfigFromEnvironment("radar", process.env);
  if (!config) {
    process.stderr.write(
      "Jev commit radar requires ZERO_JEV_FEATURES=radar and a configured provider\n",
    );
    process.exitCode = 1;
    return;
  }

  const evaluator = createJevEvaluator(config);
  const limit = parsePositive("--limit", opts.limit, 200);

  const result = await scanRepoCommitsWithJev({
    repo,
    evaluator,
    since: opts.since,
    paths: opts.path,
    limit,
  });

  const rankedJson = JSON.stringify(result, null, 2);
  if (opts.out) {
    writeFileSync(resolve(opts.out), rankedJson + "\n", "utf8");
  } else {
    process.stdout.write(rankedJson + "\n");
  }

  if (opts.seedsOut) {
    const repo = resolve(opts.repo);
    const seeds = radarCandidatesToSeedFindings(result, repo);
    writeFileSync(resolve(opts.seedsOut), JSON.stringify(seeds, null, 2) + "\n", "utf8");
  }

  process.exitCode = 0;
}

/**
 * The `radar` commander command. The caller wires this into the parent program
 * (e.g. via `program.addCommand(radarCommand)`).
 */
export const radarCommand = new Command("radar")
  .description(
    "Score recent commits in a git repo for silent security-fix signals " +
      "using Jev. Only survivors consume deep review / variant-hunt spend. " +
      "Jev is advisory only. Requires ZERO_JEV_FEATURES=radar.",
  )
  .requiredOption("--repo <path>", "Path to a valid git working tree")
  .option("--since <date-or-ref>", "Git since-format constraint (e.g. '7 days ago', 'HEAD~50')")
  .option("--path <paths...>", "Restrict scanning to specific file paths (repeatable)")
  .option("--limit <N>", "Maximum commits to enumerate (default 200)")
  .option("--out <path>", "Write ranked JSON results to file instead of stdout")
  .option("--seeds-out <path>", "Write SeedFindings JSON for variant-hunt candidates to file")
  .action(async (opts: RadarOpts) => {
    try {
      await radarAction(opts);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const json = JSON.stringify({ mode: "radar", error: reason }, null, 2);
      process.stderr.write(json + "\n");
      process.exitCode = 1;
    }
  });

export function registerRadarCommand(program: Command): void {
  program.addCommand(radarCommand);
}
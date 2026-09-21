import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync } from "node:fs";
import { generateSyzChoiceWeights, syzChoiceWeightsFromPlan } from "@0/core";
import type { CrashRecord, KernelVariantHuntReport, SyzJevPrepassInput } from "@0/core";
import { createJevEvaluator, findingSchema, jevConfigFromEnvironment } from "@0/shared";
import type { Finding, ScanReport, Severity } from "@0/shared";
import { formatSarif } from "../formatters/sarif.js";

const VALID_OUTPUT_FORMATS = ["terminal", "json", "sarif"] as const;
type KernelOutputFormat = (typeof VALID_OUTPUT_FORMATS)[number];

interface VariantHuntOpts {
  advisory?: string;
  tree: string;
  rules?: string;
  foxguard?: string;
  sarifInput?: string;
  timeout?: string;
  output: string;
  verbose?: boolean;
}

interface SyzbotMineOpts {
  subsystems: string;
  limit: string;
  details: string;
  detailDelay: string;
}

interface WeightsOpts {
  target: string;
  crashSummary?: string;
  jevPrepass?: string;
  enabledSyscalls?: string;
  fromFile?: string;
  model?: string;
  maxEntries: string;
  dryRun?: boolean;
  out?: string;
}

interface JevPrepassOpts {
  tree: string;
  upstreamTree?: string;
  findings: string;
  out?: string;
  verifyTop: string;
  attempts: string;
}

interface JevCommitPrepassOpts {
  tree: string;
  since: string;
  paths?: string;
  limit: string;
  out?: string;
}

interface JevSourcePrepassOpts {
  tree: string;
  subtree: string;
  out?: string;
}

interface CrashTriageOpts {
  crashes: string;
  out?: string;
  summaryOut?: string;
}

function parseNonNegativeInt(value: string, name: string, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`Invalid ${name} '${value}'; expected 0..${max}`);
  }
  return parsed;
}

function readFindings(path: string): Finding[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : undefined;
  if (!values) throw new Error("Findings input must be a Finding[] or an object with a findings array");
  return values.map((value, index) => {
    const result = findingSchema.safeParse(value);
    if (!result.success) throw new Error(`Invalid finding at index ${index}: ${result.error.issues[0]?.message ?? "schema mismatch"}`);
    return result.data as Finding;
  });
}

function parsePositiveInt(value: string, name: string, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid ${name} '${value}'; expected 1..${max}`);
  }
  return parsed;
}

function parseTimeoutMs(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid timeout '${value}'; expected positive milliseconds`);
  }
  return parsed;
}

function variantReportToScanReport(report: KernelVariantHuntReport): ScanReport {
  const bySev = (sev: Severity) => report.findings.filter((f) => f.severity === sev).length;
  return {
    target: report.tree,
    scanDepth: "default",
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    durationMs: report.durationMs,
    summary: {
      totalAttacks: report.foxguardFindings.length,
      totalFindings: report.findings.length,
      critical: bySev("critical"),
      high: bySev("high"),
      medium: bySev("medium"),
      low: bySev("low"),
      info: bySev("info"),
    },
    findings: report.findings,
    warnings: report.warnings,
  };
}

function renderTerminal(report: KernelVariantHuntReport, verbose = false): void {
  const severityColor: Record<string, (s: string) => string> = {
    critical: chalk.bgRed.white.bold,
    high: chalk.red.bold,
    medium: chalk.yellow,
    low: chalk.blue,
    info: chalk.gray,
  };

  console.log(chalk.blue(`Scanning kernel tree: ${report.tree}`));
  if (report.advisory) console.log(chalk.gray(`Advisory: ${report.advisory}`));
  if (report.rules) console.log(chalk.gray(`Rules: ${report.rules}`));
  if (report.foxguardPath) console.log(chalk.gray(`Foxguard: ${report.foxguardPath}`));

  if (report.warnings.length > 0) {
    for (const warning of report.warnings) {
      console.log(chalk.yellow(`Warning: ${warning.message}`));
    }
  }

  if (report.findings.length === 0) {
    console.log(chalk.green("\nNo variant candidates found."));
    return;
  }

  console.log(
    chalk.green(
      `\nFound ${report.findings.length} variant candidate${report.findings.length > 1 ? "s" : ""}:\n`,
    ),
  );

  for (const finding of report.findings) {
    const color = severityColor[finding.severity] ?? chalk.white;
    console.log(`  ${color(finding.severity.toUpperCase().padEnd(8))} ${chalk.white(finding.title)}`);
    console.log(
      `           ${chalk.gray(`category=${finding.category} confidence=${(finding.confidence ?? 0).toFixed(2)} id=${finding.id.slice(0, 8)}`)}`,
    );
    if (finding.fingerprint) {
      console.log(`           ${chalk.gray(`fingerprint=${finding.fingerprint}`)}`);
    }
    if (verbose && finding.evidence.analysis) {
      console.log(chalk.gray(`           ${finding.evidence.analysis.replace(/\n/g, "\n           ")}`));
    }
    console.log();
  }

  const scanReport = variantReportToScanReport(report);
  console.log(chalk.white.bold("Summary:"));
  for (const sev of ["critical", "high", "medium", "low", "info"] as const) {
    const count = scanReport.summary[sev];
    if (count > 0) {
      const color = severityColor[sev] ?? chalk.white;
      console.log(`  ${color(`${sev}: ${count}`)}`);
    }
  }
}

export function registerKernelCommand(program: Command): void {
  const kernel = program
    .command("kernel")
    .description("Kernel security workflows");

  kernel
    .command("jev-prepass")
    .description("Rank kernel hypotheses with Jev before expensive oracle verification")
    .requiredOption("--tree <path>", "Path to the exact Linux source tree")
    .option("--upstream-tree <path>", "Current upstream Linux tree used to exclude already-fixed bugs before Jev spend")
    .requiredOption("--findings <path>", "Finding[] or scan-report JSON from a kernel source review")
    .option("--verify-top <n>", "Run the existing kernel oracle for the top N ranked hypotheses", "0")
    .option("--attempts <n>", "Maximum kernel_run attempts per selected hypothesis", "5")
    .option("-o, --out <path>", "Write the exhaustive ranked result to a file")
    .action(async (opts: JevPrepassOpts) => {
      try {
        const findings = readFindings(opts.findings);
        const config = jevConfigFromEnvironment("kernel", process.env);
        if (!config) {
          throw new Error("Jev kernel prepass requires ZERO_JEV_FEATURES=kernel and a configured provider");
        }
        const {
          applyVerificationToFinding, checkAlreadyFixed,
          rankKernelHypothesesWithJev, verifyStaticKernelFinding,
        } = await import("@0/core");
        const noveltyExcluded = opts.upstreamTree ? findings.flatMap((finding) => {
          const path = finding.reviewAnnotation?.path ?? finding.evidence.request.match(/([^\s:]+\.[ch]):\d+/)?.[1];
          if (!path) return [];
          const functionName = finding.title.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1]
            ?? finding.evidence.analysis?.match(/\bFunction\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
          const gate = checkAlreadyFixed({
            tree: opts.upstreamTree!, filePath: path,
            ...(functionName ? { faultingFunction: functionName } : {}),
          });
          return gate.functionLevelMatch ? [{ finding, gate }] : [];
        }) : [];
        const excludedIds = new Set(noveltyExcluded.map((item) => item.finding.id));
        const eligible = findings.filter((finding) => !excludedIds.has(finding.id));
        const result = await rankKernelHypothesesWithJev(opts.tree, eligible, createJevEvaluator(config));
        const verifyTop = parseNonNegativeInt(opts.verifyTop, "--verify-top", findings.length);
        const attempts = parsePositiveInt(opts.attempts, "--attempts", 25);
        const verification = [];
        const verificationQueue = result.candidates.filter((item) => item.nextAction === "verify");
        for (const candidate of verificationQueue.slice(0, verifyTop)) {
          const oracle = await verifyStaticKernelFinding(candidate.finding, {
            kernelTree: opts.tree,
            attempts,
          });
          verification.push({
            rank: candidate.rank,
            findingId: candidate.finding.id,
            result: oracle,
            finding: applyVerificationToFinding(candidate.finding, oracle),
          });
        }
        const output = JSON.stringify({ ...result, noveltyExcluded, verification }, null, 2) + "\n";
        if (opts.out) {
          writeFileSync(opts.out, output);
          console.error(chalk.green(`wrote ${opts.out} (${result.evaluated} evaluated, ${result.unscored} unscored)`));
        } else {
          console.log(output.trimEnd());
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });

  kernel
    .command("jev-commit-prepass")
    .description("Exhaustively rank kernel commit diffs for deep security review")
    .requiredOption("--tree <path>", "Path to a Linux git tree")
    .option("--since <git-date>", "Enumerate commits since this git date", "14 days ago")
    .option("--paths <csv>", "Optional repo-relative path prefixes")
    .option("--limit <n>", "Maximum commits to enumerate", "400")
    .option("-o, --out <path>", "Write ranked commit ledger to a file")
    .action(async (opts: JevCommitPrepassOpts) => {
      try {
        const config = jevConfigFromEnvironment("kernel", process.env);
        if (!config) throw new Error("Jev commit prepass requires ZERO_JEV_FEATURES=kernel and a configured provider");
        const { rankKernelCommitsWithJev } = await import("@0/core");
        const result = await rankKernelCommitsWithJev({
          tree: opts.tree,
          evaluator: createJevEvaluator(config),
          since: opts.since,
          limit: parsePositiveInt(opts.limit, "--limit", 10_000),
          ...(opts.paths ? { paths: opts.paths.split(",").map((path) => path.trim()).filter(Boolean) } : {}),
        });
        const output = JSON.stringify(result, null, 2) + "\n";
        if (opts.out) {
          writeFileSync(opts.out, output);
          console.error(chalk.green(`wrote ${opts.out} (${result.evaluated}/${result.commitsEnumerated} evaluated)`));
        } else {
          console.log(output.trimEnd());
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });

  kernel
    .command("jev-source-prepass")
    .description("Extract and directly Jev-rank every C function in a kernel subtree")
    .requiredOption("--tree <path>", "Path to the Linux source tree")
    .requiredOption("--subtree <path>", "Repo-relative kernel subtree or C source file")
    .option("-o, --out <path>", "Write the exhaustive function ranking ledger to a file")
    .action(async (opts: JevSourcePrepassOpts) => {
      try {
        const config = jevConfigFromEnvironment("kernel", process.env);
        if (!config) throw new Error("Jev source prepass requires ZERO_JEV_FEATURES=kernel and a configured provider");
        const { runKernelSourceJevPrepass } = await import("@0/core");
        const result = await runKernelSourceJevPrepass({
          tree: opts.tree,
          subtree: opts.subtree,
          evaluator: createJevEvaluator(config),
        });
        const output = JSON.stringify(result, null, 2) + "\n";
        if (opts.out) {
          writeFileSync(opts.out, output);
          console.error(chalk.green(`wrote ${opts.out} (${result.evaluated}/${result.functionsEnumerated} functions evaluated from ${result.filesEnumerated.length} files)`));
        } else console.log(output.trimEnd());
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });

  kernel
    .command("crash-triage")
    .description("Rank fuzzer crashes with Jev for exploit-pipeline spend prioritisation")
    .requiredOption("--crashes <path>", "Path to crash JSON (array of CrashRecord or { crashes: CrashRecord[] })")
    .option("-o, --out <path>", "Write ranked crash triage JSON to a file")
    .option("--summary-out <path>", "Write compact markdown crash summary to a file")
    .action(async (opts: CrashTriageOpts) => {
      try {
        const config = jevConfigFromEnvironment("crash", process.env);
        if (!config) {
          throw new Error("Jev crash triage requires ZERO_JEV_FEATURES=crash and a configured provider");
        }
        const parsed: unknown = JSON.parse(readFileSync(opts.crashes, "utf8"));
        let crashes: unknown[];
        if (Array.isArray(parsed)) {
          crashes = parsed;
        } else if (parsed && typeof parsed === "object" && "crashes" in parsed) {
          crashes = Array.isArray(parsed.crashes) ? parsed.crashes : [];
        } else {
          crashes = [];
        }
        if (crashes.length === 0) throw new Error("Crash input must be a CrashRecord[] or an object with a crashes array");
        const records = crashes.filter((c): c is CrashRecord =>
          !!c && typeof c === "object" && "id" in c && "summary" in c
          && typeof c.id === "string" && typeof c.summary === "string");
        if (records.length !== crashes.length) throw new Error("Every crash record requires string id and summary fields");
        const { rankCrashesWithJev, crashSummaryFromTriage } = await import("@0/core");
        const result = await rankCrashesWithJev(
          records,
          createJevEvaluator(config),
        );
        const output = JSON.stringify(result, null, 2) + "\n";
        if (opts.out) {
          writeFileSync(opts.out, output);
          console.error(chalk.green(`wrote ${opts.out} (${result.evaluated} evaluated, ${result.unscored} unscored)`));
        } else {
          console.log(output.trimEnd());
        }
        if (opts.summaryOut) {
          const summary = crashSummaryFromTriage(result);
          writeFileSync(opts.summaryOut, summary);
          console.error(chalk.green(`wrote ${opts.summaryOut}`));
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });

  kernel
    .command("syzbot-mine")
    .description("Mine and LPE-rank syzbot's invalid/auto-closed queue")
    .option("--subsystems <csv>", "Subsystem labels to keep", "net,net/sched,net/tls,xfrm,crypto,vsock,nfc")
    .option("--limit <n>", "Maximum ranked candidates", "30")
    .option("--details <n>", "Top candidate detail pages to enrich", "15")
    .option("--detail-delay <ms>", "Delay between syzbot detail/repro requests", "750")
    .action(async (opts: SyzbotMineOpts) => {
      try {
        const limit = parsePositiveInt(opts.limit, "--limit", 500);
        const details = parsePositiveInt(opts.details, "--details", 100);
        const detailDelayMs = parsePositiveInt(opts.detailDelay, "--detail-delay", 5_000);
        const subsystems = opts.subsystems.split(",").map((value) => value.trim()).filter(Boolean);
        const { defaultSyzbotFetcher, mineSyzbotQueue, toHuntCandidates } = await import("@0/core");
        const result = await mineSyzbotQueue({
          fetch: defaultSyzbotFetcher,
          fetchDetail: defaultSyzbotFetcher,
          fetchRepro: defaultSyzbotFetcher,
          maxDetailFetches: details,
          detailDelayMs,
          limit,
          subsystems,
          log: (message) => console.error(message),
        });
        console.log(JSON.stringify({ ...result, huntCandidates: toHuntCandidates(result) }, null, 2));
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });

  kernel
    .command("weights")
    .description("Generate an LLM-derived syzkaller choice_weights.json for a kernelCTF target")
    .requiredOption("--target <version>", "Target kernel version, e.g. 6.12.101")
    .option("--crash-summary <path>", "File with recent crash descriptions to inform weighting")
    .option("--jev-prepass <path>", "Jev commit/finding prepass JSON used as ranked weighting evidence")
    .option("--enabled-syscalls <path>", "JSON array file of manager-enabled syscall names to constrain the plan")
    .option("--from-file <path>", "Validate/normalize a raw model JSON plan instead of calling the API")
    .option("-m, --model <model>", "Override model (default: env/auto-detected)")
    .option("--max-entries <n>", "Maximum weighted syscalls", "48")
    .option("--dry-run", "Print the weights file instead of writing")
    .option("-o, --out <path>", "Output path for choice_weights.json")
    .action(async (opts: WeightsOpts) => {
      try {
        const crashSummary = opts.crashSummary ? readFileSync(opts.crashSummary, "utf8") : undefined;
        let jevPrepass: SyzJevPrepassInput | undefined;
        if (opts.jevPrepass) {
          const parsed = JSON.parse(readFileSync(opts.jevPrepass, "utf8")) as Record<string, unknown>;
          jevPrepass = "commits" in parsed || "hypotheses" in parsed
            ? parsed as SyzJevPrepassInput
            : Array.isArray(parsed.candidates) && parsed.candidates.some((candidate) =>
              typeof candidate === "object" && candidate !== null && "sha" in candidate)
              ? { commits: parsed as unknown as SyzJevPrepassInput["commits"] }
              : { hypotheses: parsed as unknown as SyzJevPrepassInput["hypotheses"] };
        }
        const enabledSyscalls = opts.enabledSyscalls
          ? (JSON.parse(readFileSync(opts.enabledSyscalls, "utf8")) as string[])
          : undefined;
        const result = opts.fromFile
          ? syzChoiceWeightsFromPlan(readFileSync(opts.fromFile, "utf8"), {
              target: opts.target,
              crashSummary,
              maxEntries: parsePositiveInt(opts.maxEntries, "--max-entries", 128),
            })
          : await generateSyzChoiceWeights({
              target: opts.target,
              crashSummary,
              enabledSyscalls,
              jevPrepass,
              model: opts.model,
              maxEntries: parsePositiveInt(opts.maxEntries, "--max-entries", 128),
              log: (message) => console.error(message),
            });
        if (opts.dryRun || !opts.out) {
          console.log(JSON.stringify(result.file, null, 2));
        } else {
          writeFileSync(opts.out, JSON.stringify(result.file, null, 2) + "\n");
          console.error(chalk.green(`wrote ${opts.out} (${result.file.allowed_names.length} entries, provider=${result.file.provenance.provider})`));
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });

  kernel
    .command("variant-hunt")
    .description("Run foxguard-backed kernel advisory variant hunting")
    .requiredOption("--tree <path>", "Path to a Linux source tree")
    .option("--advisory <url-or-file>", "Advisory URL or local advisory path for provenance")
    .option("--rules <path>", "Foxguard rule directory, e.g. rules/kernel/dirty-frag-class")
    .option("--foxguard <path>", "Foxguard binary path")
    .option("--sarif-input <path>", "Use an existing foxguard SARIF file instead of invoking foxguard")
    .option("--timeout <ms>", "Foxguard timeout in milliseconds", "120000")
    .option("-o, --output <format>", "Output format: terminal | json | sarif", "terminal")
    .option("-v, --verbose", "Verbose terminal output")
    .action(async (opts: VariantHuntOpts) => {
      try {
        const output = opts.output as KernelOutputFormat;
        if (!VALID_OUTPUT_FORMATS.includes(output)) {
          throw new Error(
            `Invalid output format '${opts.output}'. Valid: ${VALID_OUTPUT_FORMATS.join(", ")}`,
          );
        }

        const { runKernelVariantHunt } = await import("@0/core");
        const report = await runKernelVariantHunt({
          tree: opts.tree,
          advisory: opts.advisory,
          rules: opts.rules,
          foxguardPath: opts.foxguard,
          sarifPath: opts.sarifInput,
          timeoutMs: parseTimeoutMs(opts.timeout),
        });

        if (output === "json") {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        if (output === "sarif") {
          console.log(formatSarif(variantReportToScanReport(report)));
          return;
        }

        renderTerminal(report, opts.verbose);
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}

export { parsePositiveInt, variantReportToScanReport };

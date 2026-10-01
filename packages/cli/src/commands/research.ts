import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { Finding, ScanReport } from "@0/shared";
import type { ResearchTarget, ResearchCandidate, TargetResearchAdapter, ResearchRunResult, RunResearchOptions, UnifiedPipelineTargetConfig } from "@0/core";

async function managedResearch<T extends ResearchTarget, C extends ResearchCandidate, H, X>(adapter: TargetResearchAdapter<T, C, H, X>, target: T, options: RunResearchOptions<T>, engine: typeof import("@0/core").runResearch): Promise<ResearchRunResult<C>> {
  const { executeManagedOperation } = await import("../managed-operation.js");
  const started = Date.now();
  return executeManagedOperation<ResearchRunResult<C>>({ type: "research", name: `Research: ${adapter.kind}`, target: target.location, timeCapMs: 600_000, costCapUsd: 5,
    execute: async context => {
      const bound = target.kind === "pipeline.unified" ? { ...target, config: { ...target.config as object, options: { ...(target.config as UnifiedPipelineTargetConfig).options,
        signal: context.signal, costLedger: context.costLedger, costCeilingUsd: context.plan.costCapUsd, timeout: Math.max(1, context.deadline - Date.now()) } } } as T : target;
      return engine(adapter, bound, { ...options, signal: context.signal });
    },
    status: result => result.completed === false ? "failed" : "completed",
    reports: result => {
      const findings = result.findings.map(item => item.finding);
      const scanDepth = target.kind === "pipeline.unified" ? (target.config as UnifiedPipelineTargetConfig).options.depth : "default";
      const report: ScanReport = {
        target: target.location, scanDepth, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - started,
        findings, warnings: result.warnings.map(message => ({ stage: "source-analysis", message })), executionSuccessful: result.completed,
        summary: { totalAttacks: 0, totalFindings: findings.length, critical: findings.filter(f => f.severity === "critical").length, high: findings.filter(f => f.severity === "high").length,
          medium: findings.filter(f => f.severity === "medium").length, low: findings.filter(f => f.severity === "low").length, info: findings.filter(f => f.severity === "info").length },
      };
      return [report];
    },
  });
}


function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function registerResearchCommand(program: Command): void {
  const research = program
    .command("research")
    .description("Run target-specific research engines");

  research
    .command("pipeline")
    .description("Run the existing web/AI/source/package pipeline through the shared evidence plane")
    .requiredOption("--target <target>", "URL, local path, repository, package, or image")
    .option("--target-type <type>", "url, web-app, source-code, npm-package, pypi-package, cargo-package, or oci-image")
    .option("--profile <profile>", "Source review profile")
    .option("--depth <depth>", "quick, default, or deep", "default")
    .option("--runtime <runtime>", "auto, api, claude, codex, gemini, or ollama", "auto")
    .option("--artifact-root <path>", "Research artifact root", ".0-research")
    .action(async (opts: { target: string; targetType?: string; profile?: string; depth: string; runtime: string; artifactRoot: string }) => {
      const { UnifiedPipelineResearchAdapter, runResearch } = await import("@0/core");
      const allowedTypes = new Set(["url", "web-app", "source-code", "npm-package", "pypi-package", "cargo-package", "oci-image"]);
      if (opts.targetType && !allowedTypes.has(opts.targetType)) throw new Error(`unsupported --target-type ${opts.targetType}`);
      print(await managedResearch(
        new UnifiedPipelineResearchAdapter(),
        {
          kind: "pipeline.unified",
          id: `pipeline:${opts.target}`,
          location: opts.target,
          config: {
            options: {
              depth: opts.depth as "quick" | "default" | "deep",
              format: "json",
              runtime: opts.runtime as "auto" | "api" | "claude" | "codex" | "gemini" | "ollama",
              ...(opts.targetType ? { targetType: opts.targetType as "url" | "web-app" | "source-code" | "npm-package" | "pypi-package" | "cargo-package" | "oci-image" } : {}),
              ...(opts.profile ? { reviewProfile: opts.profile as "default" } : {}),
            },
          },
        },
        { artifactRoot: resolve(opts.artifactRoot), log: (message) => process.stderr.write(message + "\n") }, runResearch,
      ));
    });

  research
    .command("mobile")
    .description("Run passive mobile intake; indicators remain hypotheses and only scoped adapters may hand off targets")
    .requiredOption("--target <path>", "Extracted APK/IPA directory or metadata file")
    .option("--artifact-root <path>", "Research artifact root", ".0-research")
    .action(async (opts: { target: string; artifactRoot: string }) => {
      const { MobileStaticResearchAdapter, runResearch } = await import("@0/core");
      const targetPath = resolve(opts.target);
      print(await managedResearch(
        new MobileStaticResearchAdapter(),
        { kind: "mobile.static-intake", id: `mobile:${targetPath}`, location: targetPath, config: {} },
        { artifactRoot: resolve(opts.artifactRoot), log: (message) => process.stderr.write(message + "\n") }, runResearch,
      ));
    });

  research
    .command("linux-matrix")
    .description("Import externally executed vulnerable-vs-patched boot logs; 0 validates and hashes them but does not execute boots")
    .requiredOption("--matrix <path>", "Versioned external boot-matrix manifest JSON")
    .requiredOption("--finding <path>", "Existing Finding JSON to bind the proof to")
    .option("--artifact-root <path>", "Research artifact root", ".0-research")
    .action(async (opts: { matrix: string; finding: string; artifactRoot: string }) => {
      const { LinuxBootMatrixImportAdapter, runResearch } = await import("@0/core");
      const matrix = resolve(opts.matrix);
      const finding = JSON.parse(readFileSync(resolve(opts.finding), "utf8")) as Finding;
      const result = await managedResearch(
        new LinuxBootMatrixImportAdapter(),
        { kind: "linux.kernel-boot-matrix-import", id: `linux-matrix:${finding.id}`, location: matrix, config: { finding } },
        { artifactRoot: resolve(opts.artifactRoot), log: (message) => process.stderr.write(message + "\n") }, runResearch,
      );
      if (result.candidates.length === 0) throw new Error("external boot-matrix manifest failed validation");
      print(result);
    });

  research
    .command("linux")
    .description("Run a supplied Linux kernel reproducer through the shared N-boot evidence gate")
    .requiredOption("--kernel-tree <path>", "Linux source tree")
    .requiredOption("--reproducer <path>", "C reproducer or syzkaller .syz program")
    .requiredOption("--finding <path>", "Existing Finding JSON to bind the proof to")
    .requiredOption("--expected-signature <literal>", "Literal crash signature that every counted boot must contain")
    .option("--boots <n>", "Fresh boots", "3")
    .option("--min-hits <n>", "Required reproducing boots", "2")
    .option("--artifact-root <path>", "Research artifact root", ".0-research")
    .action(async (opts: { kernelTree: string; reproducer: string; finding: string; expectedSignature: string; boots: string; minHits: string; artifactRoot: string }) => {
      const { LinuxKernelResearchAdapter, runResearch } = await import("@0/core");
      const kernelTree = resolve(opts.kernelTree);
      const reproducer = resolve(opts.reproducer);
      const finding = JSON.parse(readFileSync(resolve(opts.finding), "utf8")) as Finding;
      const boots = Number.parseInt(opts.boots, 10);
      const minHits = Number.parseInt(opts.minHits, 10);
      if (!Number.isFinite(boots) || boots < 1 || !Number.isFinite(minHits) || minHits < 1 || minHits > boots) {
        throw new Error("--boots and --min-hits must be positive, with min-hits <= boots");
      }
      if (!opts.expectedSignature.trim()) throw new Error("--expected-signature must not be empty");
      const verify = reproducer.endsWith(".syz")
        ? { syzProgramPath: reproducer, boots, minHits, expectedSignature: opts.expectedSignature }
        : { reproducerPath: reproducer, boots, minHits, expectedSignature: opts.expectedSignature };
      const result = await managedResearch(
        new LinuxKernelResearchAdapter(),
        {
          kind: "linux.kernel-reproducer",
          id: `linux:${finding.id}`,
          location: kernelTree,
          config: { finding, verify },
        },
        { artifactRoot: resolve(opts.artifactRoot), log: (message) => process.stderr.write(message + "\n") }, runResearch,
      );
      if (result.findings.length === 0) {
        throw new Error("kernel N-boot verification did not reproduce the expected signature");
      }
      print(result);
    });
}

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildTier2Harness, type BuildSystem, type Tier2HarnessArtifact } from "../../review/c-cpp-tier2.js";
import type { FunctionSignature } from "../../review/c-cpp-profile.js";
import { crashArtifactToFinding, type MemSafetyFinding } from "../../stages/memsafety-scan.js";
import type { CrashArtifact, MemSafetyTarget } from "../../triage/memsafety-types.js";
import { memCorruptionVerdict } from "../../triage/pov-gate.js";
import { parseCrashOutput } from "../../triage/userspace-fuzz-runner.js";
import { classifyUserspacePrimitive } from "../../triage/userspace-primitive.js";
import type {
  ResearchCandidate,
  ResearchContext,
  ResearchEvidence,
  ResearchFinding,
  ResearchStageResult,
  ResearchTarget,
  TargetResearchAdapter,
} from "../target-research-adapter.js";

const execFileAsync = promisify(execFile);

/** Reference-mitigation sources compiled into a second harness build. */
export interface CounterexampleMitigation {
  /** Replacement implementation sources, absolute or relative to sourceRoot. */
  sourceFiles: string[];
  /** Extra include directories, resolved from sourceRoot. */
  includeDirs?: string[];
}

export interface CounterexampleTargetConfig {
  suspectFunction: FunctionSignature;
  sourceRoot: string;
  buildSystem?: BuildSystem;
  suspectSourceFile?: string;
  /** Fuzz wall-clock budget, seconds. */
  timeoutSec?: number;
  /** Finding-proposed witness inputs to replay through the sanitizer build. */
  witnessInputs?: string[];
  mitigation?: CounterexampleMitigation;
}

export type CounterexampleTarget = ResearchTarget<"userspace.counterexample", CounterexampleTargetConfig>;
export type CounterexampleCandidate = ResearchCandidate<CounterexampleTargetConfig>;

export interface CounterexampleHarnessPlan {
  candidateId: string;
  memTarget: MemSafetyTarget;
  tier2Artifact: Tier2HarnessArtifact;
  timeoutSec?: number;
}
export interface CounterexampleMitigationReplay {
  binary: string;
  crashInput: string;
  exitCode: number | null;
  sanitizerHit: boolean;
}
export interface CounterexampleExecution {
  candidateId: string;
  mitigationReplay?: CounterexampleMitigationReplay;
  /** Details from explicit witness replays (finding-proposed inputs). */
  witnessDetails?: MemSafetyFinding[];
}

/**
 * Counterexample-first memory-safety research: scaffold a Tier-2 sanitizer
 * harness from raw source, replays finding-proposed witnesses through an
 * ASan/UBSan-only build, and replays them again against a reference
 * mitigation. Fills the userspace.memsafety gap where a Tier-2 artifact had
 * to be pre-built.
 *
 * Grade boundary: a confirmed sanitizer crash is "observed" implementation
 * evidence. Mitigation replay is recorded as separate evidence and never
 * changes a finding's grade.
 */
/** Compiler/runner port; a smolvm/docker-backed implementation is a host injection. */
export type CounterexampleExec = (file: string, argv: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;
const localExec: CounterexampleExec = (file, argv, options) => execFileAsync(file, argv, options);
export class UserspaceCounterexampleResearchAdapter
  implements TargetResearchAdapter<CounterexampleTarget, CounterexampleCandidate, CounterexampleHarnessPlan, CounterexampleExecution>
{
  readonly kind = "userspace.counterexample" as const;

  constructor(private readonly exec: CounterexampleExec = localExec) {}
  async discover(target: CounterexampleTarget): Promise<ResearchStageResult<CounterexampleCandidate>> {
    const { suspectFunction, sourceRoot } = target.config;
    return {
      items: [{
        id: `${target.id}:counterexample`,
        title: `Counterexample search for ${suspectFunction.functionName} in ${sourceRoot}`,
        location: sourceRoot,
        hypothesis: "sanitizer-backed input search may find a witness violating the target's memory-safety contract",
        payload: target.config,
      }],
      evidence: [{ stage: "discover", status: "passed", summary: `planned counterexample search for ${suspectFunction.functionName}` }],
    };
  }

  async buildHarness(
    target: CounterexampleTarget,
    candidates: CounterexampleCandidate[],
    ctx: ResearchContext,
  ): Promise<ResearchStageResult<CounterexampleHarnessPlan>> {
    const { suspectFunction, sourceRoot, buildSystem, suspectSourceFile, timeoutSec } = target.config;
    const items: CounterexampleHarnessPlan[] = [];
    const evidence: ResearchEvidence[] = [];
    for (const candidate of candidates) {
      const tier2Artifact = await buildTier2Harness({
        suspectFunction,
        sourceRoot,
        buildSystem: buildSystem ?? "auto",
        outputDir: join(this.scratchRoot(sourceRoot, ctx), `tier2-${candidate.id.replace(/[^a-z0-9-]/gi, "_")}`),
        ...(suspectSourceFile ? { suspectSourceFile } : {}),
      });
      items.push({
        candidateId: candidate.id,
        memTarget: {
          language: "c",
          sourceRoot,
          buildSystem: tier2Artifact.detected_build_system,
          harnessEntry: suspectFunction.functionName,
        },
        tier2Artifact,
        ...(timeoutSec !== undefined ? { timeoutSec } : {}),
      });
      evidence.push({
        stage: "harness",
        status: "passed",
        summary: `scaffolded Tier-2 harness for ${suspectFunction.functionName} (${tier2Artifact.detected_build_system})`,
      });
    }
    return { items, evidence };
  }


  /**
   * Fuzz/harness scratch must not pollute the audited source tree (the fuzz
   * runner rejects an artifact dir inside it). When a host re-scopes the run
   * artifact root into the target itself, fall back to a temp scratch root.
   */
  private scratchRoot(sourceRoot: string, ctx: ResearchContext): string {
    const artifact = resolve(ctx.artifactDir);
    const source = resolve(sourceRoot);
    if (artifact === source || artifact.startsWith(source + "/")) {
      return mkdtempSync(join(tmpdir(), "zero-cec-scratch-"));
    }
    return ctx.artifactDir;
  }
  async execute(
    target: CounterexampleTarget,
    harnesses: CounterexampleHarnessPlan[],
    ctx: ResearchContext,
  ): Promise<ResearchStageResult<CounterexampleExecution>> {
    if (harnesses.length === 0) {
      return { items: [], evidence: [{ stage: "execute", status: "skipped", summary: "no harness plan to execute" }] };
    }
    if (ctx.signal?.aborted) {
      return { items: [], evidence: [{ stage: "execute", status: "skipped", summary: "research run was aborted before execution" }] };
    }
    const items: CounterexampleExecution[] = [];
    const evidence: ResearchEvidence[] = [];
    const warnings: string[] = [];
    for (const harness of harnesses) {
      const witnessDetails: MemSafetyFinding[] = [];
      // Deterministic witness replay only — no fuzzing. The replay binary is
      // ASan/UBSan-only and never needs the libFuzzer runtime.
      if ((target.config.witnessInputs ?? []).length === 0) {
        evidence.push({
          stage: "execute" as const,
          status: "inconclusive" as const,
          summary: "no witness inputs configured; nothing to replay",
        });
      }
      for (const witnessPath of target.config.witnessInputs ?? []) {
        const crash = await this.replayWitness(target.config, harness, witnessPath).catch((error: unknown) => {
          evidence.push({
            stage: "execute" as const,
            status: "inconclusive" as const,
            summary: `witness replay ${witnessPath}: replay build failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
            artifacts: [witnessPath],
          });
          return undefined;
        });
        if (!crash) {
          evidence.push({
            stage: "execute" as const,
            status: "inconclusive" as const,
            summary: `witness replay ${witnessPath}: no sanitizer finding under the target build`,
            artifacts: [witnessPath],
          });
          continue;
        }
        const exploitability = classifyUserspacePrimitive(crash);
        const verdict = memCorruptionVerdict(crash);
        witnessDetails.push({ finding: crashArtifactToFinding(crash, harness.memTarget, exploitability, verdict), crash, exploitability, verdict });
        const witnessMitigation = await this.replayMitigation(target.config, harness, witnessPath, ctx);
        evidence.push({
          stage: "execute" as const,
          status: verdict.verdict === "confirmed" ? "passed" as const : "inconclusive" as const,
          summary: `witness replay ${witnessPath}: ${verdict.reasoning}` +
            (witnessMitigation ? (witnessMitigation.sanitizerHit ? "; mitigation FAILED under same witness" : "; mitigation clean under same witness") : ""),
          data: { crash, verdict, ...(witnessMitigation ? { mitigation: witnessMitigation } : {}) },
          artifacts: [witnessPath],
        });
      }
      items.push({
        candidateId: harness.candidateId,
        ...(witnessDetails.length > 0 ? { witnessDetails } : {}),
      });
    }
    return { items, evidence, warnings };
  }

  /**
   * Emit a standalone main() replay harness. Witness/mitigation replay needs
   * only ASan/UBSan — never the libFuzzer runtime, which is unavailable on
   * stock Xcode clang and unnecessary for deterministic single-input replay.
   */
  private emitReplayHarness(fn: FunctionSignature): string {
    const shape = fn.inputShape ?? "bytesAndLen";
    const call = shape === "bytesPtr"
      ? `  (void)${fn.functionName}(data);`
      : shape === "bytesAndLenOut"
        ? `  uint8_t *out = NULL; size_t out_size = 0;\n  int rc = ${fn.functionName}(data, (size_t)n, &out, &out_size);\n  free(out);\n  (void)rc;`
        : `  (void)${fn.functionName}(data, (size_t)n);`;
    return [
      `// 0 counterexample witness-replay harness — generated, ASan/UBSan only.`,
      `#include "${fn.header}"`,
      "#include <stdlib.h>",
      "#include <stdio.h>",
      "int main(int argc, char **argv) {",
      "  if (argc != 2) return 64;",
      '  FILE *f = fopen(argv[1], "rb"); if (!f) return 65;',
      "  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);",
      "  uint8_t *data = malloc((size_t)n > 0 ? (size_t)n : 1); if (!data) return 66;",
      "  if (fread(data, 1, (size_t)n, f) != (size_t)n) return 67;",
      "  fclose(f);",
      call,
      "  free(data);",
      "  return 0;",
      "}",
      "",
    ].join("\n");
  }

  private async buildReplayBinary(
    fn: FunctionSignature,
    harness: CounterexampleHarnessPlan,
    sources: string[],
    outputPath: string,
  ): Promise<void> {
    const { writeFileSync } = await import("node:fs");
    const harnessSource = join(dirname(outputPath), "witness-replay-main.c");
    writeFileSync(harnessSource, this.emitReplayHarness(fn), { mode: 0o600 });
    const includes = [...harness.tier2Artifact.compile_command.matchAll(/-I(\S+)/g)].map(match => match[1]!);
    await this.exec("clang", [
      "-O1", "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
      ...includes.map(dir => `-I${dir}`),
      harnessSource,
      ...sources,
      "-o", outputPath,
    ], { timeout: 120_000 });
  }

  /** Run one finding-proposed input through the compiled sanitizer harness. */
  private async replayWitness(
    config: CounterexampleTargetConfig,
    harness: CounterexampleHarnessPlan,
    witnessPath: string,
  ): Promise<CrashArtifact | undefined> {
    const binary = join(dirname(harness.tier2Artifact.harness_path), "witness-replay");
    // The mitigation is a second implementation of the same symbol; never link
    // it into the vulnerable witness build even if it lives in the target tree.
    const mitigationSources = new Set((config.mitigation?.sourceFiles ?? []).map(file =>
      file.startsWith("/") ? file : join(config.sourceRoot, file)));
    const vulnerableSources = harness.tier2Artifact.linked_objects.filter(object => !mitigationSources.has(object));
    await this.buildReplayBinary(config.suspectFunction, harness, vulnerableSources, binary);
    try {
      await this.exec(binary, [witnessPath], { timeout: 30_000, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" } });
      return undefined;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      const crash = parseCrashOutput(`${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, { inputPath: witnessPath });
      return crash ?? undefined;
    }
  }

  private async replayMitigation(
    config: CounterexampleTargetConfig,
    harness: CounterexampleHarnessPlan,
    crashInput: string,
    ctx: ResearchContext,
  ): Promise<CounterexampleMitigationReplay | undefined> {
    const mitigation = config.mitigation;
    if (!mitigation || ctx.signal?.aborted) return undefined;
    const sourceRoot = config.sourceRoot;
    const resolveFrom = (p: string) => p.startsWith("/") ? p : join(sourceRoot, p);
    const binary = join(this.scratchRoot(config.sourceRoot, ctx), "mitigation-harness");
    try {
      await this.buildReplayBinary(config.suspectFunction, harness, mitigation.sourceFiles.map(resolveFrom), binary);
    } catch (error) {
      ctx.log(`mitigation build failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    try {
      await this.exec(binary, [crashInput], { timeout: 30_000, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" } });
      return { binary, crashInput, exitCode: 0, sanitizerHit: false };
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string };
      const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
      return { binary, crashInput, exitCode: failure.status ?? null, sanitizerHit: /AddressSanitizer|runtime error/.test(output) };
    }
  }

  async verify(
    _target: CounterexampleTarget,
    input: { candidates: CounterexampleCandidate[]; executions?: CounterexampleExecution[] },
  ): Promise<ResearchStageResult<ResearchFinding>> {
    const items: ResearchFinding[] = [];
    const evidence: ResearchEvidence[] = [];
    for (const execution of input.executions ?? []) {
      const details = execution.witnessDetails ?? [];
      for (const detail of details) {
        const passed = detail.verdict.verdict === "confirmed";
        evidence.push({
          stage: "verify" as const,
          status: passed ? "passed" as const : "inconclusive" as const,
          summary: detail.verdict.reasoning,
          data: detail,
          ...(detail.crash.inputPath ? { artifacts: [detail.crash.inputPath] } : {}),
        });
        if (!passed) continue;
        items.push({
          finding: detail.finding,
          candidateId: execution.candidateId,
          grade: "observed",
          evidence: [{
            stage: "verify",
            status: "passed",
            summary: detail.verdict.reasoning,
            data: { crash: detail.crash, exploitability: detail.exploitability, verdict: detail.verdict },
            ...(detail.crash.inputPath ? { artifacts: [detail.crash.inputPath] } : {}),
          }],
        });
      }
      if (details.length === 0) {
        evidence.push({
          stage: "verify",
          status: "inconclusive",
          summary: "no counterexample found within the bounded witness set; absence is not proven",
        });
      }
    }
    return { items, evidence };
  }
}

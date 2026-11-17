import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import type { Finding } from "@0/engine/shared";
import {
  createRuntime,
  runSourceFix, isPinnedImage, verificationLine, budgetNativeRuntime, workflowPolicyRuntime,
  type NativeRuntime,
  type RuntimeType,
  type SourceFixResult,
} from "@0/engine";
import { z } from "zod";
import { findingSchema, formatZodError } from "@0/engine/shared";
import { executeManagedOperation } from "../managed-operation.js";
import { loadFindingFocus } from "../finding-focus.js";

type FixRuntimeType = Extract<RuntimeType, "api">;

const FIX_RUNTIMES: Record<FixRuntimeType, true> = {
  api: true,
};

interface FixOptions {
  finding?: string;
  findingId?: string;
  dbPath?: string;
  verificationResult?: string;
  testCommand: string;
  verifyImage?: string;
  runtime: string;
  model?: string;
  apiKey?: string;
  timeout: string;
  testTimeout: string;
  maxAttempts: string;
  apply?: boolean;
  output?: string;
  costCeiling?: string;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function isNativeRuntime(runtime: unknown): runtime is NativeRuntime {
  return typeof (runtime as Partial<NativeRuntime>)?.executeNative === "function";
}

async function loadFinding(path: string): Promise<Finding> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`failed to read finding JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return findingSchema.parse(raw) as Finding;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(formatZodError(error, "finding JSON"));
    }
    throw error;
  }
}

async function loadVerificationResult(path: string): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`failed to read verification result JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = z.object({ status: z.string().min(1) }).passthrough().safeParse(raw);
  if (!parsed.success) {
    throw new Error(formatZodError(parsed.error, "verification result JSON"));
  }
  return parsed.data;
}
async function resolveFixFinding(opts: FixOptions): Promise<Finding> {
  const findingPath = opts.finding?.trim();
  const findingId = opts.findingId?.trim();
  if (findingPath && findingId) {
    throw new Error("Pass exactly one of --finding <path> or --finding-id <id>.");
  }
  if (!findingPath && !findingId) {
    throw new Error("Pass one of --finding <path> or --finding-id <id>.");
  }
  if (opts.dbPath && !findingId) {
    throw new Error("--db-path is only valid with --finding-id.");
  }
  return findingPath
    ? loadFinding(findingPath)
    : loadFindingFocus(findingId!, { dbPath: opts.dbPath }).finding;
}

function selectedRuntime(value: string): FixRuntimeType {
  const resolved = value === "auto" ? "api" : value;
  if (!Object.hasOwn(FIX_RUNTIMES, resolved)) {
    throw new Error(`invalid --runtime '${value}'; supported: auto, ${Object.keys(FIX_RUNTIMES).join(", ")}`);
  }
  return resolved as FixRuntimeType;
}

function createFixRuntime(
  type: FixRuntimeType,
  opts: { timeout: number; model?: string; apiKey?: string },
): NativeRuntime {
  const runtime = createRuntime({
    type,
    timeout: opts.timeout,
    model: opts.model,
    apiKey: opts.apiKey,
  });
  if (!isNativeRuntime(runtime)) {
    throw new Error(`runtime '${type}' does not support structured source remediation`);
  }
  return runtime;
}

async function writePatch(path: string, patch: string): Promise<void> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${patch}\n`, "utf8");
}

function exitCodeFor(result: SourceFixResult): number {
  switch (result.status) {
    case "validated_candidate":
    case "applied_and_retested":
      return 0;
    case "not_fixed":
      return 1;
    case "precondition_failed":
    case "error":
      return 2;
  }
}

export function registerFixCommand(program: Command): void {
  program
    .command("fix")
    .description("Generate and optionally apply a fix for one reproduced finding")
    .argument("<repo>", "Clean local Git worktree containing the affected source file")
    .option("--finding <path>", "Path to an external finding JSON with verificationSpec")
    .option("--finding-id <id>", "Persisted finding ID (full ID or unique prefix)")
    .option("--db-path <path>", "Database containing --finding-id")
    .option("--verification-result <path>", "Optional verification_result JSON from `0 scan verify`; required when the finding does not already carry one")
    .requiredOption("--test-command <command>", "Explicit regression command to run in the isolated candidate worktree")
    .option("--verify-image <image>", "Run --test-command in this digest-pinned container image with the network off; without it the command runs on this machine and the fix is never labelled Verified")
    .option("--runtime <runtime>", "Fix runtime: auto or api", "auto")
    .option("-m, --model <model>", "Model identifier for the selected runtime")
    .option("--api-key <key>", "API key for the selected runtime")
    .option("--timeout <ms>", "Per-model-call timeout in milliseconds", "600000")
    .option("--test-timeout <ms>", "Regression-command timeout in milliseconds", "300000")
    .option("--max-attempts <n>", "Maximum candidate patches; capped at 3", "3")
    .option("--apply", "Apply only a patch that passed isolated source recheck and regression command", false)
    .option("--output <path>", "Write the validated apply_patch DSL to this path")
    .option("--cost-ceiling <usd>", "Stop asking the model for patches once the estimated cost reaches this many USD")
    .action(async (repo: string, opts: FixOptions) => {
      const runtimeType = selectedRuntime(opts.runtime);
      const timeout = parsePositiveInteger(opts.timeout, "--timeout");
      const testTimeoutMs = parsePositiveInteger(opts.testTimeout, "--test-timeout");
      const maxAttempts = parsePositiveInteger(opts.maxAttempts, "--max-attempts");
      if (opts.verifyImage && !isPinnedImage(opts.verifyImage)) throw new Error("--verify-image must be pinned by digest (name@sha256:<64 hex>)");
      const costCapUsd = opts.costCeiling === undefined ? undefined : Number(opts.costCeiling);
      if (costCapUsd !== undefined && (!Number.isFinite(costCapUsd) || costCapUsd <= 0)) throw new Error("--cost-ceiling must be a positive number of US dollars");
      const finding = await resolveFixFinding(opts);
      if (opts.verificationResult) {
        Object.assign(finding as unknown as Record<string, unknown>, {
          verification_result: await loadVerificationResult(opts.verificationResult),
        });
      }
      const runtime = createFixRuntime(runtimeType, {
        timeout,
        model: opts.model,
        apiKey: opts.apiKey,
      });
      if (!(await runtime.isAvailable())) {
        throw new Error(`runtime '${runtimeType}' is not available`);
      }

      let costUsd: number | undefined;
      const result = await executeManagedOperation({
        type: "fix", name: opts.apply ? "Source fix and explicit repository application" : "Source fix candidate and regression check",
        fixMode: opts.apply ? "apply" : "candidate", target: resolve(repo),
        timeCapMs: Math.min(86_400_000, (timeout + testTimeoutMs) * Math.min(maxAttempts, 3) + 60_000),
        ...(costCapUsd === undefined ? {} : { costCapUsd }),
        inputs: { findingId: finding.id, testCommand: opts.testCommand, maxAttempts, testTimeoutMs },
        status: (result: SourceFixResult) => result.status === "error" || result.status === "precondition_failed" ? "failed" : "completed",
        execute: async context => { try { return await runSourceFix({
        repoRoot: resolve(repo),
        finding,
        runtime: workflowPolicyRuntime(budgetNativeRuntime(runtime, context.costLedger, context.signal, context.plan.costCapUsd, context.plan)),
        signal: context.signal,
        testCommand: opts.testCommand,
        ...(opts.verifyImage ? { verifyImage: opts.verifyImage } : {}),
        apply: opts.apply,
        maxAttempts,
        testTimeoutMs,
        }); } finally { costUsd = context.costLedger.totalCostUsd(); } },
      });

      if (opts.output && result.patch) {
        await writePatch(opts.output, result.patch);
      }

      if (result.test) process.stderr.write(`${result.verification ? verificationLine(result.verification) : "Not verified: no check was recorded"}\n`);
      if (result.status === "validated_candidate" || result.status === "applied_and_retested") {
        process.stderr.write(`Fix for ${result.sourceFile} ${result.applied ? "applied to your working tree" : "not applied yet"}${opts.output && result.patch ? `; patch written to ${resolve(opts.output)}` : ""}.\n`);
      } else if (result.status === "error" && /cost ceiling exceeded/i.test(result.error ?? "")) {
        process.stderr.write(`Stopped at the cost ceiling${costCapUsd === undefined ? "" : ` of $${costCapUsd}`} before a fix was accepted. Raise --cost-ceiling to let it try again.\n`);
      } else {
        process.stderr.write(`No fix was accepted (${result.status}). Each attempt's reason is under "attempts" in the result below.\n`);
      }
      if (costUsd !== undefined) process.stderr.write(`Estimated model cost: $${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = exitCodeFor(result);
    });
}

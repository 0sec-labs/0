/**
 * Verifier orchestration. The HARNESS calls this after the agent claims it is
 * done; the model cannot. Steps run through a ContainerRunner port, on
 * snapshots of the working tree, never on the live checkout.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { redactContent } from "../telemetry/redaction.js";
import type { ContainerRunner, StepOutcome } from "./port.js";
import { LOG_TAIL_BYTES, tailOf, type VerifierResult } from "./result.js";
import { imageDigest, type VerifySpec, type VerifyStep } from "./spec.js";

export interface RunVerifierInput {
  spec: VerifySpec;
  /** Snapshot of the post-change tree. */
  afterDir: string;
  /** Snapshot of the tree before the change; required when the spec compares against a baseline. */
  beforeDir?: string;
  runner: ContainerRunner;
  skillId?: string;
  signal?: AbortSignal;
}

const commandOf = (spec: VerifySpec): string => spec.steps.map((s) => s.run).join(" && ");
const redactTail = (text: string): string => tailOf(redactContent(tailOf(text, LOG_TAIL_BYTES * 2), { maxChars: LOG_TAIL_BYTES * 4 }));

function counted(step: StepOutcome, metric: string | undefined): number {
  if (metric) {
    const match = new RegExp(metric, "m").exec(step.output);
    if (match?.[1] !== undefined && /^\d+$/.test(match[1])) return Number.parseInt(match[1], 10);
  }
  return step.exitCode === 0 ? 0 : 1;
}

async function runSteps(input: RunVerifierInput, dir: string, steps: VerifyStep[]): Promise<StepOutcome[]> {
  const { spec, runner } = input;
  const out: StepOutcome[] = [];
  for (const step of steps) {
    const outcome = await runner.run({
      image: step.image ?? spec.image, dir, command: step.run, network: spec.network,
      ...(spec.setup ? { setup: spec.setup } : {}), timeoutMs: spec.timeoutSec * 1000, ...(input.signal ? { signal: input.signal } : {}),
    });
    out.push(outcome);
    if (outcome.infraError || outcome.timedOut) break;
  }
  return out;
}

export async function runVerifier(input: RunVerifierInput): Promise<VerifierResult> {
  const { spec, runner } = input;
  const startedAt = Date.now();
  const base = {
    schemaVersion: 1 as const, command: commandOf(spec), isolation: runner.isolation,
    ...(input.skillId ? { skillId: input.skillId } : {}),
    ...(spec.image ? { imageDigest: imageDigest(spec.image) } : {}),
  };
  const done = (status: VerifierResult["status"], reason: string, logTail = "", canary: VerifierResult["canary"] = "n/a", extra: Partial<VerifierResult> = {}): VerifierResult =>
    ({ ...base, status, reason, durationMs: Date.now() - startedAt, logTail, canary, ...extra });

  const probe = await runner.probe();
  if (!probe.ok) return done("not-run", "no-container-runtime", probe.reason);
  if (spec.success.baseline && !input.beforeDir) return done("not-run", "no-baseline");

  let canary: VerifierResult["canary"] = "n/a";
  if (spec.canary) {
    const step = spec.steps.find((s) => s.name === spec.canary!.step)!;
    const scratch = mkdtempSync(join(tmpdir(), "0-verify-canary-"));
    try {
      cpSync(input.afterDir, scratch, { recursive: true, verbatimSymlinks: true });
      const target = join(scratch, spec.canary.file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, spec.canary.content);
      const [outcome] = await runSteps(input, scratch, [step]);
      if (!outcome || outcome.infraError) return done("error", "infra-error", redactTail(outcome?.infraError ?? ""));
      if (outcome.timedOut) return done("error", "timeout", redactTail(outcome.output));
      const flagged = spec.canary.expect ? new RegExp(spec.canary.expect, "m").test(outcome.output) : outcome.exitCode !== 0;
      if (!flagged) return done("fail", "detector-did-not-run", redactTail(outcome.output), "missing");
      canary = "ok";
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }

  let before: number | undefined;
  if (spec.success.baseline && input.beforeDir) {
    const outcomes = await runSteps(input, input.beforeDir, spec.steps);
    const bad = outcomes.find((o) => o.infraError || o.timedOut);
    if (bad || outcomes.length < spec.steps.length) return done("error", bad?.timedOut ? "timeout" : "infra-error", redactTail(bad?.infraError ?? bad?.output ?? ""), canary);
    before = outcomes.reduce((sum, o) => sum + counted(o, spec.success.metric), 0);
  }

  const after = await runSteps(input, input.afterDir, spec.steps);
  const log = after.map((o) => o.output).join("\n");
  const bad = after.find((o) => o.infraError || o.timedOut);
  if (bad || after.length < spec.steps.length) {
    return done("error", bad?.timedOut ? "timeout" : "infra-error", redactTail(bad?.infraError ?? log), canary);
  }
  const total = after.reduce((sum, o) => sum + o.durationMs, 0);
  const exitCode = after.find((o) => o.exitCode !== 0)?.exitCode ?? 0;
  const finish = (status: "pass" | "fail", reason: string, extra: Partial<VerifierResult> = {}) => ({ ...done(status, reason, redactTail(log), canary, { exitCode, ...extra }), durationMs: total });

  const baseline = before !== undefined ? { before, after: after.reduce((sum, o) => sum + counted(o, spec.success.metric), 0) } : undefined;
  const extra = baseline ? { baseline } : {};
  if (spec.success.exit0) {
    const failed = after.findIndex((o) => o.exitCode !== 0);
    if (failed >= 0) return finish("fail", `step-failed:${spec.steps[failed]!.name}`, extra);
  }
  if (spec.success.regex && !new RegExp(spec.success.regex, "m").test(log)) return finish("fail", "output-did-not-match", extra);
  if (baseline && baseline.after > baseline.before) return finish("fail", "worse-than-baseline", extra);
  if (baseline && spec.success.baseline === "improves" && baseline.before > 0 && baseline.after >= baseline.before) return finish("fail", "no-improvement", extra);
  return finish("pass", "criteria-met", extra);
}

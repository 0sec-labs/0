import type { ScanConfig, ScanReport } from "../shared/index.js";
import type { RuntimeMode } from "../shared/index.js";
import type { ScanListener } from "../scanner.js";
import { runMemSafetyScan } from "../stages/memsafety-scan.js";
import type { MemSafetyScanOptions } from "../stages/memsafety-scan.js";
import type { MemSafetyTarget } from "../triage/memsafety-types.js";
import { runCraftScan } from "../stages/craft-scan.js";
import type { CraftTarget, CraftScanOptions } from "../stages/craft-scan.js";
import { runEnsembleCraft, resolveEnsembleModels } from "../stages/ensemble-craft.js";

/**
 * Run a full agentic scan with multi-turn agents, tool use, and persistent state.
 *
 * Pipeline:
 * - Discovery Agent: probes target, maps endpoints, builds profile
 * - Attack Agent: runs attacks with adaptation and multi-turn escalation
 * - Verification Agent: replays and confirms findings
 * - Report Agent: generates summary
 *
 * When ANTHROPIC_API_KEY is set, uses the native Claude Messages API with
 * structured tool_use for reliable tool execution. Otherwise, falls back to
 * the legacy text-based agent loop via subprocess runtimes.
 *
 * All findings persist to SQLite between stages and across scans.
 * Sessions are saved so interrupted scans can be resumed.
 */
/**
 * Memory-safety scan dispatch ("Monty-mode", 0#700). Adapts the focused
 * `runMemSafetyScan` stage result into the unified `ScanReport` the rest of the
 * product consumes. Lives here only as the thin bridge between the scan entry
 * point and the stage module; all real orchestration is in
 * `stages/memsafety-scan.ts`. Does no DB / runtime / live-target work — the
 * fuzz loop owns its own (artifact-dir-scoped) side effects and degrades
 * honestly when tooling is absent.
 */
export async function runMemSafetyScanStage(
  config: ScanConfig,
  target: MemSafetyTarget,
  memSafety: Omit<MemSafetyScanOptions, "target"> | undefined,
  emit: ScanListener,
): Promise<ScanReport> {
  const startedAt = Date.now();
  emit({
    type: "stage:start",
    stage: "attack",
    message: `Memory-safety scan: ${target.language} target at ${target.sourceRoot}`,
  });

  const result = await runMemSafetyScan({ ...memSafety, target });

  for (const finding of result.findings) {
    emit({ type: "finding", message: finding.title, data: finding });
  }

  const completedAt = Date.now();
  const findings = result.findings;
  const summary = {
    totalAttacks: result.loop.iterations,
    totalFindings: findings.length,
    critical: findings.filter((f) => f.severity === "critical").length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    info: findings.filter((f) => f.severity === "info").length,
  };

  emit({
    type: "stage:end",
    stage: "attack",
    message:
      result.toolingMissing.length > 0
        ? `Memory-safety scan could not run (missing: ${result.toolingMissing.join(", ")})`
        : `Memory-safety scan complete: ${findings.length} finding(s)`,
  });

  return {
    target: config.target || target.sourceRoot,
    scanDepth: config.depth,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - startedAt,
    summary,
    findings,
    warnings: result.warnings.map((message) => ({
      stage: "attack" as const,
      message,
    })),
  };
}

/**
 * Craft scan dispatch — adapts `runCraftScan` into the unified `ScanReport`,
 * mirroring `runMemSafetyScanStage`. The PoC oracle lives in `craft.evaluatePoc`
 * (injected by the caller); this bridge does no I/O of its own.
 */
export async function runCraftScanStage(
  config: ScanConfig,
  target: CraftTarget,
  craft: Omit<CraftScanOptions, "target" | "runtime">,
  emit: ScanListener,
): Promise<ScanReport> {
  const startedAt = Date.now();
  emit({
    type: "stage:start",
    stage: "attack",
    message: `Craft scan: ${target.language ?? "c"} target at ${target.sourceRoot}`,
  });

  const runtime = ((config as { runtime?: RuntimeMode }).runtime ?? "auto") as RuntimeMode;
  const model = craft.model ?? (config as { model?: string }).model;
  const log = (message: string) => emit({ type: "thinking", message });
  const craftOptions = {
    ...craft,
    ...(config.costCeilingUsd !== undefined
      ? { costCeilingUsd: config.costCeilingUsd }
      : {}),
  };

  // Ensemble craft opt-in (OFF by default): when ZERO_ENSEMBLE_MODELS lists
  // more than one model, run N parallel craft trajectories across those models
  // and LLM-judge them down to one PoC. Unset / single model → the single-model
  // craft path below, byte-for-byte unchanged. `runEnsembleCraft` returns a
  // normal CraftScanResult, so the adaptation below is identical either way.
  const ensembleModels = resolveEnsembleModels();
  const result =
    ensembleModels.length > 1
      ? await runEnsembleCraft({
          target,
          runtime,
          n: ensembleModels.length,
          models: ensembleModels,
          // `model` is per-trajectory in the ensemble; strip the single-model knob.
          craft: (({ model: _drop, ...rest }) => rest)(craftOptions),
          ...(model ? { judgeModel: model } : {}),
          log,
        })
      : await runCraftScan({
          ...craftOptions,
          ...(model ? { model } : {}),
          target,
          runtime,
          log,
        });

  for (const finding of result.findings) {
    emit({ type: "finding", message: finding.title, data: finding });
  }

  const completedAt = Date.now();
  const findings = result.findings;
  const summary = {
    totalAttacks: result.submits,
    totalFindings: findings.length,
    critical: findings.filter((f) => f.severity === "critical").length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    info: findings.filter((f) => f.severity === "info").length,
  };

  emit({
    type: "stage:end",
    stage: "attack",
    message: result.passed
      ? `Craft scan: confirmed PoC in ${result.submits} submit(s)`
      : `Craft scan: no confirmed PoC (${result.warnings[result.warnings.length - 1] ?? "no candidate"})`,
  });

  return {
    target: config.target || target.sourceRoot,
    scanDepth: config.depth,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - startedAt,
    summary,
    findings,
    warnings: result.warnings.map((message) => ({ stage: "attack" as const, message })),
    trace: [
      { type: "craft_attempts", attempts: result.attempts },
      ...(result.evidence && result.evidence.length > 0
        ? [{ type: "craft_evidence", records: result.evidence }]
        : []),
    ],
    benchmarkMeta: {
      attackTurns: result.steps,
      model: result.model,
      craftSubmits: result.submits,
      craftPassed: result.passed,
      craftFirstSubmitPassed: result.firstSubmitPassed,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
    },
    ...(result.costCeilingExceeded
      ? { costCeilingExceeded: true, exitReason: "cost_ceiling_exceeded" as const }
      : {}),
  };
}

/**
 * Parse a resolved package target of the shape `eco:name@version` (e.g.
 * `npm:lodash@4.17.4`, `pypi:requests@2.31.0`) that the unified pipeline emits
 * as `resolvedTarget`. Returns the OSS ecosystem / package name / version for
 * the #851 novelty gate, or undefined when the target is not a package
 * (URLs, bare hostnames, repo paths). Pure and conservative — a target it
 * cannot confidently parse yields undefined, so the gate stays a safe no-op.
 */
export function parsePackageTarget(
  target: string,
): { ecosystem: string; name: string; version?: string } | undefined {
  const m = /^(npm|pypi|cargo|go|maven):(.+)$/.exec(target.trim());
  if (!m) return undefined;
  const ecosystem = m[1];
  const rest = m[2];
  // Split name@version, honoring npm scoped names (@scope/pkg@version): the
  // version `@` is the LAST one, and only when it follows a non-`/` char.
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    return { ecosystem, name: rest.slice(0, at), version: rest.slice(at + 1) || undefined };
  }
  return { ecosystem, name: rest };
}

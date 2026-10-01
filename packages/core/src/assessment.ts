import { validateScanPlan, type RuntimeMode, type ScanReport, type SecurityWorkflowInput } from "@0/shared";
import { agenticScan } from "./agentic-scanner.js";
import { runPipeline, type PipelineOptions, type PipelineReport } from "./unified-pipeline.js";
import { branchJournal } from "./agent/journal/index.js";
import { executeWorkflow, type WorkflowRunResult } from "./workflow-runner.js";
import { workflowPolicyRuntime } from "./workflow-execution-policy.js";

/** Execution options owned by core; no terminal UI, publication, or process-exit policy. */
export interface AssessmentOptions extends PipelineOptions {
  runtime: RuntimeMode;
  timeout: number;
  /** Fork an existing assessment journal before resuming it. */
  branchFromEntry?: number;
}

export interface AssessmentResult {
  /** Canonical report consumed by workflow steps and embedded callers. */
  report: ScanReport;
  /** Original target-specific report retained for legacy CLI formatters. */
  rawReport: PipelineReport | ScanReport;
  /** Present when the assessment ran through the managed workflow boundary. */
  workflowRun?: WorkflowRunResult;
}

export interface AssessmentRunLifecycle {
  onStart?: (snapshot: SecurityWorkflowInput) => void;
  onComplete?: (result: WorkflowRunResult) => void;
}

/** Dependency injection keeps adapter tests independent of actual scanners. */
export interface AssessmentDependencies {
  agenticScan: typeof agenticScan;
  runPipeline: typeof runPipeline;
  branchJournal: typeof branchJournal;
}

export function toAssessmentReport(report: PipelineReport | ScanReport): ScanReport {
  const legacy = report as PipelineReport;
  const execution = {
    plan: report.plan, plannedRuns: report.plannedRuns, completedRuns: report.completedRuns, attempts: report.attempts,
    estimatedCostUsd: report.estimatedCostUsd, usage: report.usage, exitReason: report.exitReason,
    costCeilingExceeded: report.costCeilingExceeded, executionSuccessful: report.executionSuccessful ?? (legacy.researchFailed ? false : undefined),
    error: report.error,
    reviewChecks: report.reviewChecks,
  };
  if (legacy.targetType === "npm-package" || legacy.targetType === "pypi-package" || legacy.targetType === "cargo-package" || legacy.targetType === "oci-image") {
    return {
      target: legacy.package ? `${legacy.package}@${legacy.version}` : legacy.target,
      scanDepth: report.plan?.depth ?? "deep",
      startedAt: report.startedAt,
      completedAt: report.completedAt,
      durationMs: report.durationMs,
      summary: report.summary,
      findings: report.findings,
      warnings: (report.warnings ?? []) as ScanReport["warnings"],
      ...execution,
    };
  }

  if (legacy.targetType === "source-code") {
    return {
      target: legacy.repo ?? legacy.target,
      scanDepth: report.plan?.depth ?? "deep",
      startedAt: report.startedAt,
      completedAt: report.completedAt,
      durationMs: report.durationMs,
      summary: report.summary,
      findings: report.findings,
      warnings: (report.warnings ?? []) as ScanReport["warnings"],
      ...execution,
    };
  }

  return report as ScanReport;
}

/** Execute one assessment without printing, opening reports, or terminating its host. */
export async function executeAssessment(
  opts: AssessmentOptions,
  dependencies: AssessmentDependencies = { agenticScan, runPipeline, branchJournal },
): Promise<AssessmentResult> {
  if (opts.plan) validateScanPlan(opts.plan);
  if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Assessment cancelled");
  const planCostCap = opts.plan?.costCapUsd;
  const costCeilingUsd = planCostCap === undefined || opts.costCeilingUsd === undefined
    ? opts.costCeilingUsd ?? planCostCap
    : Math.min(opts.costCeilingUsd, planCostCap);
  let resumeScanId = opts.resumeScanId;
  if (opts.branchFromEntry !== undefined) {
    if (!resumeScanId) throw new Error("--branch-from requires --resume <run-id>");
    resumeScanId = dependencies.branchJournal({ runId: resumeScanId, fromEntry: opts.branchFromEntry }).newRunId;
  }
  const { branchFromEntry: _branch, ...execution } = opts;
  const effective: PipelineOptions = {
    ...execution,
    ...(opts.nativeRuntime ? { nativeRuntime: workflowPolicyRuntime(opts.nativeRuntime) } : {}),
    resumeScanId,
    depth: opts.plan?.depth ?? opts.depth,
    timeout: Math.min(opts.plan?.timeCapMs ?? opts.timeout, opts.timeout),
    costCeilingUsd,
  };
  let rawReport: PipelineReport | ScanReport;
  if (opts.targetType === "url" || opts.targetType === "web-app") {
    const {
      nativeRuntime, provider, scope, dbPath, onEvent, getPendingUserMessages,
      resumeScanId: effectiveResumeScanId, runId, emitTerminalEvent,
      ...config
    } = effective;
    rawReport = await dependencies.agenticScan({
      config: { ...config, mode: opts.mode ?? "deep" },
      nativeRuntime, provider, scope, dbPath, onEvent, getPendingUserMessages,
      resumeScanId: effectiveResumeScanId, runId, emitTerminalEvent,
    });
  } else {
    rawReport = await dependencies.runPipeline(effective);
  }
  return { report: toAssessmentReport(rawReport), rawReport };
}

/** CLI shortcuts and other standalone assessments are one-step managed workflow runs. */
export async function executeAssessmentRun(
  opts: AssessmentOptions,
  dependencies?: AssessmentDependencies,
  lifecycle?: AssessmentRunLifecycle,
): Promise<AssessmentResult> {
  if (opts.plan) validateScanPlan(opts.plan);
  const caps = [opts.costCeilingUsd, opts.plan?.costCapUsd].filter((cap): cap is number => cap !== undefined);
  const costCapUsd = caps.length ? Math.min(...caps) : Number.MAX_VALUE;
  const timeCapMs = Math.min(opts.timeout, opts.plan?.timeCapMs ?? opts.timeout);
  // The portable definition bounds a step to 24 hours and $1,000. Root limits
  // retain the caller's actual allowance; the original plan stays on the executor.
  const stepPlan = {
    goal: opts.plan?.goal ?? "unknown-vulnerabilities" as const,
    depth: opts.plan?.depth ?? opts.depth,
    runCount: 1,
    executionMode: "sequential" as const,
    timeCapMs: Math.min(timeCapMs, 86_400_000),
    costCapUsd: Math.max(Number.MIN_VALUE, Math.min(costCapUsd - (opts.costLedger?.totalCostUsd() ?? 0), 1_000)),
  };
  let assessment: AssessmentResult | undefined;
  const workflow: SecurityWorkflowInput = {
      name: "Assessment", instructions: "", target: opts.target,
      nodes: [
        { id: "start", type: "trigger", label: "Start", enabled: true },
        { id: "assessment", type: "audit", label: "Assessment", enabled: true, plan: stepPlan },
      ],
      edges: [{ source: "start", target: "assessment" }],
  };
  lifecycle?.onStart?.(structuredClone(workflow));
  const run = await executeWorkflow({
    workflow,
    signal: opts.signal,
    timeCapMs,
    costCapUsd,
    costLedger: opts.costLedger,
    executeAssessment: async context => {
      assessment = await executeAssessment({
        ...opts,
        // Preserve the legacy single-run strategy when no guided plan was requested.
        timeout: Math.max(1, Math.min(opts.timeout, context.deadline - Date.now())),
        signal: context.signal,
        costLedger: context.costLedger,
      }, dependencies);
      return { status: assessment.report.executionSuccessful === false ? "failed" : "completed", reports: [assessment.report] };
    },
  });
  lifecycle?.onComplete?.(run);
  if (!assessment) throw new Error(run.error ?? "Assessment did not produce a report.");
  if (run.status !== "completed" && assessment.report.executionSuccessful !== false && !assessment.report.costCeilingExceeded) {
    const knownCost = opts.costLedger?.hasUnpricedUsage() ? undefined : opts.costLedger?.totalCostUsd() ?? run.costUsd;
    const costCeilingExceeded = knownCost !== undefined && knownCost >= costCapUsd;
    const outcome = { executionSuccessful: false, error: run.error,
      exitReason: costCeilingExceeded ? "cost_ceiling_exceeded" as const : run.status === "cancelled" ? "cancelled" as const
        : run.error?.includes("deadline exceeded") ? "time_cap_exceeded" as const : "failed" as const,
      ...(costCeilingExceeded ? { costCeilingExceeded: true } : {}) };
    assessment = { report: { ...assessment.report, ...outcome }, rawReport: { ...assessment.rawReport, ...outcome } };
  }
  return { ...assessment, workflowRun: run };
}

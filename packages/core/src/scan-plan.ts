import { validateScanPlan } from "@0/shared";
import type { Finding, ScanAttemptOutcome, ScanAttemptStatus, ScanPlan, ScanPlanExecution } from "@0/shared";
import type { NativeRuntime } from "./runtime/types.js";
import { ScanCostLedger, addRuntimeUsage } from "./agent/cost-ledger.js";
import { eventBus } from "./events/bus.js";
import { AsyncLocalStorage } from "node:async_hooks";

const executionBudget = new AsyncLocalStorage<{ signal: AbortSignal; deadline: number }>();
export function scanExecutionSignal(): AbortSignal | undefined {
  return executionBudget.getStore()?.signal;
}

/** Bound synchronous preparation/scanner guests too; each call gets only the remaining plan time. */
export function scanExecutionTimeout(requestedMs: number): number {
  const budget = executionBudget.getStore();
  if (!budget) return requestedMs;
  budget.signal.throwIfAborted();
  const remainingMs = budget.deadline - Date.now();
  if (remainingMs <= 0) throw new ScanBudgetError("time_cap_exceeded", "Scan plan wall-clock limit reached before dispatch.");
  return Math.min(requestedMs, remainingMs);
}

export class ScanBudgetError extends Error {
  constructor(readonly status: "cost_ceiling_exceeded" | "time_cap_exceeded" | "cancelled" | "failed", message: string) {
    super(message);
    this.name = "ScanBudgetError";
  }
}

/** Policy goes into the actual investigator prompt, never only report metadata. */
export function scanGoalPrompt(plan?: ScanPlan): string {
  if (!plan) return "";
  const objective = plan.goal === "known-vulnerabilities"
    ? "Investigate known vulnerabilities: identify exact component versions, match published advisories/CVEs, and reproduce applicability. Prioritize existing advisory and dependency-audit leads; do not spend this run on speculative novel vulnerability hunting."
    : plan.goal === "misconfigurations"
      ? "Investigate security misconfigurations: prioritize exposed services/debug features, unsafe defaults, authentication/authorization configuration, secrets, permissions and deployment trust boundaries. Demonstrate the configured exposure rather than claiming hypothetical vulnerabilities."
      : "Investigate unknown vulnerabilities: prioritize previously unreported logic, authorization, injection and memory-safety flaws. Use known advisories as context, but do not treat a known CVE match alone as completion of this objective.";
  const depth = plan.depth === "quick"
    ? "Use a focused quick pass: highest-risk surfaces first, minimal non-destructive probes and one independent reproduction per credible lead."
    : plan.depth === "default"
      ? "Use a standard pass: cover the relevant attack surfaces and independently reproduce credible leads before reporting."
      : "Use a deep pass: trace trust boundaries and adjacent variants, investigate alternate paths and independently reproduce credible leads within the shared limits.";
  return `\n\n## Operator scan execution policy\n${objective}\n${depth}\nThe shared wall-clock and spend limits include discovery, investigation, verification, reporting and all descendants. Preserve partial evidence when a limit interrupts work.\n`;
}

/** Covers auxiliary model calls as well as loops, retaining the live parent's account and role policy. */
export function budgetNativeRuntime(runtime: NativeRuntime, ledger: ScanCostLedger, signal?: AbortSignal, ceiling?: number, plan?: ScanPlan): NativeRuntime {
  return {
    type: runtime.type,
    outputTokenLimit: runtime.outputTokenLimit,
    isAvailable: () => runtime.isAvailable(),
    resolvedModel: runtime.resolvedModel?.bind(runtime),
    resolvedProvider: runtime.resolvedProvider?.bind(runtime),
    resolvedPricingModel: runtime.resolvedPricingModel?.bind(runtime),
    accessibleModels: runtime.accessibleModels?.bind(runtime),
    reconfigure: runtime.reconfigure?.bind(runtime),
    forkForSubagent: runtime.forkForSubagent
      ? async (timeout, selection) => budgetNativeRuntime(await runtime.forkForSubagent!(timeout, selection), ledger, signal, ceiling, plan)
      : undefined,
    async executeNative(system, messages, tools, callbacks, callSignal) {
      const effectiveSignal = signal && callSignal ? AbortSignal.any([signal, callSignal]) : signal ?? callSignal;
      effectiveSignal?.throwIfAborted();
      if (ceiling !== undefined && ledger.totalCostUsd() >= ceiling) {
        throw new ScanBudgetError("cost_ceiling_exceeded", "Shared scan cost ceiling exhausted before model dispatch.");
      }
      let reportedUsage: { inputTokens: number; outputTokens: number } | undefined;
      const result = await runtime.executeNative(system + scanGoalPrompt(plan), messages, tools, {
        ...callbacks,
        onUsage: usage => { reportedUsage = usage; callbacks?.onUsage?.(usage); },
      }, effectiveSignal);
      if (!result.usage && reportedUsage) result.usage = reportedUsage;
      addRuntimeUsage(ledger, result, runtime.resolvedPricingModel?.() ?? runtime.resolvedModel?.());
      if (plan && !result.usage) {
        ledger.markUnpricedUsage();
        throw new ScanBudgetError("failed", "Runtime did not report usage; cannot safely continue a cost-bounded scan plan.");
      }
      return result;
    },
  };
}

interface ExecutionReport extends ScanPlanExecution {
  target: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  findings: Finding[];
  summary: { totalAttacks: number; totalFindings: number; critical: number; high: number; medium: number; low: number; info: number };
  warnings: Array<{ stage: string; message: string }>;
  exitReason?: string;
  costCeilingExceeded?: boolean;
  executionSuccessful?: boolean;
  researchFailed?: boolean;
}

/** The public core entrypoints own scheduling; CLI and API callers cannot bypass plan limits. */
export async function executeScanPlan<T extends ExecutionReport>(options: {
  plan: ScanPlan;
  ledger?: ScanCostLedger;
  signal?: AbortSignal;
  costCeilingUsd?: number;
  emitTerminalEvent?: boolean;
  onAttempt?: (progress: { runIndex: number; phase: "started" | "settled"; outcome?: ScanAttemptOutcome }) => void;
  emptyReport: () => T;
  dispatch: (attempt: { runIndex: number; plan: ScanPlan; ledger: ScanCostLedger; signal: AbortSignal; costCeilingUsd: number }) => Promise<T>;
}): Promise<T> {
  const { plan } = options;
  validateScanPlan(plan);
  const ledger = (options.ledger ?? new ScanCostLedger()).fork();
  const ceiling = Math.min(options.costCeilingUsd ?? plan.costCapUsd, plan.costCapUsd);
  const startedAt = Date.now();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new ScanBudgetError("time_cap_exceeded", "Scan plan wall-clock limit reached.")), plan.timeCapMs);
  const unsubscribe = ledger.onSpend(() => {
    if (ledger.hasUnpricedUsage() && !controller.signal.aborted) {
      controller.abort(new ScanBudgetError("failed", "Runtime did not report usage; plan spend is unknown."));
    }
    if (ledger.totalCostUsd() >= ceiling && !controller.signal.aborted) {
      controller.abort(new ScanBudgetError("cost_ceiling_exceeded", "Scan plan shared cost ceiling reached."));
    }
  });
  const attempts: ScanAttemptOutcome[] = Array.from({ length: plan.runCount }, (_, index) => ({
    runIndex: index + 1, status: "rejected", durationMs: 0, costUsd: 0,
  }));
  const reports: Array<T | undefined> = new Array(plan.runCount);
  let next = 0;
  const stopStatus = (): ScanAttemptStatus | undefined => {
    if (ledger.totalCostUsd() >= ceiling) return "cost_ceiling_exceeded";
    if (ledger.hasUnpricedUsage()) return "failed";
    if (Date.now() - startedAt >= plan.timeCapMs) return "time_cap_exceeded";
    if (signal.aborted) return signal.reason instanceof ScanBudgetError ? signal.reason.status : "cancelled";
    return undefined;
  };
  const worker = async (): Promise<void> => {
    while (next < plan.runCount) {
      const index = next++;
      const attempt = attempts[index]!;
      const stopped = stopStatus();
      if (stopped) {
        attempt.status = stopped;
        attempt.error = "Attempt not dispatched: shared scan plan limit or cancellation.";
        options.onAttempt?.({ runIndex: attempt.runIndex, phase: "settled", outcome: { ...attempt } });
        continue;
      }
      const runLedger = ledger.fork();
      const runStartedAt = Date.now();
      const remainingMs = plan.timeCapMs - (runStartedAt - startedAt);
      options.onAttempt?.({ runIndex: attempt.runIndex, phase: "started" });
      try {
        const report = await executionBudget.run({ signal, deadline: startedAt + plan.timeCapMs }, () =>
          options.dispatch({ runIndex: index + 1, plan: { ...plan, runCount: 1, timeCapMs: remainingMs }, ledger: runLedger, signal, costCeilingUsd: ceiling }));
        reports[index] = report;
        attempt.status = report.costCeilingExceeded ? "cost_ceiling_exceeded"
          : report.exitReason === "time_cap_exceeded" ? "time_cap_exceeded"
          : report.exitReason === "cancelled" ? "cancelled"
          : report.researchFailed || report.executionSuccessful === false || report.exitReason === "failed" ? "failed"
          : stopStatus() ?? "completed";
        if (attempt.status !== "completed") attempt.error = report.error;
      } catch (error) {
        attempt.status = error instanceof ScanBudgetError ? error.status : stopStatus() ?? "rejected";
        attempt.error = error instanceof Error ? error.message : String(error);
      } finally {
        attempt.durationMs = Date.now() - runStartedAt;
        attempt.costUsd = runLedger.hasUnpricedUsage() ? undefined : runLedger.runCostUsd();
        options.onAttempt?.({ runIndex: attempt.runIndex, phase: "settled", outcome: { ...attempt } });
      }
    }
  };
  try {
    // Bounded fan-out also bounds requests already in flight when spend settles.
    const concurrency = plan.executionMode === "parallel" ? Math.min(3, plan.runCount) : 1;
    await Promise.all(Array.from({ length: concurrency }, worker));
    const fulfilled = reports.filter((report): report is T => report !== undefined);
    const report = { ...(fulfilled[0] ?? options.emptyReport()) };
    report.findings = reports.flatMap((current, index) => current?.findings.map(finding => ({ ...finding, runIndex: index + 1 })) ?? []);
    const keys = ["totalAttacks", "totalFindings", "critical", "high", "medium", "low", "info"] as const;
    report.summary = Object.fromEntries(keys.map(key => [key, fulfilled.reduce((sum, current) => sum + current.summary[key], 0)])) as T["summary"];
    const incomplete = attempts.filter(attempt => attempt.status !== "completed");
    report.warnings = [...fulfilled.flatMap(current => current.warnings), ...incomplete.map(attempt => ({ stage: "report", message: `Run ${attempt.runIndex}/${plan.runCount}: ${attempt.status}${attempt.error ? ` — ${attempt.error}` : ""}. Findings are partial.` }))];
    report.startedAt = new Date(startedAt).toISOString();
    report.completedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    report.plan = plan;
    report.plannedRuns = plan.runCount;
    report.completedRuns = attempts.filter(attempt => attempt.status === "completed").length;
    report.attempts = attempts;
    report.estimatedCostUsd = ledger.hasUnpricedUsage() ? undefined : ledger.runCostUsd();
    report.usage = ledger.tokenUsage();
    report.executionSuccessful = incomplete.length === 0;
    report.costCeilingExceeded = attempts.some(attempt => attempt.status === "cost_ceiling_exceeded");
    report.researchFailed = attempts.some(attempt => attempt.status === "failed" || attempt.status === "rejected");
    report.error = incomplete.length ? incomplete.find(attempt => attempt.error)?.error ?? `Scan plan interrupted: ${incomplete[0]!.status}.` : undefined;
    report.exitReason = report.costCeilingExceeded ? "cost_ceiling_exceeded"
      : attempts.some(attempt => attempt.status === "time_cap_exceeded") ? "time_cap_exceeded"
      : attempts.some(attempt => attempt.status === "cancelled") ? "cancelled"
      : incomplete.length ? "partial" : "completed";
    if (options.emitTerminalEvent !== false) {
      const cost = ledger.hasUnpricedUsage() ? null : ledger.costBreakdown();
      eventBus.emit("scan_completed", {
        exit_reason: report.costCeilingExceeded ? "cost_exceeded" : incomplete.length ? "failed" : "completed",
        duration_ms: report.durationMs, findings_count: report.findings.length,
        summary: `Scan plan ${report.completedRuns}/${plan.runCount} completed; ${report.exitReason}.`,
        ...(cost ? { cost_usd: cost.costUsd, cost_breakdown: cost.breakdown } : {}),
      });
    }
    return report;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

import type { ConsoleSessionSnapshot, ConsoleWorker } from "@0/engine/shared";
import type { FindingGroup } from "@/types";

/** Same pattern as worker-tree.tsx isCancellation (not imported: that module pulls in React components). */
const isCancellation = (text?: string) => Boolean(text && /^(?:This operation was aborted\.?|The operation was aborted\.?|AbortError(?::.*)?|Workbench cancelled.*|Turn cancelled by operator.*)$/i.test(text.trim()));

/** Pure view-model builders for the Overview view and the cost popover. No React, no I/O. */

export type StatusTone = "active" | "attention" | "ok" | "danger" | "muted";
export type StatusSummary = { label: string; tone: StatusTone; detail?: string };

export function statusSummary(snapshot: ConsoleSessionSnapshot): StatusSummary {
  const { status } = snapshot.session;
  const pending = snapshot.pendingDecisions.length;
  if (status === "cancelling") return { label: "Stopping", tone: "attention", detail: snapshot.session.cancellation?.message };
  if (status === "waiting" || (pending > 0 && status === "working")) return { label: "Waiting for you", tone: "attention", detail: pending ? `${pending} pending ${pending === 1 ? "decision" : "decisions"}` : undefined };
  if (status === "working") return { label: "Working", tone: "active" };
  if (status === "failed") return { label: "Failed", tone: "danger", detail: snapshot.lastOutcome?.error };
  if (status === "closed") return { label: "Closed", tone: "muted" };
  return { label: "Ready", tone: "ok" };
}

export function contextUsage(snapshot: ConsoleSessionSnapshot): { used?: number; window?: number; percent?: number } {
  const window = snapshot.contextWindowTokens ?? snapshot.runtime?.contextWindowTokens ?? undefined;
  const used = snapshot.contextInputTokens;
  const percent = used !== undefined && window ? Math.min(100, Math.round(used / window * 100)) : undefined;
  return { used, window, percent };
}

export function formatCost(costUsd: number | undefined): string | undefined {
  return typeof costUsd === "number" && Number.isFinite(costUsd) ? `$${costUsd.toFixed(2)}` : undefined;
}

export type ScopeSummary = { target?: string; inCount: number; outCount: number; enforcement: "enforced" | "not-enforced"; enforcementMessage?: string };
export function scopeSummary(snapshot: ConsoleSessionSnapshot): ScopeSummary {
  return {
    target: snapshot.session.target || undefined,
    inCount: snapshot.scope?.in_scope?.length ?? 0,
    outCount: snapshot.scope?.out_of_scope?.length ?? 0,
    enforcement: snapshot.scopeEnforcement?.enabled ? "enforced" : "not-enforced",
    enforcementMessage: snapshot.scopeEnforcement?.message || undefined,
  };
}

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type SeverityCounts = Record<Severity, number>;

export function normalizeSeverity(value: string): Severity {
  const lower = value.trim().toLowerCase();
  return (SEVERITIES as readonly string[]).includes(lower) ? lower as Severity : lower === "informational" ? "info" : "info";
}

export function severityCounts(groups: readonly FindingGroup[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const group of groups) counts[normalizeSeverity(group.latest.severity)] += 1;
  return counts;
}

/** Newest first by latest timestamp; ties keep input order. */
export function newestFindings(groups: readonly FindingGroup[], limit = 3): FindingGroup[] {
  return groups.map((group, index) => ({ group, index })).sort((a, b) => b.group.latest.timestamp - a.group.latest.timestamp || a.index - b.index).slice(0, limit).map(entry => entry.group);
}

export type WorkerCounts = { total: number; running: number; waiting: number; completed: number; failed: number; stopped: number };
export function workerCounts(workers: readonly ConsoleWorker[]): WorkerCounts {
  const running = workers.filter(worker => worker.status === "running").length;
  const waiting = workers.filter(worker => worker.status === "queued" || worker.status === "parked").length;
  const completed = workers.filter(worker => worker.status === "completed").length;
  const failed = workers.filter(worker => worker.status === "failed" && !isCancellation(worker.error)).length;
  return { total: workers.length, running, waiting, completed, failed, stopped: workers.length - running - waiting - completed - failed };
}
export function workerCountsLine(counts: WorkerCounts): string {
  return [counts.running && `${counts.running} running`, counts.waiting && `${counts.waiting} waiting`, counts.completed && `${counts.completed} complete`, counts.failed && `${counts.failed} need attention`, counts.stopped && `${counts.stopped} stopped`].filter(Boolean).join(", ");
}

export function planSummary(snapshot: ConsoleSessionSnapshot): { done: number; total: number; active: boolean; stale: boolean } | undefined {
  const todos = snapshot.todos;
  if (!todos?.todos.length) return undefined;
  const active = ["working", "waiting", "cancelling"].includes(snapshot.session.status);
  return { done: todos.done, total: todos.total, active, stale: !active && todos.todos.some(todo => !["completed", "cancelled"].includes(todo.status)) };
}

/** Only the engine-reported per-worker cost; telemetry is an untyped record so accept finite numbers only. */
export function workerCostUsd(worker: ConsoleWorker): number | undefined {
  const value = worker.telemetry?.costUsd;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export type CostRow = { id: string; label: string; costUsd: number; share: number };
export type CostBreakdown = {
  totalUsd: number;
  kind: "estimated" | "reported";
  partial: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Rows with real numbers: workers that report cost, plus "This chat" (total minus reported worker cost, never negative). */
  rows: CostRow[];
  /** True when at least one worker lacks a reported cost, so the per-thread split cannot be complete. */
  workersUnattributed: number;
  /** Per-model split is not exposed by the engine; the models actually configured are listed without numbers. */
  models: string[];
};

/** Undefined when the snapshot has no numeric cost (button hidden). */
export function costBreakdown(snapshot: ConsoleSessionSnapshot): CostBreakdown | undefined {
  const total = snapshot.usage.costUsd;
  if (typeof total !== "number" || !Number.isFinite(total)) return undefined;
  const reported = snapshot.workers.flatMap(worker => { const cost = workerCostUsd(worker); return cost === undefined ? [] : [{ worker, cost }]; });
  const reportedSum = reported.reduce((sum, entry) => sum + entry.cost, 0);
  const own = Math.max(0, total - reportedSum);
  const denominator = Math.max(total, reportedSum, Number.EPSILON);
  const rows: CostRow[] = [{ id: "chat", label: "This chat", costUsd: own, share: own / denominator }, ...reported.map(({ worker, cost }) => ({ id: worker.id, label: worker.name || worker.id, costUsd: cost, share: cost / denominator }))];
  const models = [...new Set([snapshot.runtime?.model, ...Object.values(snapshot.runtime?.agentModels ?? {}), ...snapshot.workers.map(worker => worker.model)].filter((value): value is string => typeof value === "string" && value.length > 0))];
  return {
    totalUsd: total,
    kind: snapshot.usage.costKind ?? "estimated",
    partial: Boolean(snapshot.usage.costUnavailable),
    inputTokens: snapshot.usage.inputTokens,
    outputTokens: snapshot.usage.outputTokens,
    rows,
    workersUnattributed: snapshot.workers.length - reported.length,
    models,
  };
}

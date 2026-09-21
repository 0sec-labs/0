import type {
  ScanDepth,
  ScanExecutionMode,
  ScanGoal,
  ScanPlan,
} from "@0sec/shared";

export type PlannerTargetKind = "web" | "source" | "package";

export const SCAN_GOAL_OPTIONS: readonly ScanGoal[] = [
  "known-vulnerabilities",
  "unknown-vulnerabilities",
  "misconfigurations",
];

export const SCAN_RUN_COUNT_OPTIONS = [1, 2, 3] as const;
export const SCAN_EXECUTION_OPTIONS: readonly ScanExecutionMode[] = [
  "sequential",
  "parallel",
];
export const SCAN_TIME_CAP_OPTIONS_MS = [
  30_000,
  60_000,
  300_000,
  600_000,
  1_800_000,
] as const;
export const SCAN_COST_CAP_OPTIONS_USD = [1, 5, 10, 25] as const;

export function recommendedScanGoal(kind: PlannerTargetKind): ScanGoal {
  if (kind === "package") return "known-vulnerabilities";
  if (kind === "web") return "misconfigurations";
  return "unknown-vulnerabilities";
}

export function recommendedScanDepth(goal: ScanGoal): ScanDepth {
  return goal === "unknown-vulnerabilities" ? "deep" : "default";
}

export function recommendedTimeCapMs(
  kind: PlannerTargetKind,
  depth: ScanDepth,
): number {
  if (kind === "web") {
    return depth === "deep" ? 300_000 : depth === "default" ? 60_000 : 30_000;
  }
  return depth === "deep" ? 1_800_000 : depth === "default" ? 600_000 : 300_000;
}

export function createScanPlan(input: {
  goal: ScanGoal;
  depth: ScanDepth;
  runCount: number;
  executionMode: ScanExecutionMode;
  timeCapMs: number;
  costCapUsd: number;
}): ScanPlan {
  return {
    goal: input.goal,
    depth: input.depth,
    runCount: input.runCount,
    executionMode: input.executionMode,
    timeCapMs: input.timeCapMs,
    costCapUsd: input.costCapUsd,
  };
}

export function formatTimeCap(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}

export function formatGoal(goal: ScanGoal): string {
  return goal === "known-vulnerabilities"
    ? "known vulnerabilities"
    : goal === "unknown-vulnerabilities"
      ? "unknown vulnerabilities"
      : "misconfigurations";
}

export function formatExecutionMode(mode: ScanExecutionMode): string {
  return mode === "sequential" ? "sequential (calmer)" : "parallel (faster)";
}
export function cycleNumber<T extends number>(
  items: readonly T[],
  current: T,
  delta: 1 | -1,
): T {
  const index = items.indexOf(current);
  const next = index < 0 ? 0 : (index + delta + items.length) % items.length;
  return items[next]!;
}

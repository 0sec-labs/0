import type {
  ScanDepth,
  ScanExecutionMode,
  ScanGoal,
} from "@0/shared";

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
  return mode === "sequential" ? "sequential (calmer)" : "parallel (overlapping)";
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

export function scanGoalExplanation(kind: PlannerTargetKind, goal: ScanGoal): string {
  const scope = kind === "web" ? "live surface" : kind === "package" ? "package" : "source";
  if (goal === "unknown-vulnerabilities") return `Investigate ${scope} behavior beyond known patterns. Unknown vulnerabilities are an objective, not a promised result.`;
  if (goal === "known-vulnerabilities") return `Check the selected ${scope} for known vulnerability patterns and evidence that they apply.`;
  return `Check the selected ${scope} for exposed or unsafe configuration.`;
}

export function scanDepthExplanation(goal: ScanGoal): string {
  return goal === "unknown-vulnerabilities"
    ? "Deep is suggested for broader investigation and reproduction; it takes more effort. Your selected limits still apply."
    : "Default is suggested for focused checks and reproduction without the effort of a deep investigation.";
}

export const SCAN_RUNS_HELP = "Start with 1 run. Extra runs repeat the selected scope; each run can already use subagents. All runs share the same limits.";
export const SCAN_MODE_HELP = "Sequential is suggested for lower concurrency. Parallel overlaps runs and may finish sooner, but can consume the shared budget sooner.";
export const SCAN_TIME_HELP = "Wall-clock limit for the whole plan, including concurrent runs. Reaching it cancels work; unfinished checks remain incomplete.";
export const SCAN_COST_HELP = "Estimated USD limit shared by every run and subagent. In-flight requests can exceed it before usage is reported. Unknown cost is not zero; this is not a guaranteed provider charge ceiling.";

import { createInterface } from "node:readline/promises";
import { validateScanPlan, type ScanDepth, type ScanGoal, type ScanPlan } from "@0/shared";
import { formatGoal, formatTimeCap, recommendedScanDepth, recommendedScanGoal, recommendedTimeCapMs, scanDepthExplanation, SCAN_COST_HELP, SCAN_RUNS_HELP, SCAN_MODE_HELP } from "./tui/scan-plan.js";

export const SCAN_MODEL_ROLES = ["discovery", "attack", "verify", "report"] as const;

/** Explicit operator pins, never a capability ranking or implicit provider grant. */
export function parseScanModelAssignments(values: readonly string[]): Record<string, string> {
  const assignments: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    const role = value.slice(0, separator);
    const model = value.slice(separator + 1).trim();
    if (separator < 1 || !SCAN_MODEL_ROLES.includes(role as typeof SCAN_MODEL_ROLES[number]) || !model || model === "auto" || /[\r\n\0]/.test(model)) {
      throw new Error("--task-model requires discovery|attack|verify|report=MODEL (an explicit model ID).");
    }
    if (Object.hasOwn(assignments, role)) throw new Error(`Duplicate task model for ${role}.`);
    assignments[role] = model;
  }
  return assignments;
}

export function scanRoutingSummary(model: string | undefined, assignments: Readonly<Record<string, string>> = {}, singleModel = false): string {
  const fallback = model ?? "configured session model";
  return SCAN_MODEL_ROLES.map(role => `${role}: ${singleModel ? fallback : assignments[role] ?? fallback}`).join(" · ");
}

interface PlannerIO {
  question(prompt: string): Promise<string>;
  write(text: string): void;
}

/** The supplied target is immutable here: planning never expands authorization. */
export async function collectGuidedScanPlan(options: {
  target: string;
  depth?: ScanDepth;
  costCapUsd?: number;
  model?: string;
  agentModels?: Readonly<Record<string, string>>;
  singleModel?: boolean;
}, io: PlannerIO): Promise<ScanPlan | undefined> {
  const choose = async <T extends string>(label: string, choices: readonly T[], recommended: T): Promise<T> => {
    while (true) {
      const answer = (await io.question(`${label} (${choices.join(" / ")}) [${recommended}]: `)).trim();
      if (!answer) return recommended;
      if (choices.includes(answer as T)) return answer as T;
      io.write("Choose one of the listed values.\n");
    }
  };
  const positive = async (label: string, fallback: number, integer = false, max = Infinity): Promise<number> => {
    while (true) {
      const raw = (await io.question(`${label} [${fallback}]: `)).trim();
      const value = raw ? Number(raw) : fallback;
      if (Number.isFinite(value) && value > 0 && value <= max && (!integer || Number.isSafeInteger(value))) return value;
      io.write(`Enter a positive ${integer ? "integer" : "number"}${max < Infinity ? ` no greater than ${max}` : ""}.\n`);
    }
  };
  io.write(`Scope: ${options.target}\nRecommendations keep this scope unchanged.\n`);
  const goal = await choose<ScanGoal>("Goal", ["known-vulnerabilities", "unknown-vulnerabilities", "misconfigurations"], recommendedScanGoal("web"));
  io.write(`${scanDepthExplanation(goal)} Unknown vulnerabilities are an objective, not a promised result.\n`);
  const depth = await choose<ScanDepth>("Depth", ["quick", "default", "deep"], options.depth ?? recommendedScanDepth(goal));
  io.write(`${SCAN_RUNS_HELP}\n`);
  const runCount = await positive("Separate runs", 1, true);
  io.write(`${SCAN_MODE_HELP}\n`);
  const executionMode = await choose("Execution", ["sequential", "parallel"] as const, "sequential");
  // These are the portable assessment-step limits, not provider cost guarantees.
  io.write("This planner supports up to 24 hours and $1,000 estimated for the whole plan.\n");
  const timeCapMs = await positive("Total wall-clock cap (minutes)", recommendedTimeCapMs("web", depth) / 60_000, false, 1_440) * 60_000;
  io.write(`${SCAN_COST_HELP}\n`);
  const costCapUsd = await positive("Total estimated cost cap (USD)", Math.min(options.costCapUsd ?? 5, 1_000), false, 1_000);
  const plan = { goal, depth, runCount, executionMode, timeCapMs, costCapUsd };
  validateScanPlan(plan);
  io.write(`\n${options.target} · ${formatGoal(goal)} · ${depth} · ${runCount} separate run(s) · ${executionMode} · ${formatTimeCap(timeCapMs)} total · $${costCapUsd} total estimated\n`);
  io.write(`${scanRoutingSummary(options.model, options.agentModels, options.singleModel)}\nConfigured models are operator choices; no task-specific superiority is assumed. Override with --task-model ROLE=MODEL or --single-model.\n`);
  const confirmed = (await io.question("Start this plan? [y/N]: ")).trim().toLowerCase();
  return confirmed === "y" || confirmed === "yes" ? plan : undefined;
}

export async function guidedScanPlan(options: Parameters<typeof collectGuidedScanPlan>[0]): Promise<ScanPlan | undefined> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await collectGuidedScanPlan(options, { question: prompt => readline.question(prompt), write: text => process.stderr.write(text) });
  } finally { readline.close(); }
}

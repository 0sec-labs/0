/**
 * Pure, bounded overview of the coordinator's main task.
 *
 * The root TODO snapshot owns counts and progress. Direct child lifecycle
 * records own the human-readable lead, activity, and blocker text. Nothing
 * here reads progress events, tool calls, tokens, or nested descendants.
 */

import type { SubagentLifecyclePayload, TodosEventPayload } from "@0sec/core";
import { deriveAgentSummary } from "./subagent-card.js";

/** Exactly the rows painted by `CoordinatorSummary` in the right rail. */
export const COORDINATOR_SUMMARY_ROWS = 6;
const PROGRESS_BAR_CELLS = 12;
const SUMMARY_TEXT_MAX = 72;
const SUMMARY_WORD_LIMIT = 12;

type RootPlan = Pick<TodosEventPayload, "todos" | "done" | "total" | "revision" | "scan_id">;
type ChildLifecycle = Pick<
  SubagentLifecyclePayload,
  "agent_id" | "parent_scan_id" | "name" | "status" | "task" | "summary" | "error" | "done" | "completion_reason"
>;

export type CoordinatorSummaryState = "planning" | "ready" | "working" | "complete" | "needs-attention";

export interface CoordinatorSummaryInput {
  /** The latest root coordinator TODO snapshot. */
  readonly rootPlan?: RootPlan | null;
  /** Direct children only. Callers may pass a larger set; rootScanId filters it. */
  readonly directChildren?: readonly ChildLifecycle[];
  /** Root scan identity; nested descendants are excluded when supplied. */
  readonly rootScanId?: string;
  /** Stable root objective, when one has already been reported. */
  readonly objective?: string;
}

export interface CoordinatorSummary {
  readonly hasRootPlan: boolean;
  readonly hasDirectChildren: boolean;
  readonly state: CoordinatorSummaryState;
  readonly completed: number;
  readonly total: number;
  readonly remaining: number;
  /** Exactly `COORDINATOR_SUMMARY_ROWS` bounded lines for the TUI. */
  readonly lines: readonly [string, string, string, string, string, string];
  readonly rows: number;
}

function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function words(value: string, max = SUMMARY_WORD_LIMIT): string {
  const parts = oneLine(value).split(" ").filter(Boolean);
  if (parts.length <= max) return parts.join(" ");
  return `${parts.slice(0, Math.max(1, max - 1)).join(" ")}…`;
}

/** Reuse the shared child summarizer for punctuation, sentence casing and bounds. */
function childText(value: unknown): string {
  const text = deriveAgentSummary({ status: "running", assistant: oneLine(value) }, SUMMARY_TEXT_MAX);
  return text === "Starting…" ? "" : words(text);
}

function childLabel(child: ChildLifecycle): string {
  const name = oneLine(child.name);
  const text = childText(child.summary) || childText(child.error) || childText(child.task);
  const fallback = name || "Main-task lead";
  return words(text ? `${fallback}: ${text}` : fallback);
}

function progressBar(completed: number, total: number): string {
  if (total <= 0) return `[${"-".repeat(PROGRESS_BAR_CELLS)}]`;
  const filled = Math.min(PROGRESS_BAR_CELLS, Math.max(0, Math.round((completed / total) * PROGRESS_BAR_CELLS)));
  return `[${"#".repeat(filled)}${"-".repeat(PROGRESS_BAR_CELLS - filled)}]`;
}

function validPlan(plan: CoordinatorSummaryInput["rootPlan"]): plan is RootPlan {
  return Boolean(plan && Array.isArray(plan.todos) && plan.todos.length > 0);
}

function uniqueChildren(input: CoordinatorSummaryInput): ChildLifecycle[] {
  const byId = new Map<string, ChildLifecycle>();
  for (const child of input.directChildren ?? []) {
    if (!child || typeof child !== "object") continue;
    const id = oneLine(child.agent_id);
    if (!id) continue;
    if (input.rootScanId && child.parent_scan_id !== input.rootScanId) continue;
    // A repeated lifecycle report replaces the old record instead of adding a
    // second lead to the overview. Sorting makes the result deterministic for
    // callers that collect records from more than one event stream.
    byId.set(id, child);
  }
  return [...byId.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

/** Build the stable, plain-language coordinator overview. */
export function buildCoordinatorSummary(input: CoordinatorSummaryInput = {}): CoordinatorSummary {
  const plan = validPlan(input.rootPlan) ? input.rootPlan : null;
  const children = uniqueChildren(input);
  const hasRootPlan = plan !== null;
  const hasDirectChildren = children.length > 0;
  const total = plan?.todos.length ?? 0;
  const completed = plan?.todos.filter((todo) => todo.status === "completed").length ?? 0;
  const remaining = Math.max(0, total - completed);
  const blockers = children.filter((child) => child.status === "failed" || (child.status === "completed" && child.done === false));
  const active = children.filter((child) => child.status === "queued" || child.status === "running");
  const state: CoordinatorSummaryState = !hasRootPlan
    ? "planning"
    : blockers.length > 0
      ? "needs-attention"
      : completed === total
        ? "complete"
        : active.length > 0 || plan.todos.some((todo) => todo.status === "in_progress")
          ? "working"
          : "ready";

  const objective = childText(input.objective);
  const overall = objective || (state === "planning" ? "Planning" : state === "needs-attention" ? "Needs attention" : state === "complete" ? "Complete" : state === "working" ? "Working" : "Ready to start");

  const progress = !hasRootPlan
    ? "Planning: main-task count is not known yet."
    : `${progressBar(completed, total)} ${completed} of ${total} main tasks done`;

  const completedLead = children.find((child) => child.status === "completed" && child.done !== false);
  const done = !hasRootPlan
    ? "No main-task plan is available yet."
    : completedLead
      ? childLabel(completedLead)
      : completed > 0
        ? `${completed} main task${completed === 1 ? "" : "s"} finished.`
        : "No main-task lead has finished yet.";

  const workingLead = active[0];
  const working = !hasDirectChildren
    ? "No direct main-task lead is reporting yet."
    : workingLead
      ? childLabel(workingLead)
      : "No direct main-task lead is active.";

  const nextTodo = plan?.todos.find((todo) => todo.status !== "completed");
  const next = !hasRootPlan
    ? "Set the main-task plan."
    : nextTodo
      ? childText(nextTodo.content) || "Continue the main-task plan."
      : "Nothing remains in the plan.";

  const blocker = blockers[0];
  const needsYou = blocker
    ? childText(blocker.error) || `${oneLine(blocker.name) || "A main-task lead"} is blocked; review its result.`
    : "Nothing right now.";

  return {
    hasRootPlan,
    hasDirectChildren,
    state,
    completed,
    total,
    remaining,
    lines: [
      `Overall: ${words(overall)}`,
      progress,
      `Done: ${words(done)}`,
      `Working: ${words(working)}`,
      `Next: ${words(next)}`,
      `Needs you: ${words(needsYou)}`,
    ],
    rows: COORDINATOR_SUMMARY_ROWS,
  };
}

/** Short alias for callers that prefer the noun-first naming convention. */
export const summarizeCoordinator = buildCoordinatorSummary;

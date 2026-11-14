import type { SecurityWorkflow, SecurityWorkflowExecution, SecurityWorkflowInput } from "@0/engine/shared";
import { DEFAULT_SECURITY_WORKFLOW_PLAN } from "@0/engine/dist/shared/security-workflows.js";

/** Pure view models for the Automations list and detail form. No React, no network. */

export type Cadence = "hourly" | "daily" | "weekly";
export type ScheduleSummary = { id: string; workflowId: string; workflowRevision: number; enabled: boolean; cadence: Cadence; startAt?: string; nextFireAt: string; timezone: string; lastStatus?: string; lastError?: string };
export type ExecutionSummary = Pick<SecurityWorkflowExecution, "id" | "workflowId" | "status" | "createdAt" | "updatedAt">;

const pad = (value: number) => String(value).padStart(2, "0");

function zonedParts(iso: string, timezone: string): { weekday: string; hour: string; minute: string } | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone || "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
    return { weekday: get("weekday"), hour: get("hour"), minute: get("minute") };
  } catch { return null; }
}

/** "Hourly at :30", "Daily 09:00 UTC", "Weekly Mon 09:00 UTC". Falls back to the cadence alone. */
export function scheduleSummaryLabel(schedule: Pick<ScheduleSummary, "cadence" | "startAt" | "nextFireAt" | "timezone">): string {
  const parts = zonedParts(schedule.startAt ?? schedule.nextFireAt, schedule.timezone);
  const zone = schedule.timezone || "UTC";
  if (!parts) return { hourly: "Hourly", daily: "Daily", weekly: "Weekly" }[schedule.cadence];
  if (schedule.cadence === "hourly") return `Hourly at :${parts.minute}`;
  if (schedule.cadence === "daily") return `Daily ${parts.hour}:${parts.minute} ${zone}`;
  return `Weekly ${parts.weekday} ${parts.hour}:${parts.minute} ${zone}`;
}

export function triggerSummaryLabel(schedules: readonly ScheduleSummary[]): string {
  if (!schedules.length) return "Manual";
  const active = schedules.filter(schedule => schedule.enabled);
  const shown = active.length ? active : schedules;
  if (shown.length > 1) return `${shown.length} schedules`;
  const label = scheduleSummaryLabel(shown[0]!);
  return active.length ? label : `${label} (paused)`;
}

export function relativeAge(iso: string | undefined, now: number): string {
  if (!iso) return "Never";
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "Never";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function relativeUntil(iso: string | undefined, now: number): string {
  if (!iso) return "-";
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "-";
  const seconds = Math.round((time - now) / 1000);
  if (seconds <= 60) return "soon";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

export function executionDurationMs(execution: Pick<ExecutionSummary, "createdAt" | "updatedAt">): number | null {
  const start = new Date(execution.createdAt).getTime();
  const end = new Date(execution.updatedAt).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

export type AutomationRow = {
  id: string; name: string; target: string; steps: number; trigger: string; enabled: boolean; scheduled: boolean;
  lastRunAt?: string; lastStatus?: string; nextFireAt?: string; updatedAt: string;
};

export function automationRows(definitions: readonly SecurityWorkflow[], schedules: readonly ScheduleSummary[], executions: readonly ExecutionSummary[]): AutomationRow[] {
  const latest = new Map<string, ExecutionSummary>();
  for (const execution of executions) {
    const current = latest.get(execution.workflowId);
    if (!current || execution.createdAt > current.createdAt) latest.set(execution.workflowId, execution);
  }
  return definitions.map(definition => {
    const own = schedules.filter(schedule => schedule.workflowId === definition.id);
    const active = own.filter(schedule => schedule.enabled);
    const next = [...active].sort((a, b) => a.nextFireAt.localeCompare(b.nextFireAt))[0];
    const last = latest.get(definition.id);
    return {
      id: definition.id, name: definition.name, target: definition.target, steps: definition.nodes.filter(node => node.type !== "trigger" && node.type !== "report").length,
      trigger: triggerSummaryLabel(own), enabled: active.length > 0, scheduled: own.length > 0,
      ...(last ? { lastRunAt: last.createdAt, lastStatus: last.status } : {}), ...(next ? { nextFireAt: next.nextFireAt } : {}), updatedAt: definition.updatedAt,
    };
  });
}

/** Most recently run first, then most recently edited. */
export function sortAutomationRows(rows: readonly AutomationRow[]): AutomationRow[] {
  return [...rows].sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "") || b.updatedAt.localeCompare(a.updatedAt));
}

export function filterAutomationRows(rows: readonly AutomationRow[], query: string): AutomationRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...rows];
  return rows.filter(row => { const haystack = `${row.name} ${row.target} ${row.trigger}`.toLowerCase(); return terms.every(term => haystack.includes(term)); });
}

export type TemplateLike = { id: string; name: string; description: string; category: string };
export function filterTemplates<T extends TemplateLike>(templates: readonly T[], query: string): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return templates.filter(item => { const haystack = `${item.name} ${item.description} ${item.category} ${item.id === "repository-review" ? "whitebox pentest source code repository review" : ""}`.toLowerCase(); return terms.every(term => haystack.includes(term)); });
}

export type UsageSummary = { runs: number; completed: number; failed: number; running: number; lastRunAt?: string; averageDurationMs: number | null };
/** Runs in the trailing window. Executions carry no cost field today, so usage is run counts and duration. */
export function usageSummary(executions: readonly ExecutionSummary[], now: number, days = 30): UsageSummary {
  const since = now - days * 86_400_000;
  const recent = executions.filter(execution => new Date(execution.createdAt).getTime() >= since);
  const durations = recent.filter(execution => execution.status === "completed" || execution.status === "failed").map(executionDurationMs).filter((value): value is number => value !== null);
  const lastRunAt = recent.map(execution => execution.createdAt).sort().at(-1);
  return {
    runs: recent.length, completed: recent.filter(execution => execution.status === "completed").length,
    failed: recent.filter(execution => execution.status === "failed" || execution.status === "interrupted").length,
    running: recent.filter(execution => execution.status === "queued" || execution.status === "running").length,
    ...(lastRunAt ? { lastRunAt } : {}), averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
  };
}

/** Minimal valid definition: manual trigger, one review step, result collection. */
export function blankAutomationInput(overrides: { name?: string; instructions?: string; target?: string } = {}): SecurityWorkflowInput {
  return {
    name: (overrides.name ?? "").trim() || "Untitled automation", instructions: overrides.instructions ?? "", target: overrides.target ?? "",
    nodes: [
      { id: "start", type: "trigger", label: "Start manually", enabled: true },
      { id: "review", type: "audit", label: "Review", enabled: true, plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN } },
      { id: "report", type: "report", label: "Collect results", enabled: true },
    ],
    edges: [{ source: "start", target: "review" }, { source: "review", target: "report" }],
  };
}

/** Client-side prefill for "Create with 0": the prompt becomes the instructions and its first sentence the name. */
export function automationFromPrompt(prompt: string): { name: string; instructions: string } {
  const instructions = prompt.trim();
  const firstLine = instructions.split(/\r?\n/)[0] ?? "";
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const clean = sentence.replace(/[.!?]+$/, "").trim();
  const name = clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}...` : clean;
  return { name: name || "Untitled automation", instructions };
}

export function duplicateName(name: string): string {
  const base = `${name.replace(/\s+copy(?: \d+)?$/i, "")} copy`;
  return base.length > 160 ? base.slice(-160) : base;
}

/** Run counts per UTC day for the trailing window, oldest first (`days` entries). */
export function dailyRunCounts(executions: readonly ExecutionSummary[], now: number, days = 30): number[] {
  const dayMs = 86_400_000;
  const today = Math.floor(now / dayMs);
  const counts = Array.from({ length: days }, () => 0);
  for (const execution of executions) {
    const time = new Date(execution.createdAt).getTime();
    if (!Number.isFinite(time)) continue;
    const offset = today - Math.floor(time / dayMs);
    if (offset >= 0 && offset < days) counts[days - 1 - offset]! += 1;
  }
  return counts;
}

/** Sum of the per-step caps on enabled executable steps; the only budget fields the engine stores today. */
export function stepCapTotals(workflow: Pick<SecurityWorkflow, "nodes">): { steps: number; timeCapMs: number; costCapUsd: number } {
  const capped = workflow.nodes.filter(node => node.enabled && node.plan);
  return { steps: capped.length, timeCapMs: capped.reduce((sum, node) => sum + (node.plan?.timeCapMs ?? 0), 0), costCapUsd: capped.reduce((sum, node) => sum + (node.plan?.costCapUsd ?? 0), 0) };
}

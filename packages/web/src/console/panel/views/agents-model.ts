import type { ConsoleWorker } from "@0/engine/shared";

/** Pure models for the Agents, Agent detail and Browser views. No React, no DOM. */

export type AgentTone = "running" | "waiting" | "done" | "failed" | "stopped";

export const isCancellationText = (text?: string) => Boolean(text && /^(?:This operation was aborted\.?|The operation was aborted\.?|AbortError(?::.*)?|Workbench cancelled.*|Turn cancelled by operator.*)$/i.test(text.trim()));

export const isWorkerActive = (worker: Pick<ConsoleWorker, "status">) => worker.status === "running" || worker.status === "queued";
/** Active or parked workers can still be stopped (matches the existing "Stop all" visibility rule). */
export const isWorkerStoppable = (worker: Pick<ConsoleWorker, "status">) => isWorkerActive(worker) || worker.status === "parked";

export function agentTone(worker: Pick<ConsoleWorker, "status" | "error">): AgentTone {
  switch (worker.status) {
    case "running": return "running";
    case "queued":
    case "parked": return "waiting";
    case "completed": return "done";
    case "stopped": return "stopped";
    default: return isCancellationText(worker.error) ? "stopped" : "failed";
  }
}

export function agentStatusLabel(worker: Pick<ConsoleWorker, "status" | "error">): string {
  if (isCancellationText(worker.error)) return "Stopped";
  switch (worker.status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "parked": return "Idle";
    case "completed": return "Done";
    case "stopped": return "Stopped";
    default: return "Failed";
  }
}

/** First non-empty line of the task, collapsed whitespace, clipped for a one-line subtitle. */
export function taskLine(task: string | undefined, max = 140): string {
  const line = (task ?? "").split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? "";
  const clean = line.replace(/^#+\s*/, "").replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function timestamp(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function workerStartedAt(worker: Pick<ConsoleWorker, "telemetry" | "transcript">): number | undefined {
  return timestamp(worker.telemetry?.createdAt) ?? timestamp(worker.telemetry?.startedAt) ?? timestamp(worker.transcript[0]?.ts);
}

export function workerEndedAt(worker: Pick<ConsoleWorker, "telemetry" | "transcript" | "status">): number | undefined {
  const start = workerStartedAt(worker);
  const duration = worker.telemetry?.durationMs;
  if (start !== undefined && typeof duration === "number" && duration >= 0) return start + duration;
  return timestamp(worker.transcript.at(-1)?.ts);
}

/** Elapsed run time in seconds; live workers measure against `now`. */
export function workerElapsedSeconds(worker: Pick<ConsoleWorker, "telemetry" | "transcript" | "status">, now: number): number | undefined {
  const duration = worker.telemetry?.durationMs;
  if (typeof duration === "number" && duration >= 0) return duration / 1000;
  const start = timestamp(worker.transcript[0]?.ts);
  if (start === undefined) return undefined;
  const end = isWorkerActive(worker) ? now : worker.transcript.at(-1)?.ts ?? start;
  return Math.max(0, (end - start) / 1000);
}

export function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value >= 3600) return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
  return value >= 60 ? `${Math.floor(value / 60)}m ${value % 60}s` : `${value}s`;
}

/** Compact relative age: "now", "5m", "3h", "2d". */
export function shortAge(from: number | undefined, now: number): string | undefined {
  if (from === undefined) return undefined;
  const seconds = Math.max(0, (now - from) / 1000);
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/**
 * Per-worker cost, only when the engine reports a real number (`telemetry.costUsd`). The field is not part of
 * the typed contract; absent means "unknown", never zero.
 */
export function workerCostUsd(worker: Pick<ConsoleWorker, "telemetry">): number | undefined {
  const value = worker.telemetry?.costUsd;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function formatCostUsd(cost: number): string {
  return cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

export type AgentRow = {
  id: string;
  index: number;
  name: string;
  task: string;
  tone: AgentTone;
  statusLabel: string;
  model: string | undefined;
  age: string | undefined;
  elapsed: string | undefined;
  cost: string | undefined;
  stoppable: boolean;
};

/** Newest first would reorder the swarm unexpectedly; keep the engine order and surface live work at the top. */
export function agentRows(workers: readonly ConsoleWorker[], now: number): AgentRow[] {
  const rows = workers.map((worker, index): AgentRow => {
    const elapsed = workerElapsedSeconds(worker, now);
    const cost = workerCostUsd(worker);
    return {
      id: worker.id,
      index,
      name: worker.name || worker.id,
      task: taskLine(worker.task),
      tone: agentTone(worker),
      statusLabel: agentStatusLabel(worker),
      model: worker.model || (typeof worker.telemetry?.model === "string" ? worker.telemetry.model : undefined),
      age: shortAge(workerStartedAt(worker), now),
      elapsed: elapsed === undefined ? undefined : formatDuration(elapsed),
      cost: cost === undefined ? undefined : formatCostUsd(cost),
      stoppable: isWorkerStoppable(worker),
    };
  });
  const rank = (row: AgentRow) => (row.tone === "running" ? 0 : row.tone === "waiting" ? 1 : row.tone === "failed" ? 2 : 3);
  return rows.map((row, position) => ({ row, position })).sort((a, b) => rank(a.row) - rank(b.row) || a.position - b.position).map(item => item.row);
}

export function agentsSummary(workers: readonly ConsoleWorker[]): { total: number; running: number; waiting: number; done: number; failed: number; stopped: number; stoppable: number; text: string } {
  const counts = { running: 0, waiting: 0, done: 0, failed: 0, stopped: 0 };
  for (const worker of workers) counts[agentTone(worker)] += 1;
  const parts = [counts.running && `${counts.running} running`, counts.waiting && `${counts.waiting} idle`, counts.done && `${counts.done} done`, counts.failed && `${counts.failed} failed`, counts.stopped && `${counts.stopped} stopped`].filter(Boolean);
  return { total: workers.length, ...counts, stoppable: workers.filter(isWorkerStoppable).length, text: parts.join(", ") };
}

/** Flat tool-call list for `ToolActivity`, matching what the legacy agents panel feeds it. */
export function workerToolCalls(worker: ConsoleWorker) {
  return worker.transcript.flatMap(turn => (turn.tools ?? []).map(tool => ({
    id: tool.call.id ?? `${turn.turn}-${tool.callIndex}`,
    name: tool.call.name,
    arguments: tool.call.arguments,
    result: tool.result,
    isRunning: worker.status !== "parked" && (tool.running ?? false),
  })));
}

/** One-line live subtitle for a worker: current tool, last assistant line, or a status word. */
export function workerSubtitle(worker: ConsoleWorker): string {
  if (isCancellationText(worker.error)) return "Stopped";
  if (worker.error) return worker.error;
  for (const turn of [...worker.transcript].reverse()) {
    const tool = turn.tools?.findLast(item => item.running);
    if (worker.status === "running" && tool) return `Using ${tool.call.name.replaceAll("_", " ")}`;
    if (turn.assistant?.trim() && !isCancellationText(turn.assistant)) return turn.assistant.trim().split("\n")[0]!;
  }
  return worker.status === "running" ? "Thinking…" : worker.status === "completed" ? "Complete" : worker.status === "parked" ? "Available" : worker.status === "queued" ? "Starting…" : worker.status === "stopped" ? "Stopped" : "Needs attention";
}

/* ---------- Browser ---------- */

export type BrowserItemSource = { kind: "live"; id: string; pageId: string; url: string; title?: string; producerId: string; liveAvailable: boolean } | { kind: "capture"; id: string; url?: string; title: string; owner: string; pageId?: string };

export function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname || undefined; } catch { return undefined; }
}

/** Only plain http(s) links without credentials may be opened externally. */
export function externalUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch { return undefined; }
}

export function browserItemLabel(item: BrowserItemSource): string {
  if (item.kind === "live") return item.title || hostnameOf(item.url) || item.url || "Browser view";
  return item.title || hostnameOf(item.url) || "Browser capture";
}

/** A capture duplicates a live view when it shares the page id, or the URL and owner. */
export function captureMatchesView(
  capture: { pageId?: string; url?: string; owner: string },
  view: { pageId: string; url: string; producerId: string },
  workers: readonly Pick<ConsoleWorker, "id" | "name">[],
): boolean {
  if (capture.pageId) return capture.pageId === view.pageId;
  if (capture.url !== view.url) return false;
  return capture.owner === "Main chat" ? !workers.some(worker => worker.id === view.producerId) : workers.some(worker => worker.id === view.producerId && worker.name === capture.owner);
}

/** Live views first, then captures not already covered by a live view. Dismissed ids are dropped. */
export function browserItems<V extends { id: string; pageId: string; url: string; producerId: string }, C extends { id: string; pageId?: string; url?: string; owner: string }>(
  views: readonly V[], captures: readonly C[], workers: readonly Pick<ConsoleWorker, "id" | "name">[], dismissed: ReadonlySet<string>,
): { live: V[]; captures: C[] } {
  const live = views.filter(view => !dismissed.has(`view:${view.id}`));
  return { live, captures: captures.filter(capture => !dismissed.has(capture.id) && !views.some(view => captureMatchesView(capture, view, workers))) };
}

/** Keep the selection if still present, otherwise fall back to the first item. */
export function selectBrowserKey(keys: readonly string[], selected: string | undefined): string | undefined {
  return selected && keys.includes(selected) ? selected : keys[0];
}

export function liveStatusLabel(status: "connecting" | "live" | "closed" | "unavailable" | "expired" | "paused", hasFrame: boolean): string {
  return status === "live" && hasFrame ? "Live" : status === "connecting" ? "Connecting…" : status === "paused" ? "Paused" : status === "closed" ? "Closed" : status === "expired" ? "Expired" : "Captured screenshot";
}

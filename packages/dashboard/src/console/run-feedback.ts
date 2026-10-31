import type { ConsoleSessionSnapshot } from "@0/shared";
import type { ReducedTurn } from "./transcript";

export interface RunFeedback {
  label: string;
  active: boolean;
  waiting?: boolean;
  error?: string;
}

/** Limits belong to the turn that stopped, rather than the next-message composer. */
export function turnLimitNotice(turn: ReducedTurn): string | undefined {
  if (!turn.isComplete) return;
  if (turn.stopReason === "max_tool_iterations") return "This response stopped at the previous tool limit.";
  if (turn.stopReason === "max_turn_tokens") return "This response stopped at the configured token budget.";
}

/** A terminal turn event wins over a session status still catching up on the stream. */
export function runFeedback(snapshot: ConsoleSessionSnapshot, turn?: ReducedTurn): RunFeedback | null {
  if (snapshot.session.status === "closed") return { label: "Conversation closed", active: false };
  const active = !turn?.isComplete && ["working", "waiting"].includes(snapshot.session.status);
  if (active) {
    if (turn?.notices.some(notice => notice.startsWith("Cancellation requested."))) return { label: "Stopping…", active: true };
    if (snapshot.session.status === "waiting" || snapshot.pendingDecisions.length) return { label: "Waiting for your decision", active: true, waiting: true };
    if (snapshot.execution?.status === "pending") return { label: snapshot.execution.message || "Starting workspace…", active: true };
    const tools = turn?.toolCalls.filter(call => call.isRunning) ?? [];
    if (tools.length) return { label: tools.length === 1 ? `Running ${tools[0].name.replaceAll("_", " ")}…` : `Running ${tools.length} tools…`, active: true };
    const latestNotice = turn?.notices.at(-1);
    if (latestNotice?.startsWith("Provider output cap reached; continuing")) return { label: "Continuing automatically…", active: true };
    return { label: turn?.assistantText ? "Working…" : "Thinking…", active: true };
  }
  if (turn?.stopReason === "cancelled") return { label: "Stopped", active: false };
  if (turn?.error || snapshot.session.status === "failed") return { label: "Response failed", active: false, error: turn?.error };
  switch (turn?.stopReason) {
    case "max_tool_iterations": return { label: "Response stopped at the previous tool limit", active: false };
    case "max_turn_tokens": return { label: "Response stopped at the configured token budget", active: false };
    case "output_cap": return { label: "Response reached the model output limit", active: false };
    case "error": return { label: "Response failed", active: false };
    case "end_turn": return { label: "Response complete", active: false };
  }
  return turn?.isComplete ? { label: "Ready", active: false } : null;
}

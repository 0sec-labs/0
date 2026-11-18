import { turnEndingKind, type TurnEndingKind } from "@0/engine/shared/desktop-console";
import { toolCallStatus } from "./tool-call-status";
import type { ReducedTurn } from "./transcript";

/** What the operator reads under the user message when a turn finished without an answer. */
export const TURN_ENDING_TEXT: Record<TurnEndingKind, string> = {
  no_reply: "The model returned no reply.",
  truncated: "The reply was cut off.",
  filtered: "The provider blocked this reply.",
  disconnected: "The connection dropped before the model answered.",
};

/** Which controls make sense for each ending; the row still gates them on the turn being the latest, idle and writable. */
export const TURN_ENDING_ACTIONS: Record<TurnEndingKind, { retry: boolean; continue: boolean; switchModel: boolean }> = {
  no_reply: { retry: true, continue: false, switchModel: true },
  truncated: { retry: false, continue: true, switchModel: false },
  filtered: { retry: true, continue: false, switchModel: true },
  disconnected: { retry: true, continue: false, switchModel: false },
};

/** A turn that did something visible without writing text (a tool that worked, a visual, a subagent) finished its task. */
export function turnHasSilentWork(turn: ReducedTurn, subagents = 0): boolean {
  return subagents > 0 || turn.toolCalls.some((call) => toolCallStatus(call) === "Done");
}

/** `undefined` while the turn is running or when it ended normally (or in a generic error/stop with its own treatment). */
export function turnEnding(turn: ReducedTurn, subagents = 0): TurnEndingKind | undefined {
  if (!turn.isComplete || turn.isWorking) return undefined;
  return turnEndingKind({
    stopReason: turn.stopReason,
    assistantText: turn.assistantText,
    error: turn.error,
    outputCap: turn.outputCap,
    silentWork: turnHasSilentWork(turn, subagents),
  });
}

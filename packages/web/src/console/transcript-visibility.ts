import type { DecisionState, ReducedTurn } from "./transcript";

/** Session-lifecycle chatter some backends emit as a notice; it is never transcript content. */
const LIFECYCLE_NOTICE = /^\s*new\s+(?:mission|session|chat|conversation)\s+opened\.?\s*$/i;

/** A granted workspace folder is routine setup; only a refusal is worth a line in the transcript. */
export function isRoutineDecision(decision: Pick<DecisionState, "kind" | "approved">): boolean {
  return decision.kind === "local-scope" && decision.approved !== false;
}

export function visibleResolvedDecisions(turn: Pick<ReducedTurn, "decisions">): DecisionState[] {
  return turn.decisions.filter(decision => decision.resolved && !isRoutineDecision(decision));
}

export function isLifecycleNotice(text: string): boolean {
  return LIFECYCLE_NOTICE.test(text);
}

/** A turn that only carries hidden setup records (no prompt, no output) must not render or replace the empty state. */
export function isInertTurn(turn: ReducedTurn): boolean {
  if (turn.user.text || turn.user.attachments?.length) return false;
  if (turn.assistantText || turn.reasoningText || turn.toolCalls.length || turn.visuals?.length) return false;
  if (turn.error || turn.stopReason || turn.isWorking) return false;
  if (turn.decisions.some(decision => !decision.resolved || !isRoutineDecision(decision))) return false;
  return turn.notices.every(isLifecycleNotice);
}

export function visibleTurns(turns: ReducedTurn[]): ReducedTurn[] {
  return turns.some(isInertTurn) ? turns.filter(turn => !isInertTurn(turn)) : turns;
}

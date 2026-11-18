import type { DecisionState, ReducedTurn } from "./transcript";

/** Session-lifecycle chatter some backends emit as a notice; it is never transcript content. */
const LIFECYCLE_NOTICE = /^\s*new\s+(?:mission|thread|session|chat|conversation)\s+opened\.?\s*$/i;

export function visibleResolvedDecisions(turn: Pick<ReducedTurn, "decisions">): DecisionState[] {
  return turn.decisions.filter(decision => decision.resolved);
}

export function isLifecycleNotice(text: string): boolean {
  return LIFECYCLE_NOTICE.test(text);
}

/** A turn that only carries hidden setup records (no prompt, no output) must not render or replace the empty state. */
export function isInertTurn(turn: ReducedTurn): boolean {
  if (turn.user.text || turn.user.attachments?.length) return false;
  if (turn.assistantText || turn.reasoningText || turn.toolCalls.length) return false;
  if (turn.error || turn.stopReason || turn.isWorking) return false;
  if (turn.decisions.length) return false;
  return turn.notices.every(isLifecycleNotice);
}

export function visibleTurns(turns: ReducedTurn[]): ReducedTurn[] {
  return turns.some(isInertTurn) ? turns.filter(turn => !isInertTurn(turn)) : turns;
}

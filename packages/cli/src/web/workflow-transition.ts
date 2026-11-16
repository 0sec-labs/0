// Rules for moving a finding between board columns, shared by the route and its tests.
const SETTABLE_WORKFLOW_STATUSES = ["backlog", "todo", "in_progress", "blocked", "done", "cancelled"] as const;

/**
 * Mirrors the board's drop rules (web `resolveDrop`): only people-settable statuses are accepted, and a finding that
 * waits for the operator's review can only be closed. Unknown statuses used to be silently stored as backlog.
 */
export function workflowTransitionRejection(requested: unknown, persisted: string | null | undefined): { status: number; error: string } | null {
  if (typeof requested !== "string" || !(SETTABLE_WORKFLOW_STATUSES as readonly string[]).includes(requested)) {
    const review = requested === "agent_review" || requested === "human_review";
    return { status: 400, error: review ? "Review stages are set by 0, not by hand." : `Unsupported workflow status. Use one of: ${SETTABLE_WORKFLOW_STATUSES.join(", ")}.` };
  }
  if (persisted === "human_review" && requested !== "done" && requested !== "cancelled") {
    return { status: 409, error: "Needs review: confirm it first. Only Done or Cancelled can be set until then." };
  }
  return null;
}

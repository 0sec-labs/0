import type { BeforeCommandPolicy } from "./before-command.js";

/**
 * The "Ask before running commands" operator setting, as the lowest-priority decider
 * on the hook. It never allows or denies on its own: it can only ask.
 */
export const approvalsBeforeCommandPolicy: BeforeCommandPolicy = {
  id: "approvals",
  evaluate(input) {
    if (input.thread.approvals === "ask" && input.effectful !== false) {
      return { decision: "ask", reason: "Ask before running commands is on" };
    }
    return { decision: "allow" };
  },
};

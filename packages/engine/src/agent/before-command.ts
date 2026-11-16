import type { BeforeCommandInput, BeforeCommandOutcome, BeforeCommandPolicy } from "../hooks/before-command.js";
import { evaluateBeforeCommand } from "../hooks/before-command.js";
import { approvalsBeforeCommandPolicy } from "../hooks/approvals-policy.js";
import { protectedPathsBeforeCommandPolicy } from "../hooks/protected-paths-policy.js";
import { scopeBeforeCommandPolicy } from "../scope/before-command.js";

/** First-party deciders, strongest first. Not extensible by plugins in v1. */
export const BUILTIN_BEFORE_COMMAND_POLICIES: readonly BeforeCommandPolicy[] = Object.freeze([
  protectedPathsBeforeCommandPolicy,
  scopeBeforeCommandPolicy,
  approvalsBeforeCommandPolicy,
]);

/** The single entry point for bash dispatch and the console session. */
export function runBeforeCommand(input: BeforeCommandInput): Promise<BeforeCommandOutcome> {
  return evaluateBeforeCommand(input, BUILTIN_BEFORE_COMMAND_POLICIES);
}

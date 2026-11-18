import type { ToolCall } from "../../agent/types.js";
import type { ApprovalsChoice } from "../../shared/approvals.js";
import type { BeforeCommandInput } from "../../hooks/before-command.js";
import { hookInputForTool } from "../../agent/command-hook.js";

export interface CallHookContext {
  readonly threadId: string;
  readonly cwd: string;
  readonly approvals: ApprovalsChoice;
  readonly networkCapable: boolean;
  readonly readOnly: boolean;
}

/** Project one tool call into the `beforeCommand` input. Pure. */
export function beforeCommandInputForCall(call: ToolCall, ctx: CallHookContext): BeforeCommandInput {
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {};
  const thread = { id: ctx.threadId, approvals: ctx.approvals };
  // Executing tools carry their own kind (bash | process | file-write | file-read), command text, cwd and paths.
  const executing = hookInputForTool(call.name, args, { cwd: ctx.cwd, thread, effectful: !ctx.readOnly });
  if (executing) return executing;
  const command = typeof args.command === "string" ? args.command : call.name;
  return {
    kind: ctx.networkCapable ? "network" : "file-write",
    command, argv: [call.name], cwd: ctx.cwd, hosts: [],
    paths: typeof args.path === "string" ? [args.path] : [],
    effectful: !ctx.readOnly, thread,
  };
}

import type { ToolCall } from "../../agent/types.js";
import type { ApprovalsChoice } from "../../shared/approvals.js";
import type { BeforeCommandInput } from "../../hooks/before-command.js";
import type { ScopePolicy } from "../../scope/scope.js";
import { extractToolTargets } from "./tool-targets.js";

export interface CallHookContext {
  readonly threadId: string;
  readonly target: string;
  readonly cwd: string;
  readonly scope: ScopePolicy | undefined;
  readonly approvals: ApprovalsChoice;
  readonly networkCapable: boolean;
  readonly readOnly: boolean;
  readonly canAskScope: boolean;
}

/** Project one tool call into the `beforeCommand` input. Pure. */
export function beforeCommandInputForCall(call: ToolCall, ctx: CallHookContext): BeforeCommandInput {
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {};
  const command = typeof args.command === "string" ? args.command : call.name;
  const kind = call.name === "bash" ? "bash" : ctx.networkCapable ? "network" : "file-write";
  const hosts = ctx.networkCapable ? extractToolTargets(call, ctx.target, true).urls : [];
  return {
    kind,
    command,
    argv: kind === "bash" ? command.split(/\s+/).filter(Boolean) : [call.name],
    cwd: ctx.cwd,
    hosts,
    paths: typeof args.path === "string" ? [args.path] : [],
    effectful: !ctx.readOnly,
    thread: { id: ctx.threadId, scope: ctx.scope, approvals: ctx.approvals, canAskScope: ctx.canAskScope },
  };
}

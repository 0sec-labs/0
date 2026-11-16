import type { ToolCall } from "../../agent/types.js";
import type { ApprovalsChoice } from "../../shared/approvals.js";
import type { BeforeCommandInput } from "../../hooks/before-command.js";
import type { ScopePolicy } from "../../scope/scope.js";
import { hookInputForTool } from "../../agent/command-hook.js";
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
  /** http_audit path allowlist prefixes of the thread, when it has them. */
  readonly pathPrefixes?: readonly string[];
}

/** Project one tool call into the `beforeCommand` input. Pure. */
export function beforeCommandInputForCall(call: ToolCall, ctx: CallHookContext): BeforeCommandInput {
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {};
  const thread = { id: ctx.threadId, scope: ctx.scope, approvals: ctx.approvals, canAskScope: ctx.canAskScope, ...(ctx.pathPrefixes?.length ? { pathPrefixes: ctx.pathPrefixes } : {}) };
  const hosts = ctx.networkCapable ? extractToolTargets(call, ctx.target, true).urls : [];
  // Executing tools carry their own kind (bash | process | file-write | file-read), command text, cwd and paths.
  const executing = hookInputForTool(call.name, args, { cwd: ctx.cwd, thread, hosts, effectful: !ctx.readOnly });
  if (executing) return executing;
  const command = typeof args.command === "string" ? args.command : call.name;
  return {
    kind: ctx.networkCapable ? "network" : "file-write",
    command, argv: [call.name], cwd: ctx.cwd, hosts,
    paths: typeof args.path === "string" ? [args.path] : [],
    effectful: !ctx.readOnly, thread,
  };
}

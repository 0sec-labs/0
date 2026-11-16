/** Pure: turn a declared server into what to launch, and into the `beforeCommand` input that must allow it first. */
import type { BeforeCommandInput, BeforeCommandThread } from "../../../../hooks/before-command.js";
import { AGENT_SESSION_ENV } from "../../../../shared/agent-session.js";
import { extensionEnv } from "../../core/env.js";
import type { McpServerDecl } from "../../core/manifest.js";
import type { McpLaunch } from "../ports.js";
import { inspectLauncher, unpinnedRefusal } from "./launcher.js";

export interface LaunchContext {
  readonly extension: string; readonly dir: string;
  /** Where declared values come from (the process environment plus the connection's secrets); only declared AND approved names are read from it. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** The names the operator approved for this extension (its approval record), plus this server's own, which its approved capability line covers. */
  readonly approvedEnv: readonly string[];
}
export type LaunchPlan = { readonly launch: McpLaunch } | { readonly refused: string };

/**
 * stdio servers get an environment built from scratch: the base set plus the variable NAMES the manifest declared for this
 * server (the approval covers those names, see capabilityLines), never a model provider key unless declared. Servers run
 * in the extension's own folder. http servers get no headers here: header values are secrets and come with connectors.
 */
export function launchFor(server: McpServerDecl, context: LaunchContext): LaunchPlan {
  if (server.transport === "stdio") {
    if (!server.command) return { refused: "its declaration has no command or url" };
    const refusal = unpinnedRefusal(inspectLauncher(server.command, server.args)); if (refusal) return { refused: refusal };
    // The agent-session marker tells approval-bearing code (connections, approvals) that this process was started for an agent.
    const extra = { ZERO_EXTENSION_NAME: context.extension, ZERO_EXTENSION_DIR: context.dir, [AGENT_SESSION_ENV]: "1" };
    return { launch: { kind: "stdio", command: server.command, args: server.args, cwd: context.dir, env: extensionEnv({ declared: server.env, approved: context.approvedEnv, parent: context.parentEnv, extra }) } };
  }
  if (!server.url) return { refused: "its declaration has no command or url" };
  return { launch: { kind: "http", transport: server.transport === "sse" ? "sse" : "http", url: server.url, headers: {} } };
}

/** A process launch is `process`; a remote URL is `network`. Both are effectful and go through the same decision point as bash. */
export function launchHookInput(launch: McpLaunch, thread: BeforeCommandThread, cwd: string): BeforeCommandInput {
  if (launch.kind === "stdio") {
    const argv = [launch.command, ...launch.args];
    return { kind: "process", command: argv.join(" "), argv, cwd: launch.cwd, hosts: [...(inspectLauncher(launch.command, launch.args)?.hosts ?? [])], paths: [], thread, effectful: true };
  }
  return { kind: "network", command: `connect MCP server ${launch.url}`, argv: [launch.url], cwd, hosts: [launch.url], paths: [], thread, effectful: true };
}

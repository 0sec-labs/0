/** Pure: turn a declared server into what to launch, and into the `beforeCommand` input that must allow it first. */
import type { BeforeCommandInput, BeforeCommandThread } from "../../../../hooks/before-command.js";
import { extensionEnv } from "../../core/env.js";
import type { McpServerDecl } from "../../core/manifest.js";
import type { McpLaunch } from "../ports.js";

export interface LaunchContext { readonly extension: string; readonly dir: string; readonly parentEnv: Readonly<Record<string, string | undefined>> }

/**
 * stdio servers get an environment built from scratch: the base set plus the variable NAMES the manifest declared for this
 * server (the approval covers those names, see capabilityLines), never a model provider key unless declared. Servers run
 * in the extension's own folder. http servers get no headers here: header values are secrets and come with connectors.
 */
export function launchFor(server: McpServerDecl, context: LaunchContext): McpLaunch | null {
  if (server.transport === "stdio") {
    if (!server.command) return null;
    return { kind: "stdio", command: server.command, args: server.args, cwd: context.dir, env: extensionEnv({ declared: server.env, approved: server.env, parent: context.parentEnv, extra: { ZERO_EXTENSION_NAME: context.extension, ZERO_EXTENSION_DIR: context.dir } }) };
  }
  if (!server.url) return null;
  return { kind: "http", transport: server.transport === "sse" ? "sse" : "http", url: server.url, headers: {} };
}

/** A process launch is `process`; a remote URL is `network`. Both are effectful and go through the same decision point as bash. */
export function launchHookInput(launch: McpLaunch, thread: BeforeCommandThread, cwd: string): BeforeCommandInput {
  if (launch.kind === "stdio") {
    const argv = [launch.command, ...launch.args];
    return { kind: "process", command: argv.join(" "), argv, cwd: launch.cwd, hosts: [], paths: [], thread, effectful: true };
  }
  return { kind: "network", command: `connect MCP server ${launch.url}`, argv: [launch.url], cwd, hosts: [launch.url], paths: [], thread, effectful: true };
}

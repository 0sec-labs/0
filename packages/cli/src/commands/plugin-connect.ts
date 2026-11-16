// `0 plugin connectors|connect|disconnect|mcp` and `0 plugin install github:owner/repo`: what the
// Plugins page does for service connectors, custom MCP servers and GitHub plugins. Each step that
// the web asks you to review shows the same review here and needs --yes to go ahead.
import type { Command } from "commander";
import { UsageError, consoleOptions, defaultIo, emit, expectOk, renderTable, requireYes, runConsole, type CommandIo, type OutputOptions } from "./console-output.js";

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const collect = (value: string, previous: string[] = []) => [...previous, value];

function pairs(values: string[] | undefined, flag: string, env: NodeJS.ProcessEnv, fromEnv: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of values ?? []) {
    const at = entry.indexOf("=");
    if (at < 1) throw new UsageError(`${flag} expects KEY=${fromEnv ? "ENVVAR" : "VALUE"}.`);
    const key = entry.slice(0, at); const value = entry.slice(at + 1);
    if (!fromEnv) { result[key] = value; continue; }
    const secret = env[value];
    if (!secret) throw new UsageError(`${flag} ${key}: environment variable ${value} is not set.`);
    result[key] = secret;
  }
  return result;
}

/** `0 plugin install github:owner/repo`: review the pinned commit and its permissions, then install on --yes. Never enables. */
export async function runInstallGithub(spec: string, options: OutputOptions & { ref?: string; yes?: boolean; replace?: boolean }, io: CommandIo = defaultIo()): Promise<void> {
  await runConsole(io, options, async client => {
    const repo = spec.replace(/^github:/, "");
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new UsageError("Use github:owner/name.");
    const { review } = record(expectOk(await client.request("POST", "/api/console/plugins/install-github", { repo, ...(options.ref ? { ref: options.ref } : {}) }))) as { review: Record<string, unknown> };
    const summary = () => [`${String(review.name)} ${String(review.version)} from ${String(review.repo)} at ${String(review.sha).slice(0, 12)}`,
      `capabilities: ${((review.capabilities as string[] | undefined) ?? []).join(", ") || "none"}`,
      ...((review.tools as Array<{ name: string; capabilities?: string[] }> | undefined) ?? []).map(tool => `  tool ${tool.name} [${(tool.capabilities ?? []).join(", ")}]`),
      ...(review.alreadyInstalled ? ["already installed; pass --replace to update it"] : [])].join("\n");
    if (options.yes !== true) {
      emit(io, options, { review, installed: false }, () => `${summary()}\nRe-run with --yes to install this exact commit. It is not enabled.`);
      io.setExitCode(2);
      return;
    }
    const result = record(expectOk(await client.request("POST", "/api/console/plugins/install-github/approve", { reviewId: review.reviewId, approved: true, sha: review.sha, permissionHash: review.permissionHash, ...(options.replace ? { replaceExisting: true } : {}) })));
    emit(io, options, { review, result }, () => String(result.message));
  });
}

export function registerPluginConnectCommands(plugin: Command, io: CommandIo = defaultIo()): void {
  const run = (options: OutputOptions, fn: Parameters<typeof runConsole>[2]) => runConsole(io, options, fn);

  consoleOptions(plugin.command("connectors").description("List service connectors (Linear, Slack and others) and whether they are connected"))
    .action((options: OutputOptions) => run(options, async client => {
      const data = record(expectOk(await client.request("GET", "/api/console/service-plugins")));
      const items = (data.items ?? []) as Array<{ id: string; name: string; status: string; toolCount: number }>;
      emit(io, options, data, () => renderTable(items.map(item => [item.id, item.status.replace("_", " "), String(item.toolCount), item.name]), ["ID", "STATUS", "TOOLS", "NAME"]));
    }));

  consoleOptions(plugin.command("connect <service>").description("Connect a service connector; secrets come from environment variables, never argv")
    .option("--set <key=value>", "A non-secret field (repeatable)", collect).option("--secret-env <key=ENVVAR>", "Read a secret field from this environment variable (repeatable)", collect)
    .option("--yes", "Approve connecting this service"))
    .action((service: string, options: OutputOptions & { set?: string[]; secretEnv?: string[]; yes?: boolean }) => run(options, async client => {
      const fields = { ...pairs(options.set, "--set", process.env, false), ...pairs(options.secretEnv, "--secret-env", process.env, true) };
      const list = record(expectOk(await client.request("GET", "/api/console/service-plugins")));
      const item = ((list.items ?? []) as Array<{ id: string; name: string; fields: Array<{ key: string; type: string }> }>).find(row => row.id === service);
      if (!item) throw new UsageError(`Unknown connector ${service}. See \`0 plugin connectors\`.`);
      const unknown = Object.keys(fields).filter(key => !item.fields.some(field => field.key === key));
      if (unknown.length) throw new UsageError(`${item.name} has no field ${unknown.join(", ")}. Fields: ${item.fields.map(field => `${field.key}${field.type === "secret" ? " (secret, use --secret-env)" : ""}`).join(", ")}.`);
      requireYes(options.yes, `This connects ${item.name} and tests it with the credentials given.`);
      const view = record(expectOk(await client.request("POST", `/api/console/service-plugins/${encodeURIComponent(service)}/connect`, { approved: true, fields })));
      const after = ((view.items ?? []) as Array<{ id: string; status: string; toolCount: number }>).find(row => row.id === service);
      emit(io, options, { id: service, status: after?.status, toolCount: after?.toolCount }, () => `Connected ${item.name}: ${after?.toolCount ?? 0} tools.`);
    }));

  consoleOptions(plugin.command("disconnect <service>").description("Forget a connector's credentials").option("--yes", "Confirm"))
    .action((service: string, options: OutputOptions & { yes?: boolean }) => run(options, async client => {
      requireYes(options.yes, `This forgets the saved credentials for ${service}.`);
      expectOk(await client.request("DELETE", `/api/console/service-plugins/${encodeURIComponent(service)}`));
      emit(io, options, { ok: true, id: service }, () => `Disconnected ${service}.`);
    }));

  const mcp = plugin.command("mcp").description("Manage custom MCP servers that threads can use");
  consoleOptions(mcp.command("list").description("List custom MCP servers")).action((options: OutputOptions) => run(options, async client => {
    const data = record(expectOk(await client.request("GET", "/api/console/mcp-servers")));
    const items = (data.items ?? []) as Array<{ id: string; name: string; transport: string; enabled: boolean; status: string; toolCount: number }>;
    emit(io, options, data, () => items.length ? renderTable(items.map(item => [item.id, item.transport, item.enabled ? "on" : "off", item.status, String(item.toolCount), item.name]), ["ID", "TRANSPORT", "ENABLED", "STATUS", "TOOLS", "NAME"]) : "No custom MCP servers.");
  }));

  consoleOptions(mcp.command("add <name> [command...]").description("Add an MCP server: `add <name> -- <cmd> [args...]` for a local one or --url for a remote one; shows a review first")
    .option("--url <url>", "Remote server URL (https) instead of a local command").option("--transport <kind>", "stdio, http or sse (default: stdio, or http with --url)")
    .option("--cwd <path>", "Relative directory inside the workspace to run in")
    .option("--env <KEY=VALUE>", "Environment variable for a local server (repeatable)", collect).option("--env-from <KEY=ENVVAR>", "Take an environment value from this variable (repeatable)", collect)
    .option("--header <NAME=VALUE>", "Header for a remote server (repeatable)", collect).option("--header-from <NAME=ENVVAR>", "Take a header value from this variable (repeatable)", collect)
    .option("--enable", "Enable it for threads once added").option("--allow-dangerous-env", "Also approve environment variables that change which code loads")
    .option("--yes", "Approve the reviewed command and settings"))
    .action((name: string, command: string[], options: OutputOptions & { url?: string; transport?: string; cwd?: string; env?: string[]; envFrom?: string[]; header?: string[]; headerFrom?: string[]; enable?: boolean; allowDangerousEnv?: boolean; yes?: boolean }) => run(options, async client => {
      const transport = options.transport ?? (options.url ? "http" : "stdio");
      if (!["stdio", "http", "sse"].includes(transport)) throw new UsageError("--transport must be stdio, http or sse.");
      if (transport === "stdio" ? !command.length || options.url : !options.url || command.length) throw new UsageError(transport === "stdio" ? "Give a command after `--`, for example: 0 plugin mcp add docs -- npx some-mcp-server." : "Remote servers need --url and no command.");
      const env = { ...pairs(options.env, "--env", process.env, false), ...pairs(options.envFrom, "--env-from", process.env, true) };
      const headers = { ...pairs(options.header, "--header", process.env, false), ...pairs(options.headerFrom, "--header-from", process.env, true) };
      const config = transport === "stdio" ? { name, transport, command: command[0], args: command.slice(1), ...(options.cwd ? { cwd: options.cwd } : {}), env } : { name, transport, url: options.url, headers };
      const { approval } = record(expectOk(await client.request("POST", "/api/console/mcp-servers/preview", { config }))) as { approval: { fingerprint: string; dangerousEnv: string[]; warnings: string[]; summary: Record<string, unknown> } };
      const summary = () => [`Review ${name}:`, JSON.stringify(approval.summary), ...approval.warnings.map(warning => `  - ${warning}`)].join("\n");
      if (options.yes !== true) { emit(io, options, { approval, added: false }, () => `${summary()}\nRe-run with --yes to approve exactly this.`); io.setExitCode(2); return; }
      if (approval.dangerousEnv.length && options.allowDangerousEnv !== true) throw new UsageError(`This sets ${approval.dangerousEnv.join(", ")}, which change which code loads. Add --allow-dangerous-env to approve them.`);
      const data = record(expectOk(await client.request("POST", "/api/console/mcp-servers", { config, approvedFingerprint: approval.fingerprint, approvedDangerousEnv: approval.dangerousEnv, enable: options.enable === true })));
      const item = record(data.item);
      emit(io, options, { item }, () => `Added ${String(item.id)}${options.enable ? " (enabled)" : ". Run `0 plugin mcp test " + String(item.id) + "` to try it."}`);
    }));

  consoleOptions(mcp.command("test <id>").description("Start the server and list its tools")).action((id: string, options: OutputOptions) => run(options, async client => {
    const data = record(expectOk(await client.request("POST", `/api/console/mcp-servers/${encodeURIComponent(id)}/test`, {})));
    emit(io, options, data, () => `${id}: ${String(data.toolCount)} tools, ${String(data.resourceCount)} resources (${String(data.durationMs)} ms).`);
  }));

  consoleOptions(mcp.command("remove <id>").description("Remove a custom MCP server").option("--yes", "Confirm the removal")).action((id: string, options: OutputOptions & { yes?: boolean }) => run(options, async client => {
    requireYes(options.yes, `This removes MCP server ${id}.`);
    expectOk(await client.request("DELETE", `/api/console/mcp-servers/${encodeURIComponent(id)}`));
    emit(io, options, { ok: true, id }, () => `Removed ${id}.`);
  }));
}

// `0 models connect` — model provider credentials, the same actions as the web Connections page.
// Keys are never accepted as an argument: use --key-env <VAR> or --stdin.
import type { Command } from "commander";
import { exitWhenDone, UsageError, expectOk, printJson, readSecret, renderTable, runConsoleCommand, type ConsoleCommandDeps, type JsonOption } from "./console-support.js";

interface ProviderRow { id: string; label: string; configured: boolean; source: string | null; diagnostics: { valid: boolean; reason: string | null }; accounts?: { accountId: string; active: boolean; label?: string }[] }

export function runConnectionsList(options: JsonOption, deps: ConsoleCommandDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    const data = expectOk(await client.request("GET", "/api/console/providers"));
    const providers = data.providers as ProviderRow[];
    if (options.json) return printJson(io, { providers, preference: data.preference ?? null });
    io.out(renderTable(["PROVIDER", "NAME", "STATUS", "ACCOUNTS"], providers.map(p => [
      p.id, p.label, p.diagnostics.valid ? "ready" : p.diagnostics.reason ?? "not connected",
      (p.accounts ?? []).map(a => `${a.label ?? a.accountId}${a.active ? "*" : ""}`).join(", ") || "-",
    ])));
  });
}

export interface ConnectionsAddOptions extends JsonOption { keyEnv?: string; stdin?: boolean; accountId?: string; baseUrl?: string; model?: string }
export function runConnectionsAdd(provider: string, options: ConnectionsAddOptions, deps: ConsoleCommandDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    const apiKey = await readSecret(options, deps, "API key");
    expectOk(await client.request("POST", "/api/console/connections", {
      providerId: provider, action: "connect", apiKey,
      ...(options.accountId ? { accountId: options.accountId } : {}), ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), ...(options.model ? { model: options.model } : {}),
    }));
    if (options.json) printJson(io, { ok: true, provider });
    else io.out(`Connected ${provider}.`);
  });
}

export function runConnectionsTest(provider: string, options: JsonOption, deps: ConsoleCommandDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    const data = expectOk(await client.request("GET", `/api/console/models?providerId=${encodeURIComponent(provider)}&fresh=1`));
    const models = (data.models as unknown[]).length;
    const problems = (data.diagnostics as { providerId: string; message: string }[]).filter(item => item.providerId === provider);
    if (options.json) printJson(io, { provider, ok: problems.length === 0 && models > 0, models, diagnostics: problems });
    else if (problems.length || models === 0) throw new Error(problems[0]?.message ?? `${provider} is not connected or returned no models.`);
    else io.out(`${provider} works: ${models} models available.`);
    if (options.json && (problems.length || models === 0)) throw new Error(problems[0]?.message ?? `${provider} is not connected or returned no models.`);
  });
}

export interface ConnectionsRemoveOptions extends JsonOption { account?: string; yes?: boolean }
export function runConnectionsRemove(provider: string, options: ConnectionsRemoveOptions, deps: ConsoleCommandDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    if (!options.yes) throw new UsageError("Removing a connection deletes its saved credentials. Re-run with --yes.");
    expectOk(await client.request("POST", "/api/console/connections", { providerId: provider, action: "disconnect", ...(options.account ? { accountId: options.account } : {}) }));
    if (options.json) printJson(io, { ok: true, provider });
    else io.out(`Removed ${provider}${options.account ? ` account ${options.account}` : ""}.`);
  });
}

export function registerConnectionsCommand(program: Command, deps: ConsoleCommandDeps = {}): void {
  const connections = program.command("connections").description("Manage model provider connections (the web Connections page)");
  connections.command("list").description("List providers and their connection status")
    .option("--json", "Print JSON").action((o: JsonOption) => exitWhenDone(runConnectionsList(o, deps)));
  connections.command("add <provider>").description("Save and verify an API key for a provider (key from an env var or stdin)")
    .option("--key-env <VAR>", "Read the API key from this environment variable").option("--stdin", "Read the API key from stdin")
    .option("--account-id <id>", "Name this saved account").option("--base-url <url>", "Custom API endpoint").option("--model <model>", "Deployment model, where required")
    .option("--json", "Print JSON").action((p: string, o: ConnectionsAddOptions) => exitWhenDone(runConnectionsAdd(p, o, deps)));
  connections.command("test <provider>").description("Check that a connected provider answers and lists models")
    .option("--json", "Print JSON").action((p: string, o: JsonOption) => exitWhenDone(runConnectionsTest(p, o, deps)));
  connections.command("remove <provider>").description("Remove a provider's saved credentials")
    .option("--account <id>", "Remove only this saved account").option("--yes", "Confirm the removal").option("--json", "Print JSON")
    .action((p: string, o: ConnectionsRemoveOptions) => exitWhenDone(runConnectionsRemove(p, o, deps)));
}

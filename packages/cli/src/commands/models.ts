// `0 models` — the models connected providers offer and the default one, as on the web Models page.
import type { Command } from "commander";
import { exitWhenDone, UsageError, expectOk, printJson, renderTable, runConsoleCommand, type ConsoleCommandDeps, type JsonOption } from "./console-support.js";

interface ModelRow { id: string; provider: string; enabled: boolean; price: string; contextWindowTokens: number | null }
const query = (provider?: string) => `/api/console/models?fresh=1${provider ? `&providerId=${encodeURIComponent(provider)}` : ""}`;

export function runModelsList(options: JsonOption & { provider?: string }, deps: ConsoleCommandDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    const data = expectOk(await client.request("GET", query(options.provider)));
    const models = data.models as ModelRow[];
    if (options.json) return printJson(io, { models, diagnostics: data.diagnostics });
    if (!models.length) io.out("No models. Connect a provider with `0 models connections add`.");
    else io.out(renderTable(["PROVIDER", "MODEL", "ENABLED", "PRICE", "CONTEXT"], models.map(m => [m.provider, m.id, m.enabled ? "yes" : "no", m.price, m.contextWindowTokens ? String(m.contextWindowTokens) : "-"])));
  });
}

export function runModelsDefault(model: string | undefined, options: JsonOption & { provider?: string }, deps: ConsoleCommandDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    if (model === undefined) {
      const data = expectOk(await client.request("GET", "/api/console/providers"));
      const pref = data.preference as { providerId: string; model: string } | null | undefined;
      if (options.json) return printJson(io, { preference: pref ?? null });
      return io.out(pref ? `${pref.providerId}/${pref.model}` : "No default model set.");
    }
    if (!options.provider) throw new UsageError("Setting the default model requires --provider <id>.");
    const data = expectOk(await client.request("PATCH", "/api/console/models/preference", { providerId: options.provider, model }));
    if (options.json) printJson(io, { preference: data.preference });
    else io.out(`Default model: ${options.provider}/${model}`);
  });
}

export function runModelsRecommended(options: JsonOption, deps: ConsoleCommandDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    const data = expectOk(await client.request("GET", query()));
    const picks = data.recommended as { role: string; providerId: string; model: string; why: string }[];
    if (options.json) return printJson(io, { recommended: picks });
    if (!picks.length) io.out("No recommendation: none of the connected providers offers a recommended model.");
    else io.out(renderTable(["ROLE", "PROVIDER", "MODEL", "WHY"], picks.map(p => [p.role, p.providerId, p.model, p.why])));
  });
}

export function registerModelsCommand(program: Command, deps: ConsoleCommandDeps = {}): void {
  const models = program.command("models").description("List available models and choose the default (the web Models page)");
  models.command("list").description("List models offered by connected providers")
    .option("--provider <id>", "Only this provider").option("--json", "Print JSON").action((o: JsonOption & { provider?: string }) => exitWhenDone(runModelsList(o, deps)));
  models.command("default [model]").description("Show the default model, or set it (requires --provider)")
    .option("--provider <id>", "Provider that serves the model").option("--json", "Print JSON")
    .action((m: string | undefined, o: JsonOption & { provider?: string }) => exitWhenDone(runModelsDefault(m, o, deps)));
  models.command("recommended").description("Show the recommended model per role from your connected providers")
    .option("--json", "Print JSON").action((o: JsonOption) => exitWhenDone(runModelsRecommended(o, deps)));
}

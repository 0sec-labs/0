import { readFile, stat } from "node:fs/promises";
import type { Command } from "commander";
import { SENTINEL_AUTONOMY, SENTINEL_STATUSES, SENTINEL_TOOL_ACCESS } from "@0/engine/shared";
import type { ConsoleClient } from "../console-embed-client.js";
import { consoleDefaults, consoleFlags, enc, readJsonObject, renderFields, renderTable, requireYes, resolveId, UsageError, withConsole, type ConsoleCommandDeps, type ConsoleFlags } from "./console-command.js";

const ROOT = "/api/console/sentinels";

interface Sentinel { id: string; name: string; mission?: string; status: string; autonomy: string; toolAccess: string; version: number; budget?: { dailyUsd: number; maxRunsPerDay: number }; attention?: { needsYou: boolean; reason?: string } }
interface Trigger { id: string; automationId: string; kind: string; enabled: boolean; version: number; nextFireAt: string | null; summary?: string; lastStatus?: string }
interface SentinelFile { path: string; revision: number; content?: string; updatedAt?: string }

async function sentinel(client: ConsoleClient, reference: string): Promise<Sentinel> {
  const all = ((await client.request("GET", ROOT)) as { sentinels: Sentinel[] }).sentinels;
  return resolveId(all, reference, "Sentinel");
}
const view = (value: { sentinel: Sentinel }) => value.sentinel;
const detail = (item: Sentinel) => renderFields({ id: item.id, name: item.name, status: item.status, mission: item.mission, autonomy: item.autonomy, "tool access": item.toolAccess, version: item.version, "daily budget (USD)": item.budget?.dailyUsd, "max runs per day": item.budget?.maxRunsPerDay, "needs you": item.attention?.needsYou ? item.attention.reason ?? "yes" : undefined });
const oneOf = (name: string, allowed: readonly string[], value: string | undefined): string | undefined => {
  if (value !== undefined && !allowed.includes(value)) throw new UsageError(`${name} must be one of: ${allowed.join(", ")}.`);
  return value;
};
function positive(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new UsageError(`${name} must be a positive number.`);
  return number;
}
const triggerTable = (rows: Trigger[]) => renderTable(rows, [
  { header: "ID", value: t => t.id }, { header: "KIND", value: t => t.kind }, { header: "AUTOMATION", value: t => t.automationId },
  { header: "ENABLED", value: t => (t.enabled ? "yes" : "no") }, { header: "WHEN", value: t => t.summary ?? t.nextFireAt ?? "-" },
]);

/** `0 sentinels`: everything the Sentinels page does. Reads and edits work offline; runs need the engine. */
export function registerSentinelsCommand(program: Command, deps: ConsoleCommandDeps = consoleDefaults): void {
  const group = program.command("sentinels").description("Create, inspect and control Sentinels");

  consoleFlags(group.command("list").description("List Sentinels").option("--status <status>", `Only ${SENTINEL_STATUSES.join(", ")}`))
    .action((options: ConsoleFlags & { status?: string }) => withConsole(options, deps, async client => {
      const status = oneOf("--status", SENTINEL_STATUSES, options.status);
      return ((await client.request("GET", `${ROOT}${status ? `?status=${status}` : ""}`)) as { sentinels: Sentinel[] }).sentinels;
    }, rows => renderTable(rows, [{ header: "ID", value: s => s.id }, { header: "NAME", value: s => s.name }, { header: "STATUS", value: s => s.status }, { header: "AUTONOMY", value: s => s.autonomy }, { header: "NEEDS YOU", value: s => (s.attention?.needsYou ? "yes" : "") }])));

  consoleFlags(group.command("show <id>").description("Show a Sentinel (full or prefix ID)"))
    .action((id: string, options: ConsoleFlags) => withConsole(options, deps, async client => sentinel(client, id), detail));

  consoleFlags(group.command("presets").description("List Sentinel presets"))
    .action((options: ConsoleFlags) => withConsole(options, deps, async client => ((await client.request("GET", "/api/console/sentinel-presets")) as { presets: Array<{ id: string; name: string; description: string }> }).presets,
      rows => renderTable(rows, [{ header: "ID", value: p => p.id }, { header: "NAME", value: p => p.name }, { header: "DESCRIPTION", value: p => p.description }])));

  consoleFlags(group.command("create").description("Create a Sentinel from a preset or a JSON definition")
    .option("--preset <id>", "Start from a preset (see `0 sentinels presets`)").option("--name <name>", "Name").option("--file <path>", "Sentinel JSON object (overrides preset fields)"))
    .action((options: ConsoleFlags & { preset?: string; name?: string; file?: string }) => withConsole(options, deps, async client => {
      if (!options.preset && !options.file) throw new UsageError("Provide --preset <id> or --file <path>.");
      const body = { ...(options.file ? await readJsonObject(options.file, "Sentinel definition") : {}), ...(options.preset ? { preset: options.preset } : {}), ...(options.name ? { name: options.name } : {}) };
      return view(await client.request("POST", ROOT, body) as { sentinel: Sentinel });
    }, detail));

  consoleFlags(group.command("set <id>").description("Change a Sentinel's settings")
    .option("--name <name>", "Name").option("--mission <text>", "One-line mission")
    .option("--autonomy <level>", SENTINEL_AUTONOMY.join(" | ")).option("--tool-access <level>", SENTINEL_TOOL_ACCESS.join(" | "))
    .option("--daily-usd <usd>", "Daily budget in USD").option("--max-runs <n>", "Maximum runs per day")
    .option("--file <path>", "Patch JSON object").option("--version <n>", "Reviewed version (default: the current one)"))
    .action((id: string, options: ConsoleFlags & { name?: string; mission?: string; autonomy?: string; toolAccess?: string; dailyUsd?: string; maxRuns?: string; file?: string; version?: string }) => withConsole(options, deps, async client => {
      const current = await sentinel(client, id);
      const dailyUsd = positive("--daily-usd", options.dailyUsd);
      const maxRunsPerDay = positive("--max-runs", options.maxRuns);
      const patch: Record<string, unknown> = {
        ...(options.file ? await readJsonObject(options.file, "Sentinel patch") : {}),
        ...(options.name !== undefined ? { name: options.name } : {}), ...(options.mission !== undefined ? { mission: options.mission } : {}),
        ...(options.autonomy ? { autonomy: oneOf("--autonomy", SENTINEL_AUTONOMY, options.autonomy) } : {}), ...(options.toolAccess ? { toolAccess: oneOf("--tool-access", SENTINEL_TOOL_ACCESS, options.toolAccess) } : {}),
        ...(dailyUsd !== undefined || maxRunsPerDay !== undefined ? { budget: { ...current.budget, ...(dailyUsd !== undefined ? { dailyUsd } : {}), ...(maxRunsPerDay !== undefined ? { maxRunsPerDay } : {}) } } : {}),
      };
      if (!Object.keys(patch).length) throw new UsageError("Nothing to change: pass a setting flag or --file.");
      const version = positive("--version", options.version) ?? current.version;
      return view(await client.request("PATCH", `${ROOT}/${enc(current.id)}`, { ...patch, version }) as { sentinel: Sentinel });
    }, detail));

  for (const [verb, text, path] of [["pause", "Pause a Sentinel", "pause"], ["resume", "Resume a paused Sentinel", "resume"]] as const) {
    const command = group.command(`${verb} <id>`).description(text);
    if (verb === "resume") command.option("--acknowledge", "Also acknowledge review of changed scope, model or tools");
    consoleFlags(command).action((id: string, options: ConsoleFlags & { acknowledge?: boolean }) => withConsole(options, deps, async client => {
      const current = await sentinel(client, id);
      return view(await client.request("POST", `${ROOT}/${enc(current.id)}/${path}`, { version: current.version, ...(options.acknowledge ? { acknowledge: true } : {}) }) as { sentinel: Sentinel });
    }, detail));
  }
  consoleFlags(group.command("acknowledge <id>").description("Mark changed scope, model or tools as reviewed"))
    .action((id: string, options: ConsoleFlags) => withConsole(options, deps, async client => {
      const current = await sentinel(client, id);
      return view(await client.request("POST", `${ROOT}/${enc(current.id)}/acknowledge`, { version: current.version }) as { sentinel: Sentinel });
    }, detail));
  consoleFlags(group.command("archive <id>").description("Archive a Sentinel; its history stays"))
    .action((id: string, options: ConsoleFlags) => withConsole(options, deps, async client => {
      const current = await sentinel(client, id);
      return view(await client.request("PATCH", `${ROOT}/${enc(current.id)}`, { status: "archived", version: current.version }) as { sentinel: Sentinel });
    }, detail));
  consoleFlags(group.command("delete <id>").description("Delete a Sentinel; its automations are detached, not deleted").option("--yes", "Confirm deletion"))
    .action((id: string, options: ConsoleFlags & { yes?: boolean }) => withConsole(options, deps, async client => {
      requireYes(options.yes, "Deleting a Sentinel cannot be undone.");
      const current = await sentinel(client, id);
      return { ...(await client.request("DELETE", `${ROOT}/${enc(current.id)}?version=${current.version}`) as object), id: current.id };
    }, result => `Deleted Sentinel ${result.id}`));

  consoleFlags(group.command("run <id>").description("Run a Sentinel now; starts a mission (needs a running engine)")
    .option("--task <text>", "Task for this run").option("--yes", "Confirm that this run is authorized"))
    .action((id: string, options: ConsoleFlags & { task?: string; yes?: boolean }) => withConsole(options, deps, async client => {
      requireYes(options.yes, "Running a Sentinel starts an autonomous mission within its scope and budget.");
      const current = await sentinel(client, id);
      return await client.request("POST", `${ROOT}/${enc(current.id)}/run`, { approval: "launch-authorized-run", version: current.version, ...(options.task ? { task: options.task } : {}) }) as { activation: { id: string; status: string; missionId?: string } };
    }, ({ activation }) => renderFields({ activation: activation.id, status: activation.status, mission: activation.missionId }), { requireHost: "Running a Sentinel" }));

  consoleFlags(group.command("activations <id>").description("List a Sentinel's recent runs").option("--limit <n>", "Maximum rows (1-200)", "50"))
    .action((id: string, options: ConsoleFlags & { limit: string }) => withConsole(options, deps, async client => {
      const current = await sentinel(client, id);
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new UsageError("--limit must be an integer from 1 to 200.");
      return ((await client.request("GET", `${ROOT}/${enc(current.id)}/activations?limit=${limit}`)) as { activations: Array<{ id: string; status: string; trigger?: { kind: string }; startedAt?: string; missionId?: string }> }).activations;
    }, rows => renderTable(rows, [{ header: "ID", value: a => a.id }, { header: "STATUS", value: a => a.status }, { header: "TRIGGER", value: a => a.trigger?.kind }, { header: "STARTED", value: a => a.startedAt }, { header: "MISSION", value: a => a.missionId }])));

  consoleFlags(group.command("budget <id>").description("Show a Sentinel's budget and the last 24 hours of spend"))
    .action((id: string, options: ConsoleFlags) => withConsole(options, deps, async client => {
      const current = await sentinel(client, id);
      return await client.request("GET", `${ROOT}/${enc(current.id)}/budget`) as { budget: { dailyUsd: number; maxRunsPerDay: number }; usage: { costUsd?: number; runs?: number }; pauseReason: { message: string } | null };
    }, value => renderFields({ "daily budget (USD)": value.budget.dailyUsd, "max runs per day": value.budget.maxRunsPerDay, "spent (24h, USD)": value.usage.costUsd, "runs (24h)": value.usage.runs, paused: value.pauseReason?.message })));

  const files = group.command("files").description("Read and edit a Sentinel's instructions and memory files");
  consoleFlags(files.command("list <id>").description("List files"))
    .action((id: string, options: ConsoleFlags) => withConsole(options, deps, async client => ((await client.request("GET", `${ROOT}/${enc((await sentinel(client, id)).id)}/files`)) as { files: SentinelFile[] }).files,
      rows => renderTable(rows, [{ header: "PATH", value: f => f.path }, { header: "REVISION", value: f => f.revision }, { header: "UPDATED", value: f => f.updatedAt }])));
  consoleFlags(files.command("get <id> <path>").description("Print a file's content"))
    .action((id: string, path: string, options: ConsoleFlags) => withConsole(options, deps, async client => ((await client.request("GET", filePath(await sentinel(client, id), path))) as { file: SentinelFile }).file, file => file.content ?? ""));
  consoleFlags(files.command("put <id> <path>").description("Create or replace a file from --file or --content")
    .option("--file <path>", "Read content from a local text file").option("--content <text>", "Inline content"))
    .action((id: string, path: string, options: ConsoleFlags & { file?: string; content?: string }) => withConsole(options, deps, async client => {
      if (Boolean(options.file) === (options.content !== undefined)) throw new UsageError("Provide exactly one of --file or --content.");
      let content = options.content ?? "";
      if (options.file) {
        const info = await stat(options.file).catch(() => { throw new UsageError(`Cannot read file: ${options.file}`); });
        if (!info.isFile() || info.size > 256 * 1024) throw new UsageError("--file must be a regular file of at most 256 KiB.");
        content = await readFile(options.file, "utf8");
      }
      const target = filePath(await sentinel(client, id), path);
      const existing = await client.request("GET", target).then(value => (value as { file: SentinelFile }).file, error => { if ((error as { status?: number }).status === 404) return null; throw error; });
      return ((await client.request("PUT", target, { content, revision: existing ? existing.revision : null })) as { file: SentinelFile }).file;
    }, file => `Saved ${file.path} (revision ${file.revision})`));
  consoleFlags(files.command("rm <id> <path>").description("Delete a file").option("--yes", "Confirm deletion"))
    .action((id: string, path: string, options: ConsoleFlags & { yes?: boolean }) => withConsole(options, deps, async client => {
      requireYes(options.yes, "Deleting a file cannot be undone.");
      const target = filePath(await sentinel(client, id), path);
      const existing = ((await client.request("GET", target)) as { file: SentinelFile }).file;
      await client.request("DELETE", `${target}?revision=${existing.revision}`);
      return { ok: true, path };
    }, result => `Deleted ${result.path}`));

  const triggers = group.command("triggers").description("Control what starts a Sentinel's automations");
  consoleFlags(triggers.command("list <id>").description("List triggers"))
    .action((id: string, options: ConsoleFlags) => withConsole(options, deps, async client => ((await client.request("GET", `${ROOT}/${enc((await sentinel(client, id)).id)}/triggers`)) as { triggers: Trigger[] }).triggers, triggerTable));
  consoleFlags(triggers.command("add <id>").description("Add a trigger for an automation the Sentinel owns; disabled unless --enable --yes")
    .option("--automation <id>", "Owned automation to start").option("--kind <kind>", "schedule | manual | github-pr")
    .option("--file <path>", "Trigger JSON object with schedule or github settings").option("--enable", "Enable immediately").option("--yes", "Confirm that an enabled trigger was reviewed"))
    .action((id: string, options: ConsoleFlags & { automation?: string; kind?: string; file?: string; enable?: boolean; yes?: boolean }) => withConsole(options, deps, async client => {
      const body = { ...(options.file ? await readJsonObject(options.file, "Trigger definition") : {}), ...(options.automation ? { automationId: options.automation } : {}), ...(options.kind ? { kind: options.kind } : {}) };
      if (!body.automationId || !body.kind) throw new UsageError("Provide --automation and --kind (or both in --file).");
      if (options.enable) requireYes(options.yes, "Enabling a trigger lets the Sentinel start runs unattended.");
      return ((await client.request("POST", `${ROOT}/${enc((await sentinel(client, id)).id)}/triggers`, { ...body, enabled: options.enable === true, ...(options.enable ? { approval: "enable-reviewed-trigger" } : {}) })) as { trigger: Trigger }).trigger;
    }, value => triggerTable([value])));
  for (const [verb, text] of [["enable", "Enable a trigger after reviewing it"], ["disable", "Pause a trigger"]] as const) {
    const command = triggers.command(`${verb} <id> <trigger-id>`).description(text);
    if (verb === "enable") command.option("--yes", "Confirm that this trigger was reviewed");
    consoleFlags(command).action((id: string, triggerId: string, options: ConsoleFlags & { yes?: boolean }) => withConsole(options, deps, async client => {
      if (verb === "enable") requireYes(options.yes, "Enabling a trigger lets the Sentinel start runs unattended.");
      const owner = await sentinel(client, id);
      const found = resolveId(((await client.request("GET", `${ROOT}/${enc(owner.id)}/triggers`)) as { triggers: Trigger[] }).triggers, triggerId, "Trigger");
      return ((await client.request("PATCH", `${ROOT}/${enc(owner.id)}/triggers/${enc(found.id)}`, { enabled: verb === "enable", expectedVersion: found.version, ...(verb === "enable" ? { approval: "enable-reviewed-trigger" } : {}) })) as { trigger: Trigger }).trigger;
    }, value => triggerTable([value])));
  }
  consoleFlags(triggers.command("rm <id> <trigger-id>").description("Delete a trigger").option("--yes", "Confirm deletion"))
    .action((id: string, triggerId: string, options: ConsoleFlags & { yes?: boolean }) => withConsole(options, deps, async client => {
      requireYes(options.yes, "Deleting a trigger cannot be undone.");
      const owner = await sentinel(client, id);
      const found = resolveId(((await client.request("GET", `${ROOT}/${enc(owner.id)}/triggers`)) as { triggers: Trigger[] }).triggers, triggerId, "Trigger");
      await client.request("DELETE", `${ROOT}/${enc(owner.id)}/triggers/${enc(found.id)}`);
      return { ok: true, id: found.id };
    }, result => `Deleted trigger ${result.id}`));
}

function filePath(owner: Sentinel, path: string): string {
  return `${ROOT}/${enc(owner.id)}/files/${path.split("/").map(enc).join("/")}`;
}

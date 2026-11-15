import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { parseAgentFile } from "@0/engine/shared";
import { loadAgentDocuments } from "../agent-files.js";
import type { AgentApplyResult, AgentPlanItem } from "../web/agent-apply.js";
import { Option, type Command } from "commander";
import { normalizeSentinelAccessLevel, SENTINEL_ACCESS_LEVELS, SENTINEL_AUTONOMY, SENTINEL_STATUSES, SENTINEL_TOOL_ACCESS } from "@0/engine/shared";
import type { ConsoleClient } from "../console-embed-client.js";
import { consoleDefaults, consoleFlags, enc, readJsonObject, renderFields, renderTable, requireYes, resolveId, UsageError, withConsole, type ConsoleCommandDeps, type ConsoleFlags } from "./console-command.js";

const ROOT = "/api/console/sentinels";
const WEBHOOK_ROOT = "/api/console/github/webhook";
interface WebhookView { serverMode: boolean; configured?: boolean; payloadUrl?: string; lastDeliveryAt?: string; lastResult?: string; lastReason?: string; graceUntil?: string; deliveries?: Array<{ at: string; result: string; event?: string; reason?: string }> }
const webhookText = (view: WebhookView): string => !view.serverMode ? "Not available: the webhook exists only in server mode (0 web --server-mode). Polling is used."
  : renderFields({ configured: view.configured ? "yes" : "no (run: 0 agents webhook secret rotate --yes)", "payload URL": view.payloadUrl ?? "set --public-url on the server", "content type": "application/json", events: "Pull requests", "last delivery": view.lastDeliveryAt ? `${view.lastDeliveryAt} ${view.lastResult}${view.lastReason ? ` (${view.lastReason})` : ""}` : "none yet", "old secret valid until": view.graceUntil })
    + (view.deliveries?.length ? `\n\n${renderTable(view.deliveries, [{ header: "TIME", value: d => d.at }, { header: "RESULT", value: d => d.result }, { header: "EVENT", value: d => d.event }, { header: "REASON", value: d => d.reason }])}` : "");

interface Sentinel { managedBy?: { id: string }; fileState?: { source: "app" | "file"; path?: string; edited?: boolean }; id: string; name: string; mission?: string; status: string; autonomy: string; access?: string; accessLevel?: string; toolAccess: string; version: number; budget?: { dailyUsd: number; maxRunsPerDay: number }; attention?: { needsYou: boolean; reason?: string } }
interface Trigger { id: string; automationId: string; kind: string; enabled: boolean; version: number; nextFireAt: string | null; summary?: string; lastStatus?: string; github?: { repo: string; commentOnPr?: boolean; includeForks?: boolean } }
interface SentinelFile { path: string; revision: number; content?: string; updatedAt?: string }

async function sentinel(client: ConsoleClient, reference: string): Promise<Sentinel> {
  const all = ((await client.request("GET", ROOT)) as { sentinels: Sentinel[] }).sentinels;
  return all.find(item => item.managedBy?.id === reference) ?? resolveId(all, reference, "Agent");
}
const view = (value: { sentinel: Sentinel }) => value.sentinel;
const detail = (item: Sentinel) => renderFields({ id: item.id, name: item.name, definition: fileStateText(item), status: item.status, mission: item.mission, access: accessText(item), "tool access": item.toolAccess, version: item.version, "daily budget (USD)": item.budget?.dailyUsd, "max runs per day": item.budget?.maxRunsPerDay, "needs you": item.attention?.needsYou ? item.attention.reason ?? "yes" : undefined });
/** One line: where the Agent is defined. */
const fileStateText = (item: Sentinel): string => item.fileState?.source === "file" ? `Managed by ${item.fileState.path}${item.fileState.edited ? " (edited since last apply)" : ""}` : "Edited in the app";
const planLine = (item: AgentPlanItem): string => {
  const mark = { create: "+", adopt: ">", update: "~", unchanged: "=", prune: "-", error: "!" }[item.action];
  const head = `${mark} ${item.action} ${item.id || item.path}${item.id ? ` (${item.path})` : ""}`;
  const lines = [head + (item.drift ? "  [edited in the app since last apply]" : "")];
  for (const detail of item.details) lines.push(`    ${detail.field}: ${detail.instance ?? ""} -> ${detail.file ?? ""}`);
  if (!item.details.length) for (const change of item.changes) lines.push(`    ${change}`);
  for (const error of item.errors ?? []) lines.push(`    ${item.path}${error.line ? `:${error.line}` : ""}: ${error.message}`);
  for (const warning of item.warnings ?? []) lines.push(`    note: ${warning}`);
  return lines.join("\n");
};
const renderPlan = (result: AgentApplyResult): string => {
  const c = result.counts;
  return [...result.items.map(planLine), `${result.dryRun ? "Would change" : "Applied"}: ${c.create} create, ${c.adopt} adopt, ${c.update} update, ${c.unchanged} unchanged, ${c.prune} prune, ${c.error} error.${result.dryRun ? "" : ` Content hash ${result.hash.slice(0, 12)}.`}`].join("\n");
};
const ACCESS_TEXT: Record<string, string> = { "read-only": "Read-only", changes: "Can make changes" };
/** Plain access text: Read-only or Can make changes. */
const accessText = (item: Sentinel): string => ACCESS_TEXT[item.access ?? item.accessLevel ?? ""] ?? item.access ?? item.accessLevel ?? item.autonomy;
/** Current access values plus the older spellings, which map to changes. */
const accessInput = (name: string, value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const level = normalizeSentinelAccessLevel(value);
  if (!level) throw new UsageError(`${name} must be one of: ${ACCESS_HELP}.`);
  return level;
};
const ACCESS_HELP = SENTINEL_ACCESS_LEVELS.join(" | ");
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
  { header: "ENABLED", value: t => (t.enabled ? "yes" : "no") }, { header: "WHEN", value: t => t.summary ?? (t.github ? `${t.github.repo}${t.github.commentOnPr ? ", comments on" : ""}${t.github.includeForks ? ", forks" : ""}` : t.nextFireAt) ?? "-" },
]);

/** `0 agents`: everything the Agents page does. Reads and edits work offline; runs need the engine. */
export function registerSentinelsCommand(program: Command, deps: ConsoleCommandDeps = consoleDefaults): void {
  const group = program.command("agents").description("Create, inspect and control Agents");

  consoleFlags(group.command("list").description("List Agents").option("--status <status>", `Only ${SENTINEL_STATUSES.join(", ")}`))
    .action((options: ConsoleFlags & { status?: string }) => withConsole(options, deps, async client => {
      const status = oneOf("--status", SENTINEL_STATUSES, options.status);
      return ((await client.request("GET", `${ROOT}${status ? `?status=${status}` : ""}`)) as { sentinels: Sentinel[] }).sentinels;
    }, rows => renderTable(rows, [{ header: "ID", value: s => s.id }, { header: "NAME", value: s => s.name }, { header: "STATUS", value: s => s.status }, { header: "DEFINED IN", value: s => s.fileState?.source === "file" ? `${s.fileState.path}${s.fileState.edited ? " (edited)" : ""}` : "app" }, { header: "ACCESS", value: s => accessText(s) }, { header: "NEEDS YOU", value: s => (s.attention?.needsYou ? "yes" : "") }])));

  consoleFlags(group.command("show <id>").description("Show a Sentinel (full or prefix ID)"))
    .action((id: string, options: ConsoleFlags) => withConsole(options, deps, async client => sentinel(client, id), detail));

  consoleFlags(group.command("presets").description("List Sentinel presets"))
    .action((options: ConsoleFlags) => withConsole(options, deps, async client => ((await client.request("GET", "/api/console/sentinel-presets")) as { presets: Array<{ id: string; name: string; description: string }> }).presets,
      rows => renderTable(rows, [{ header: "ID", value: p => p.id }, { header: "NAME", value: p => p.name }, { header: "DESCRIPTION", value: p => p.description }])));

  consoleFlags(group.command("create").description("Create a Sentinel from a preset or a JSON definition")
    .option("--preset <id>", "Start from a preset (see `0 agents presets`)").option("--name <name>", "Name").option("--access <level>", `Access: ${ACCESS_HELP}`)
    .addOption(new Option("--autonomy <level>", SENTINEL_AUTONOMY.join(" | ")).hideHelp()).option("--file <path>", "Sentinel JSON object (overrides preset fields)"))
    .action((options: ConsoleFlags & { preset?: string; name?: string; access?: string; autonomy?: string; file?: string }) => withConsole(options, deps, async client => {
      if (!options.preset && !options.file) throw new UsageError("Provide --preset <id> or --file <path>.");
      const body = { ...(options.file ? await readJsonObject(options.file, "Sentinel definition") : {}), ...(options.preset ? { preset: options.preset } : {}), ...(options.name ? { name: options.name } : {}), ...(options.access ? { accessLevel: accessInput("--access", options.access) } : {}), ...(options.autonomy ? { autonomy: oneOf("--autonomy", SENTINEL_AUTONOMY, options.autonomy) } : {}) };
      return view(await client.request("POST", ROOT, body) as { sentinel: Sentinel });
    }, detail));

  consoleFlags(group.command("set <id>").description("Change a Sentinel's settings")
    .option("--name <name>", "Name").option("--mission <text>", "One-line mission")
    .option("--access <level>", `Access: ${ACCESS_HELP}`)
    .addOption(new Option("--autonomy <level>", SENTINEL_AUTONOMY.join(" | ")).hideHelp()).addOption(new Option("--tool-access <level>", SENTINEL_TOOL_ACCESS.join(" | ")).hideHelp())
    .option("--daily-usd <usd>", "Daily budget in USD").option("--max-runs <n>", "Maximum runs per day")
    .option("--file <path>", "Patch JSON object").option("--version <n>", "Reviewed version (default: the current one)"))
    .action((id: string, options: ConsoleFlags & { name?: string; mission?: string; access?: string; autonomy?: string; toolAccess?: string; dailyUsd?: string; maxRuns?: string; file?: string; version?: string }) => withConsole(options, deps, async client => {
      const current = await sentinel(client, id);
      const dailyUsd = positive("--daily-usd", options.dailyUsd);
      const maxRunsPerDay = positive("--max-runs", options.maxRuns);
      const patch: Record<string, unknown> = {
        ...(options.file ? await readJsonObject(options.file, "Sentinel patch") : {}),
        ...(options.name !== undefined ? { name: options.name } : {}), ...(options.mission !== undefined ? { mission: options.mission } : {}),
        ...(options.access ? { accessLevel: accessInput("--access", options.access) } : {}), ...(options.autonomy ? { autonomy: oneOf("--autonomy", SENTINEL_AUTONOMY, options.autonomy) } : {}), ...(options.toolAccess ? { toolAccess: oneOf("--tool-access", SENTINEL_TOOL_ACCESS, options.toolAccess) } : {}),
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

  consoleFlags(group.command("run <id>").description("Run a Sentinel now; starts a thread (needs a running engine)")
    .option("--task <text>", "Task for this run").option("--yes", "Confirm that this run is authorized"))
    .action((id: string, options: ConsoleFlags & { task?: string; yes?: boolean }) => withConsole(options, deps, async client => {
      requireYes(options.yes, "Running a Sentinel starts an autonomous thread within its scope and budget.");
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

  const fileOptions = (command: Command): Command => command.option("--adopt", "Take over an unmanaged Agent with the same name instead of reporting a duplicate")
    .option("--allow-changes", "Allow files that ask for access: changes (the operator decision)").option("--prune", "Also remove Agents this folder managed before but no longer has a file for");
  const toRequest = async (path: string, options: { adopt?: boolean; allowChanges?: boolean; prune?: boolean; force?: boolean }) => {
    const loaded = await loadAgentDocuments(path).catch((error: Error) => { throw new UsageError(error.message); });
    if (loaded.problems.length) throw new UsageError(loaded.problems.map(problem => `${problem.path}: ${problem.message}`).join("\n"));
    return { documents: loaded.documents, root: loaded.root, ...(options.adopt ? { adopt: true } : {}), ...(options.allowChanges ? { allowChanges: true } : {}), ...(options.prune ? { prune: true } : {}), ...(options.force ? { force: true } : {}) };
  };

  consoleFlags(group.command("validate <path...>").description("Check Agent files (files or folders) without touching any Agent"))
    .action(async (paths: string[], options: ConsoleFlags) => {
      const report: Array<{ path: string; id?: string; ok: boolean; errors: Array<{ message: string; line?: number; path: string }>; warnings: string[] }> = [];
      try {
        for (const target of paths) {
          const loaded = await loadAgentDocuments(target);
          for (const problem of loaded.problems) report.push({ path: join(target, problem.path), ok: false, errors: [{ message: problem.message, path: "" }], warnings: [] });
          for (const document of loaded.documents) {
            const parsed = parseAgentFile(document.content);
            report.push({ path: join(loaded.root, document.path), ok: parsed.ok, ...(parsed.ok ? { id: parsed.file.id } : {}), errors: parsed.ok ? [] : parsed.errors, warnings: parsed.ok ? parsed.warnings.map(warning => warning.message) : [] });
          }
        }
      } catch (error) { deps.err(error instanceof Error ? error.message : String(error)); process.exitCode = 2; return; }
      const ok = report.length > 0 && report.every(item => item.ok);
      deps.out(options.json ? JSON.stringify({ ok, files: report }, null, 2) : [...report.map(item => item.ok ? `ok  ${item.path} (${item.id})${item.warnings.map(warning => `\n    note: ${warning}`).join("")}` : `bad ${item.path}\n${item.errors.map(error => `    ${item.path}${error.line ? `:${error.line}` : ""}: ${error.message}`).join("\n")}`), report.length ? `${report.filter(item => item.ok).length} of ${report.length} valid.` : "No Agent files found."].join("\n"));
      if (!ok) process.exitCode = 1;
    });

  fileOptions(consoleFlags(group.command("diff <path>").description("Show what applying Agent files would change, field by field, including edits made in the app since the last apply")))
    .action((path: string, options: ConsoleFlags & { adopt?: boolean; allowChanges?: boolean; prune?: boolean }) => withConsole(options, deps, async client => {
      const result = await client.request("POST", `${ROOT}/plan`, await toRequest(path, options)) as AgentApplyResult;
      if (!result.ok) process.exitCode = 1;
      return result;
    }, renderPlan));

  fileOptions(consoleFlags(group.command("apply <path>").description("Create or update Agents from files; safe to repeat. Files own the Agents they manage")
    .option("--dry-run", "Only show what would change").option("--force", "Overwrite edits made in the app since the last apply").option("--yes", "Confirm --prune")))
    .action((path: string, options: ConsoleFlags & { adopt?: boolean; allowChanges?: boolean; prune?: boolean; force?: boolean; dryRun?: boolean; yes?: boolean }) => withConsole(options, deps, async client => {
      if (options.prune && !options.dryRun) requireYes(options.yes, "Pruning removes Agents that no longer have a file.");
      const result = await client.request("POST", `${ROOT}/${options.dryRun ? "plan" : "apply"}`, await toRequest(path, options)) as AgentApplyResult;
      if (!result.ok) process.exitCode = 1;
      return result;
    }, renderPlan));

  consoleFlags(group.command("export [id]").description("Write an Agent (or all of them, or a preset) as a file. Exporting changes nothing; the Agent becomes managed by the file after the first apply")
    .option("--all", "Every Agent").option("--dir <dir>", "With --all: write one file per Agent into this folder (default .0/agents)").option("--preset <id>", "A built-in preset instead of an Agent").option("--force", "With --dir: overwrite files that already exist"))
    .action((id: string | undefined, options: ConsoleFlags & { all?: boolean; dir?: string; preset?: string; force?: boolean }) => withConsole(options, deps, async client => {
      if ([Boolean(id), Boolean(options.all), Boolean(options.preset)].filter(Boolean).length !== 1) throw new UsageError("Name one Agent, or use --all, or use --preset <id>.");
      if (options.dir && !options.all) throw new UsageError("--dir goes with --all.");
      if (options.preset) return { files: [(await client.request("GET", `/api/console/sentinel-presets/${enc(options.preset)}/file`)) as { path: string; content: string }], written: [] as string[] };
      if (!options.all) return { files: [(await client.request("GET", `${ROOT}/${enc((await sentinel(client, id!)).id)}/file`)) as { path: string; content: string }], written: [] as string[] };
      const files = ((await client.request("GET", `${ROOT}/export-all`)) as { files: Array<{ path: string; content: string }> }).files;
      const dir = resolvePath(options.dir ?? ".0/agents");
      const written: string[] = [];
      await mkdir(dir, { recursive: true });
      for (const item of files) {
        const target = join(dir, item.path);
        if (dirname(target) !== dir) throw new UsageError(`Refusing to write outside ${dir}.`);
        const exists = await stat(target).then(() => true, () => false);
        if (exists && !options.force) { deps.err(`Skipped ${target}: it exists (use --force to overwrite).`); continue; }
        await writeFile(target, item.content, { mode: 0o644 });
        written.push(target);
      }
      return { files: files.map(item => ({ path: item.path })), written };
    }, value => value.written.length || (value.files.length > 1) ? `Wrote ${value.written.length} of ${value.files.length} files. Next: \`0 agents diff <dir> --adopt\`, then \`0 agents apply <dir> --adopt\`.` : (value.files[0] as { content?: string }).content ?? ""));

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
    .option("--file <path>", "Trigger JSON object with schedule or github settings").option("--enable", "Enable immediately").option("--yes", "Confirm that an enabled trigger was reviewed")
    .option("--repo <owner/name>", "github-pr: repository to watch").option("--base-branch <branch>", "github-pr: only pull requests into this branch")
    .option("--comment", "github-pr: comment on each pull request with one short summary, edited in place on later pushes (default: off)")
    .option("--include-forks", "github-pr: also review pull requests from forks, read-only and marked untrusted (default: skipped)"))
    .action((id: string, options: ConsoleFlags & { automation?: string; kind?: string; file?: string; enable?: boolean; yes?: boolean; repo?: string; baseBranch?: string; comment?: boolean; includeForks?: boolean }) => withConsole(options, deps, async client => {
      const fromFile = options.file ? await readJsonObject(options.file, "Trigger definition") : {};
      const flags = { ...(options.repo ? { repo: options.repo } : {}), ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}), ...(options.comment ? { commentOnPr: true } : {}), ...(options.includeForks ? { includeForks: true } : {}) };
      const kind = options.kind ?? fromFile.kind;
      if (Object.keys(flags).length && kind !== "github-pr") throw new UsageError("--repo, --base-branch, --comment and --include-forks apply to --kind github-pr.");
      const github = Object.keys(flags).length ? { github: { ...(fromFile.github && typeof fromFile.github === "object" ? fromFile.github : {}), ...flags } } : {};
      const body = { ...fromFile, ...github, ...(options.automation ? { automationId: options.automation } : {}), ...(options.kind ? { kind: options.kind } : {}) };
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
  consoleFlags(triggers.command("check <id> <trigger-id>").description("Poll a pull request trigger now instead of waiting for its next poll"))
    .action((id: string, triggerId: string, options: ConsoleFlags) => withConsole(options, deps, async client => {
      const owner = await sentinel(client, id);
      const found = resolveId(((await client.request("GET", `${ROOT}/${enc(owner.id)}/triggers`)) as { triggers: Trigger[] }).triggers, triggerId, "Trigger");
      return ((await client.request("POST", `${ROOT}/${enc(owner.id)}/triggers/${enc(found.id)}/check`, {})) as { trigger: Trigger }).trigger;
    }, value => triggerTable([value]), { requireHost: "Checking a pull request trigger" }));
  // Server mode only; hidden because most installs poll. The secret is shown once by `secret rotate` and never again.
  const webhook = group.command("webhook", { hidden: true }).description("GitHub webhook for pull request Agents (server mode)");
  consoleFlags(webhook.command("status").description("Show whether the webhook is set up and the last deliveries"))
    .action((options: ConsoleFlags) => withConsole(options, deps, async client => ((await client.request("GET", `${WEBHOOK_ROOT}`)) as { webhook: WebhookView }).webhook, view => webhookText(view), { requireHost: "Reading the webhook status" }));
  const webhookSecret = webhook.command("secret").description("Manage the webhook secret");
  consoleFlags(webhookSecret.command("rotate").description("Create the secret, or replace it; the old one keeps working for 5 minutes. Printed once.").option("--yes", "Confirm; update the secret on GitHub afterwards"))
    .action((options: ConsoleFlags & { yes?: boolean }) => withConsole(options, deps, async client => {
      requireYes(options.yes, "Rotating the webhook secret means GitHub must be updated with the new one.");
      const current = ((await client.request("GET", WEBHOOK_ROOT)) as { webhook: WebhookView }).webhook;
      if (!current.serverMode) throw new UsageError("The webhook exists only in server mode (0 web --server-mode).");
      return (await client.request("POST", `${WEBHOOK_ROOT}/secret${current.configured ? "/rotate" : ""}`, {})) as { secret: string; graceSeconds?: number; webhook: WebhookView };
    }, value => [`Secret (shown once, store it now): ${value.secret}`, ...(value.graceSeconds ? [`The previous secret still works for ${value.graceSeconds / 60} minutes.`] : []), `Payload URL: ${value.webhook.payloadUrl ?? "set --public-url on the server to derive it"}`, "Content type: application/json", "Events: Pull requests"].join("\n"), { requireHost: "Rotating the webhook secret" }));
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

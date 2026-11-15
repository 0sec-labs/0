import type { Command } from "commander";
import { createSecurityWorkflowTemplate, parseSecurityWorkflowInput, type SecurityWorkflow } from "@0/engine/shared";
import type { ConsoleClient } from "../console-embed-client.js";
import { consoleDefaults, consoleFlags, enc, readJsonObject, renderFields, renderTable, requireYes, resolveId, UsageError, withConsole, type ConsoleCommandDeps, type ConsoleFlags } from "./console-command.js";

const DEFINITIONS = "/api/console/workflow-definitions";
const TRIGGERS = "/api/console/workflow-triggers";

interface Trigger { id: string; workflowId: string; workflowRevision: number; cadence: string; startAt: string; timezone: string; enabled: boolean; nextFireAt?: string | null; lastStatus?: string; version?: number }

async function definitions(client: ConsoleClient): Promise<SecurityWorkflow[]> {
  return ((await client.request("GET", DEFINITIONS)) as { definitions: SecurityWorkflow[] }).definitions;
}
async function definition(client: ConsoleClient, reference: string): Promise<SecurityWorkflow> {
  const found = resolveId(await definitions(client), reference, "Automation");
  return found;
}
const summary = (workflow: SecurityWorkflow) => renderFields({ id: workflow.id, name: workflow.name, revision: workflow.revision, target: workflow.target, steps: workflow.nodes.length, template: workflow.template ? `${workflow.template.id}@${workflow.template.revision}` : undefined, updated: workflow.updatedAt });
/** Same naming rule as the web editor: "X copy", "X copy 2", ... */
function duplicateName(name: string, existing: readonly string[]): string {
  const stem = name.replace(/\s+copy(?: \d+)?$/i, "");
  const taken = new Set(existing.map(item => item.toLowerCase()));
  let candidate = `${stem} copy`;
  for (let index = 2; taken.has(candidate.toLowerCase()); index += 1) candidate = `${stem} copy ${index}`;
  return candidate.length > 160 ? candidate.slice(-160) : candidate;
}
function revisionOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new UsageError("Revision must be a positive integer.");
  return number;
}
function validated(input: unknown) {
  try { return parseSecurityWorkflowInput(input); }
  catch (error) { throw new UsageError(`Invalid automation definition: ${error instanceof Error ? error.message : String(error)}`); }
}
const triggerRows = (triggers: Trigger[]) => renderTable(triggers, [
  { header: "ID", value: t => t.id }, { header: "ENABLED", value: t => (t.enabled ? "yes" : "no") }, { header: "CADENCE", value: t => t.cadence },
  { header: "NEXT RUN", value: t => t.nextFireAt ?? "-" }, { header: "LAST", value: t => t.lastStatus ?? "-" },
]);

/** Create, edit, copy, version, rollback and delete saved automations, plus their schedules. */
export function registerAutomationManageCommands(automation: Command, deps: ConsoleCommandDeps = consoleDefaults): void {
  consoleFlags(automation.command("create").description("Create an automation from a template or a JSON definition")
    .option("--template <id>", "Start from a template (see `0 automation list --templates`)")
    .option("--file <path>", "Definition JSON object")
    .option("--name <name>", "Name for the new automation")
    .option("--target <target>", "Target the automation runs against"))
    .action((options: ConsoleFlags & { template?: string; file?: string; name?: string; target?: string }) => withConsole(options, deps, async client => {
      if (Boolean(options.template) === Boolean(options.file)) throw new UsageError("Select exactly one of --template <id> or --file <path>.");
      let input;
      if (options.template) {
        try { input = createSecurityWorkflowTemplate(options.template, options.target !== undefined ? { target: options.target } : {}); }
        catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
      } else input = validated({ ...(await readJsonObject(options.file!, "Automation definition")), ...(options.target !== undefined ? { target: options.target } : {}) });
      if (options.name) input = validated({ ...input, name: options.name });
      return ((await client.request("POST", DEFINITIONS, input)) as { definition: SecurityWorkflow }).definition;
    }, summary));

  consoleFlags(automation.command("edit <id>").description("Replace an automation's definition from a JSON file")
    .requiredOption("--file <path>", "Definition JSON object")
    .option("--revision <n>", "Reviewed revision to edit (default: the current one)"))
    .action((id: string, options: ConsoleFlags & { file: string; revision?: string }) => withConsole(options, deps, async client => {
      const current = await definition(client, id);
      // `show --format json` output round-trips: server-owned timestamps are ignored.
      const { createdAt: _created, updatedAt: _updated, ...body } = await readJsonObject(options.file, "Automation definition");
      const input = validated({ ...body, id: current.id, revision: revisionOption(options.revision) ?? (typeof body.revision === "number" ? body.revision : current.revision) });
      return ((await client.request("PATCH", `${DEFINITIONS}/${enc(current.id)}`, input)) as { definition: SecurityWorkflow }).definition;
    }, summary));

  consoleFlags(automation.command("duplicate <id>").description("Save a copy of an automation").option("--name <name>", "Name for the copy"))
    .action((id: string, options: ConsoleFlags & { name?: string }) => withConsole(options, deps, async client => {
      const all = await definitions(client);
      const source = resolveId(all, id, "Automation");
      const { id: _id, revision: _revision, createdAt: _created, updatedAt: _updated, ...rest } = source;
      const input = validated({ ...rest, name: options.name ?? duplicateName(source.name, all.map(item => item.name)) });
      return ((await client.request("POST", DEFINITIONS, input)) as { definition: SecurityWorkflow }).definition;
    }, summary));

  consoleFlags(automation.command("versions <id>").description("List saved revisions of an automation"))
    .action((id: string, options: ConsoleFlags) => withConsole(options, deps, async client => {
      const current = await definition(client, id);
      return (await client.request("GET", `${DEFINITIONS}/${enc(current.id)}/versions`)) as { versions: Array<{ revision: number; name?: string; createdAt?: string; updatedAt?: string }> };
    }, ({ versions }) => renderTable(versions, [{ header: "REVISION", value: v => v.revision }, { header: "NAME", value: v => v.name }, { header: "SAVED", value: v => v.updatedAt ?? v.createdAt }])));

  consoleFlags(automation.command("rollback <id>").description("Restore an earlier revision as a new revision")
    .requiredOption("--revision <n>", "Revision to restore (see `0 automation versions`)"))
    .action((id: string, options: ConsoleFlags & { revision: string }) => withConsole(options, deps, async client => {
      const revision = revisionOption(options.revision)!;
      const current = await definition(client, id);
      return ((await client.request("POST", `${DEFINITIONS}/${enc(current.id)}/rollback`, { revision, expectedRevision: current.revision })) as { definition: SecurityWorkflow }).definition;
    }, summary));

  consoleFlags(automation.command("delete <id>").description("Delete a saved automation and its schedules")
    .option("--revision <n>", "Reviewed revision to delete (default: the current one)")
    .option("--yes", "Confirm deletion"))
    .action((id: string, options: ConsoleFlags & { revision?: string; yes?: boolean }) => withConsole(options, deps, async client => {
      requireYes(options.yes, "Deleting an automation cannot be undone.");
      const current = await definition(client, id);
      await client.request("DELETE", `${DEFINITIONS}/${enc(current.id)}?revision=${revisionOption(options.revision) ?? current.revision}`);
      return { ok: true, id: current.id };
    }, result => `Deleted automation ${result.id}`));

  const triggers = automation.command("triggers").description("Inspect and control an automation's schedules (needs a running engine)");
  consoleFlags(triggers.command("list <id>").description("List schedules for an automation"))
    .action((id: string, options: ConsoleFlags) => withConsole(options, deps, async client => {
      const current = await definition(client, id);
      return ((await client.request("GET", `${TRIGGERS}?workflowId=${enc(current.id)}`)) as { triggers: Trigger[] }).triggers;
    }, triggerRows, { requireHost: "Schedules" }));
  consoleFlags(triggers.command("enable <trigger-id>").description("Enable a schedule after reviewing it; it then runs unattended").option("--yes", "Confirm that this schedule was reviewed"))
    .action((triggerId: string, options: ConsoleFlags & { yes?: boolean }) => withConsole(options, deps, async client => {
      requireYes(options.yes, "Enabling a schedule lets the automation run unattended.");
      const found = await trigger(client, triggerId);
      return ((await client.request("PATCH", `${TRIGGERS}/${enc(found.id)}`, { enabled: true, approval: "enable-reviewed-trigger", expectedVersion: found.version })) as { trigger: Trigger }).trigger;
    }, value => triggerRows([value]), { requireHost: "Schedules" }));
  consoleFlags(triggers.command("disable <trigger-id>").description("Pause a schedule"))
    .action((triggerId: string, options: ConsoleFlags) => withConsole(options, deps, async client => {
      const found = await trigger(client, triggerId);
      return ((await client.request("PATCH", `${TRIGGERS}/${enc(found.id)}`, { enabled: false, expectedVersion: found.version })) as { trigger: Trigger }).trigger;
    }, value => triggerRows([value]), { requireHost: "Schedules" }));
  consoleFlags(triggers.command("remove <trigger-id>").description("Delete a schedule").option("--yes", "Confirm deletion"))
    .action((triggerId: string, options: ConsoleFlags & { yes?: boolean }) => withConsole(options, deps, async client => {
      requireYes(options.yes, "Removing a schedule cannot be undone.");
      const found = await trigger(client, triggerId);
      await client.request("DELETE", `${TRIGGERS}/${enc(found.id)}`);
      return { ok: true, id: found.id };
    }, result => `Removed schedule ${result.id}`, { requireHost: "Schedules" }));
}

async function trigger(client: ConsoleClient, reference: string): Promise<Trigger> {
  const all = ((await client.request("GET", TRIGGERS)) as { triggers: Trigger[] }).triggers;
  return resolveId(all, reference, "Schedule");
}

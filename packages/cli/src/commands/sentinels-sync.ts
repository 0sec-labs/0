import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { resolveOsecDbPath, SecurityWorkflowStore, SentinelStore } from "@0/engine/storage";
import { assertLocalEngineAvailable } from "../local-engine.js";
import { applySync, exportDefinition, loadDefinitions, planSync, type SyncChange } from "../sentinel-sync.js";
import { finishWithError, UsageError } from "./output.js";

function openStores(dbPath: string | undefined) {
  assertLocalEngineAvailable(dbPath);
  const path = resolveOsecDbPath(dbPath);
  const sentinels = new SentinelStore(path);
  const workflows = new SecurityWorkflowStore(path);
  return { sentinels, workflows, close: () => { sentinels.close(); workflows.close(); } };
}

const line = (change: SyncChange): string => `${change.action === "unchanged" ? "  =" : change.action === "create" ? "  +" : "  ~"} ${change.sentinel}${change.changes.length ? `: ${change.changes.join(", ")}` : ""}`;

/** `0 sentinels sync` and `0 sentinels export`: Sentinels as YAML files in a git repository. */
export function registerSentinelsSyncCommands(group: Command): void {
  group.command("sync")
    .description("Make Sentinels match the YAML files in a folder. Shows what would change; --apply writes it.")
    .argument("<folder>", "Folder of Sentinel definitions (*.yaml), for example .0/sentinels")
    .option("--apply", "Write the changes (without it, only the plan is shown)")
    .option("--check", "Exit 1 when the database differs from the files")
    .option("--commit <sha>", "Commit the files came from; recorded on each Sentinel")
    .option("--enable", "Enable the triggers this sync creates (only for a change that was already reviewed)")
    .option("--db-path <path>", "Database to change; stop its running console first")
    .option("--format <format>", "Output: text or json", "text")
    .action((folder: string, options: { apply?: boolean; check?: boolean; commit?: string; enable?: boolean; dbPath?: string; format?: string }) => {
      let stores: ReturnType<typeof openStores> | undefined;
      try {
        if (options.enable && !options.apply) throw new UsageError("--enable needs --apply.");
        const definitions = loadDefinitions(resolve(folder));
        stores = openStores(options.dbPath);
        const changes = options.apply
          ? applySync(definitions, stores, { ...(options.commit ? { commit: options.commit } : {}), ...(options.enable ? { enable: true } : {}) })
          : planSync(definitions, stores);
        const pending = changes.filter(change => change.action !== "unchanged").length;
        if (options.format === "json") process.stdout.write(`${JSON.stringify({ applied: options.apply === true, changes })}\n`);
        else {
          process.stdout.write(`${changes.map(line).join("\n")}\n`);
          process.stdout.write(options.apply ? `${pending} changed. New Sentinels are paused and new triggers are disabled until you enable them.\n` : pending ? `${pending} would change. Run again with --apply to write it.\n` : "Nothing to change.\n");
        }
        if (options.check && pending) process.exitCode = 1;
      } catch (error) { finishWithError(error, { err: text => process.stderr.write(`${text}\n`) }, options.format === "json"); }
      finally { stores?.close(); }
    });

  group.command("export")
    .description("Write a Sentinel as a YAML definition file, so a team can start from what it already has")
    .argument("<id>", "Sentinel ID (full or prefix) or exact name")
    .option("--out <folder>", "Write <name>.yaml into this folder instead of standard output")
    .option("--db-path <path>", "Database to read; stop its running console first")
    .action((id: string, options: { out?: string; dbPath?: string }) => {
      let stores: ReturnType<typeof openStores> | undefined;
      try {
        stores = openStores(options.dbPath);
        const all = stores.sentinels.list();
        const matches = all.filter(sentinel => sentinel.id === id || sentinel.name === id).concat(all.filter(sentinel => sentinel.id.startsWith(id) && sentinel.id !== id && sentinel.name !== id));
        if (matches.length !== 1) throw new UsageError(matches.length ? `'${id}' matches ${matches.length} Sentinels; use more of the id.` : `Sentinel '${id}' not found.`);
        const text = exportDefinition(matches[0]!, stores);
        if (!options.out) { process.stdout.write(text); return; }
        const folder = resolve(options.out);
        mkdirSync(folder, { recursive: true });
        const file = join(folder, `${matches[0]!.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sentinel"}.yaml`);
        writeFileSync(file, text, { mode: 0o644 });
        process.stdout.write(`${file}\n`);
      } catch (error) { finishWithError(error, { err: text => process.stderr.write(`${text}\n`) }, false); }
      finally { stores?.close(); }
    });
}

// `0 skills add <source>` and `0 skills extensions ...`: the CLI adapter over the engine's extension service.
// An extension is an installable git folder pinned by commit that can bundle skills, scripts run through bash, MCP
// server definitions, a connector, a scope policy and a verifier. This file only parses arguments and prints: every
// decision (pin, diff, approval, tamper check, env allowlist) lives in the engine.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { approvalFor, approvalRefusal, createExtensionService, renderInstallPrompt, type ExtensionService, type PreparedInstall } from "@0/engine";
import { EXIT_FAILURE, EXIT_USAGE, UsageError, consoleOptions, emit, renderTable, type CommandIo, type OutputOptions } from "./console-output.js";

type Options = OutputOptions & { yes?: boolean; preview?: boolean; enable?: boolean; project?: string; to?: string; force?: boolean };

/** A bare `owner/repo` (two segments, not a folder). It goes through the extension flow first; a repo with no extension layout falls back to the catalog flow. */
export const isBareRepo = (source: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(source) && !existsSync(resolve(source));

/** `source@<40 hex>`, an https URL, a path or a bare owner/repo: handled here. Catalog ids and owner/repo/path stay on the catalog flow. */
export function isExtensionSource(source: string): boolean {
  return /@[0-9a-f]{40}$/.test(source) || /^https:\/\//i.test(source) || /^(\/|\.\/|\.\.\/|~\/)/.test(source) || existsSync(resolve(source)) || isBareRepo(source);
}

const fail = (io: CommandIo, options: OutputOptions, message: string, code = EXIT_FAILURE) => { io.err(options.json ? JSON.stringify({ error: message }) : message); io.setExitCode(code); };

/** Approval-bearing commands are the operator's: refuse from an agent session or without a terminal (a flag alone never approves). */
function operatorOnly(io: CommandIo, options: OutputOptions, what: string): boolean {
  const refusal = approvalRefusal(what);
  if (refusal) fail(io, options, refusal, EXIT_USAGE);
  return refusal === null;
}

/** Run the one-time importer on first use and say so. */
function ensureImported(svc: ExtensionService, io: CommandIo, options: OutputOptions): void {
  const r = svc.importer.run();
  if (r.ok && !r.value.alreadyDone && (r.value.migrated.length || r.value.notMigrated.length) && !options.json) {
    io.err(`Imported ${r.value.migrated.length} item(s) from your earlier setup; ${r.value.notMigrated.length} could not be migrated. See \`0 skills extensions import --report\`.`);
  }
}

async function guarded(io: CommandIo, options: Options, fn: (svc: ExtensionService) => Promise<void> | void): Promise<void> {
  try { const svc = createExtensionService(); ensureImported(svc, io, options); await fn(svc); }
  catch (error) { fail(io, options, error instanceof Error ? error.message : String(error), error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE); }
}

function showPrompt(io: CommandIo, options: Options, prepared: PreparedInstall, tail: string): void {
  emit(io, options, { prompt: prepared.prompt, installed: false }, () => `${renderInstallPrompt(prepared.prompt)}\n${tail}`.trimEnd());
}

/** Returns "not-extension" (and prints nothing) when a bare owner/repo has no extension or skill layout, so the caller can try the catalog flow. */
export async function addExtension(io: CommandIo, source: string, options: Options): Promise<"done" | "not-extension"> {
  let outcome: "done" | "not-extension" = "done";
  await guarded(io, options, async svc => {
    const prepared = await svc.installer.prepare(source);
    if (!prepared.ok) { if (isBareRepo(source) && prepared.error.code === "invalid_manifest") { outcome = "not-extension"; return; } return fail(io, options, prepared.error.message); }
    const p = prepared.value;
    const pinnedInput = /@[0-9a-f]{40}$/.test(source);
    if (options.preview) return showPrompt(io, options, p, "");
    if (options.yes !== true) { showPrompt(io, options, p, p.snapshot.source.type === "git" && !pinnedInput ? `Re-run with \`0 skills add ${source}@${p.prompt.revision} --yes\` to install this exact revision.` : `Re-run with --yes to install this exact revision (${p.prompt.revision}).`); io.setExitCode(EXIT_USAGE); return; }
    if (!operatorOnly(io, options, "install an extension")) return;
    if (!pinnedInput && p.snapshot.source.type === "git") return fail(io, options, `Refusing to install an unpinned commit with --yes. Pin it: ${source}@${p.prompt.revision}`, EXIT_USAGE);
    const done = svc.installer.commit(p, approvalFor(p, options.enable ? (options.project ? { scope: "project" as const, project: resolve(options.project) } : { scope: "global" as const }) : undefined));
    if (!done.ok) return fail(io, options, done.error.message);
    emit(io, options, { installed: true, name: done.value.name, revision: done.value.revision, enabled: options.enable === true }, () => `Installed extension ${done.value.name} at ${done.value.revision.slice(0, 12)}.${options.enable ? "" : ` Not enabled: \`0 skills extensions enable ${done.value.name}\`.`}`);
  });
  return outcome;
}

export function registerExtensionCommands(skills: Command, io: CommandIo): void {
  const ext = skills.command("extensions").description("Installed extensions: list, info, enable, disable, update, remove (install with `0 skills add`)");

  consoleOptions(ext.command("add <source>").description("Install an extension: <url|owner/repo|folder>@<full sha>; same as `0 skills add`").option("--preview", "Only show the install prompt").option("--yes", "Install the exact revision shown").option("--enable", "Also enable it").option("--project <dir>", "With --enable: enable for this project only"))
    .action(async (source: string, options: Options) => { await addExtension(io, source, options); });

  consoleOptions(ext.command("list").description("List installed extensions and built-ins").option("--project <dir>", "Show enablement for this project"))
    .action((options: Options) => guarded(io, options, svc => {
      const { rows, error } = svc.list(options.project ? resolve(options.project) : undefined);
      if (error) return fail(io, options, error);
      emit(io, options, { extensions: rows }, () => renderTable(rows.map(r => [r.name, r.kind, r.status === "built-in" ? (r.enabled ? "on" : "off") : r.status, r.revision?.slice(0, 12) ?? "-", r.detail.slice(0, 60)]), ["NAME", "KIND", "STATUS", "REVISION", "NOTE"]));
    }));

  consoleOptions(ext.command("info <name>").description("Show the install prompt for an installed extension"))
    .action((name: string, options: Options) => guarded(io, options, svc => {
      const r = svc.info(name); if (!r.ok) return fail(io, options, r.error.message);
      emit(io, options, { prompt: r.value.prompt, enabled: r.value.entry.enabled }, () => renderInstallPrompt(r.value.prompt));
    }));

  consoleOptions(ext.command("enable <name>").description("Enable globally, or for one project with --project").option("--project <dir>", "Enable for this project only").option("--yes", "Approve an unapproved revision (for example an imported one)"))
    .action((name: string, options: Options) => guarded(io, options, svc => {
      if (!operatorOnly(io, options, "change extension enablement")) return;
      const r = svc.installer.enable(name, { ...(options.project ? { project: resolve(options.project) } : {}), approve: options.yes === true });
      if (!r.ok) return fail(io, options, r.error.message, r.error.code === "needs_approval" ? EXIT_USAGE : EXIT_FAILURE);
      emit(io, options, r.value, () => `Enabled ${name}${options.project ? ` for ${resolve(options.project)}` : ""}.`);
    }));

  consoleOptions(ext.command("disable <name>").description("Disable globally, or for one project with --project").option("--project <dir>", "Disable for this project only").option("--yes", "Confirm disabling a built-in"))
    .action((name: string, options: Options) => guarded(io, options, svc => {
      if (!operatorOnly(io, options, "change extension enablement")) return;
      const r = svc.installer.disable(name, { ...(options.project ? { project: resolve(options.project) } : {}), confirm: options.yes === true });
      if (!r.ok) return fail(io, options, r.error.code === "needs_confirmation" ? `${r.error.message} Re-run with --yes to confirm.` : r.error.message, r.error.code === "needs_confirmation" ? EXIT_USAGE : EXIT_FAILURE);
      emit(io, options, r.value, () => `Disabled ${name}.`);
    }));

  consoleOptions(ext.command("remove <name>").description("Remove an installed extension and its stored revisions").option("--yes", "Confirm the removal"))
    .action((name: string, options: Options) => guarded(io, options, svc => {
      if (options.yes !== true) throw new UsageError(`This removes extension ${name}. Re-run with --yes to confirm.`);
      if (!operatorOnly(io, options, "remove an extension")) return;
      const r = svc.installer.remove(name); if (!r.ok) return fail(io, options, r.error.message);
      emit(io, options, r.value, () => `Removed ${name}.`);
    }));

  consoleOptions(ext.command("update <name>").description("Show the diff and install prompt for a newer revision; --yes --to <sha> approves it").option("--to <sha>", "Full commit SHA to update to (default: the remote HEAD)").option("--yes", "Approve the revision given by --to"))
    .action((name: string, options: Options) => guarded(io, options, async svc => {
      const r = await svc.installer.prepareUpdate(name, options.to);
      if (!r.ok) return fail(io, options, r.error.message);
      if ("upToDate" in r.value) { const { revision } = r.value; return emit(io, options, { upToDate: true, revision }, () => `${name} is up to date at ${revision.slice(0, 12)}.`); }
      const p = r.value;
      if (options.yes !== true) { showPrompt(io, options, p, `Re-run with --yes --to ${p.prompt.revision} to approve this revision.`); io.setExitCode(EXIT_USAGE); return; }
      if (!operatorOnly(io, options, "approve an extension update")) return;
      if (p.prompt.pinned && options.to !== p.prompt.revision) return fail(io, options, `--yes needs --to ${p.prompt.revision}: approve the exact revision you reviewed.`, EXIT_USAGE);
      const done = svc.installer.commit(p, approvalFor(p));
      if (!done.ok) return fail(io, options, done.error.message);
      emit(io, options, { updated: true, ...done.value }, () => `Updated ${name} to ${done.value.revision.slice(0, 12)}.`);
    }));

  consoleOptions(ext.command("import").description("Import earlier plugins, MCP servers and skills (runs once automatically); shows what could not be migrated").option("--force", "Run the importer again"))
    .action((options: Options) => guarded(io, options, svc => {
      if (!operatorOnly(io, options, "import earlier extensions")) return;
      const r = svc.importer.run({ force: options.force === true }); if (!r.ok) return fail(io, options, r.error.message);
      const rep = r.value;
      emit(io, options, rep, () => [`Imported ${rep.migrated.length}, could not migrate ${rep.notMigrated.length}${rep.alreadyDone ? " (earlier run)" : ""}.`, ...rep.migrated.map(i => `  ok   ${i.kind} ${i.name}: ${i.detail}`), ...rep.notMigrated.map(i => `  skip ${i.kind} ${i.name}: ${i.detail}`), ...rep.notes.map(n => `  note ${n}`)].join("\n"));
    }));
}

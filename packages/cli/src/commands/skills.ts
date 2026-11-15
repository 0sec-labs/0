// `0 skills` — everything the Skills page does: browse the catalog, add, list, show, create, edit,
// copy, delete, import, export and link folders. Same route table as the web UI.
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Command } from "commander";
import type { ConsoleClient } from "../console-client.js";
import { UsageError, consoleOptions, defaultIo, emit, expectOk, renderTable, requireYes, runConsole, type CommandIo, type OutputOptions } from "./output.js";

interface SkillRow { id: string; name: string; description: string; scope: string; writable: boolean; revision: string }
interface CatalogRow { id: string; name: string; summary: string; verified: boolean; installable: boolean; installed: { current: boolean } | null; publisher: string }

const skillPath = (id: string) => `/api/skills/${encodeURIComponent(id)}`;
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const MAX_FILES = 256;

function readText(file: string): string {
  try { return readFileSync(resolve(file), "utf8"); } catch { throw new UsageError(`Cannot read ${file}.`); }
}

/** A skill folder as the `agent-skill` bundle the Import button accepts. */
export function bundleFromDirectory(directory: string): unknown {
  const root = resolve(directory);
  const files: Array<{ path: string; encoding: "base64"; content: string }> = [];
  const visit = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new UsageError("Skill folders cannot contain symbolic links.");
      if (entry.isDirectory()) visit(path, `${prefix}${entry.name}/`);
      else if (entry.isFile()) { if (files.length >= MAX_FILES) throw new UsageError("Skill folder has too many files."); files.push({ path: `${prefix}${entry.name}`, encoding: "base64", content: readFileSync(path).toString("base64") }); }
    }
  };
  try { visit(root, ""); } catch (error) { if (error instanceof UsageError) throw error; throw new UsageError(`Cannot read folder ${directory}.`); }
  const skillMd = files.find(file => file.path === "SKILL.md");
  if (!skillMd) throw new UsageError(`${directory} has no SKILL.md.`);
  const name = /^name:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(Buffer.from(skillMd.content, "base64").toString("utf8"))?.[1] ?? basename(root);
  return { format: "agent-skill", version: 1, name, files };
}

function loadBundle(source: string): unknown {
  const path = resolve(source);
  let isDirectory: boolean;
  try { isDirectory = lstatSync(path).isDirectory(); } catch { throw new UsageError(`Cannot read ${source}.`); }
  if (isDirectory) return bundleFromDirectory(path);
  try { return JSON.parse(readText(path)); } catch (error) { if (error instanceof UsageError) throw error; throw new UsageError(`${source} is not valid JSON.`); }
}

/** Accepts a skill id or its unique name, like the web list does when you click a row. */
async function resolveSkill(client: ConsoleClient, reference: string): Promise<string> {
  const rows = (record(expectOk(await client.request("GET", "/api/skills"))).skills ?? []) as SkillRow[];
  const exact = rows.find(row => row.id === reference);
  if (exact) return exact.id;
  const named = rows.filter(row => row.name === reference);
  if (named.length === 1) return named[0]!.id;
  if (named.length > 1) throw new Error(`Several skills are named ${reference}; use one of: ${named.map(row => row.id).join(", ")}.`);
  throw new Error(`No skill matches ${reference}. See \`0 skills list\`.`);
}

const listSkills = async (io: CommandIo, options: OutputOptions) => runConsole(io, options, async client => {
  const data = record(expectOk(await client.request("GET", "/api/skills")));
  const skills = (data.skills ?? []) as SkillRow[];
  emit(io, options, data, () => skills.length ? renderTable(skills.map(skill => [skill.id, skill.scope, skill.writable ? "yes" : "no", skill.description.slice(0, 70)]), ["ID", "SCOPE", "EDITABLE", "DESCRIPTION"]) : "No skills found.");
});

export function registerSkillsCommand(program: Command, io: CommandIo = defaultIo()): void {
  const skills = program.command("skills").description("Browse, add, create, edit, import, export and link skills");
  const run = (options: OutputOptions, fn: Parameters<typeof runConsole>[2]) => runConsole(io, options, fn);

  consoleOptions(skills.command("list").description("List installed skills and linked folders")).action((options: OutputOptions) => listSkills(io, options));

  consoleOptions(skills.command("show <id-or-name>").description("Show a skill's SKILL.md and files")).action((id: string, options: OutputOptions) => run(options, async client => {
    const skill = record(record(expectOk(await client.request("GET", skillPath(await resolveSkill(client, id))))).skill);
    emit(io, options, { skill }, () => `${String(skill.name)}  (${String(skill.scope)}, revision ${String(skill.revision).slice(0, 12)})\n\n${String(skill.content)}`);
  }));

  consoleOptions(skills.command("new <file>").description("Create a skill from a SKILL.md file")).action((file: string, options: OutputOptions) => run(options, async client => {
    const skill = record(record(expectOk(await client.request("POST", "/api/skills", { content: readText(file) }))).skill);
    emit(io, options, { skill }, () => `Created skill ${String(skill.name)}.`);
  }));

  consoleOptions(skills.command("edit <id>").description("Replace a skill's SKILL.md with the contents of --file").requiredOption("--file <path>", "SKILL.md with the new content"))
    .action((id: string, options: OutputOptions & { file: string }) => run(options, async client => {
      const content = readText(options.file); id = await resolveSkill(client, id);
      const current = record(record(expectOk(await client.request("GET", skillPath(id)))).skill);
      const skill = record(record(expectOk(await client.request("PUT", skillPath(id), { content, expectedRevision: current.revision }))).skill);
      emit(io, options, { skill }, () => `Updated skill ${String(skill.name)}.`);
    }));

  consoleOptions(skills.command("copy <id>").description("Save a workspace copy of a skill under a new name").requiredOption("--name <name>", "Name for the copy (lowercase letters, digits, hyphens)"))
    .action((id: string, options: OutputOptions & { name: string }) => run(options, async client => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.name)) throw new UsageError("--name must be lowercase letters, digits and hyphens.");
      id = await resolveSkill(client, id);
      const current = record(record(expectOk(await client.request("GET", skillPath(id)))).skill);
      const content = String(current.content).replace(/^name:.*$/m, `name: ${options.name}`);
      const skill = record(record(expectOk(await client.request("POST", `${skillPath(id)}/copy`, { content, expectedRevision: current.revision }))).skill);
      emit(io, options, { skill }, () => `Copied to ${String(skill.name)}.`);
    }));

  consoleOptions(skills.command("delete <id>").description("Delete a skill from the workspace library").option("--yes", "Confirm the deletion"))
    .action((id: string, options: OutputOptions & { yes?: boolean }) => run(options, async client => {
      requireYes(options.yes, `This deletes skill ${id}.`);
      id = await resolveSkill(client, id);
      expectOk(await client.request("DELETE", skillPath(id)));
      emit(io, options, { ok: true, id }, () => `Deleted skill ${id}.`);
    }));

  consoleOptions(skills.command("import <bundle>").description("Import a skill bundle (.skill.json) or a folder with SKILL.md")).action((source: string, options: OutputOptions) => run(options, async client => {
    const skill = record(record(expectOk(await client.request("POST", "/api/skills/import", { bundle: loadBundle(source) }))).skill);
    emit(io, options, { skill }, () => `Imported skill ${String(skill.name)}.`);
  }));

  consoleOptions(skills.command("export <id>").description("Export a skill as a bundle").option("-o, --output <file>", "Write the bundle to a file instead of stdout"))
    .action((id: string, options: OutputOptions & { output?: string }) => run(options, async client => {
      const bundle = expectOk(await client.request("GET", `${skillPath(await resolveSkill(client, id))}/export`));
      if (options.output) { writeFileSync(resolve(options.output), `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 }); emit(io, options, { ok: true, file: options.output }, () => `Wrote ${options.output}.`); }
      else io.out(JSON.stringify(bundle, null, 2));
    }));

  consoleOptions(skills.command("link <folder>").description("Link a folder of skills; they stay where they are")).action((folder: string, options: OutputOptions) => run(options, async client => {
    const mount = record(record(expectOk(await client.request("POST", "/api/skills/mounts", { path: resolve(folder) }))).mount);
    emit(io, options, { mount }, () => `Linked ${String(mount.path)} (${String(mount.id)}).`);
  }));

  consoleOptions(skills.command("unlink <id>").description("Unlink a folder by its link id (see `0 skills list --json`)")).action((id: string, options: OutputOptions) => run(options, async client => {
    expectOk(await client.request("DELETE", `/api/skills/mounts/${encodeURIComponent(id)}`));
    emit(io, options, { ok: true, id }, () => `Unlinked ${id}.`);
  }));

  consoleOptions(skills.command("catalog").description("Browse the skills catalog").option("--search <text>", "Filter by name, publisher or summary"))
    .action((options: OutputOptions & { search?: string }) => run(options, async client => {
      const data = record(expectOk(await client.request("GET", "/api/console/skills/catalog")));
      const needle = options.search?.toLowerCase();
      const rows = ((data.skills ?? []) as CatalogRow[]).filter(row => !needle || `${row.id} ${row.name} ${row.publisher} ${row.summary}`.toLowerCase().includes(needle));
      emit(io, options, { ...data, skills: rows }, () => rows.length ? renderTable(rows.map(row => [row.id, row.installed ? (row.installed.current ? "added" : "update") : row.installable ? "-" : "blocked", row.summary.slice(0, 70)]), ["ID", "STATE", "SUMMARY"]) : "No catalog skills match.");
    }));

  consoleOptions(skills.command("add <catalog-id-or-repo>").description("Add a skill from the catalog or GitHub (owner/repo[/path]); shows a review first")
    .option("--preview", "Only show the review").option("--yes", "Install the reviewed commit"))
    .action((source: string, options: OutputOptions & { preview?: boolean; yes?: boolean }) => run(options, async client => {
      const repo = /^([^/]+\/[^/]+)(?:\/(.+))?$/.exec(source);
      const target = repo ? { repo: repo[1], path: repo[2] ?? "" } : { id: source };
      const review = record(expectOk(await client.request("POST", "/api/console/skills/catalog/preview", target)));
      const files = (review.files as unknown[] | undefined)?.length ?? 0;
      const summary = () => [`${String(review.title)} (${String(review.name)}) from ${String(review.repo)} at ${String(review.sha).slice(0, 12)}`, `${files} files, licence ${String(record(review.licence).spdx ?? "unknown")}${review.verified ? ", verified catalog entry" : ""}`, ...((review.warnings as string[] | undefined) ?? []).map(warning => `warning: ${warning}`)].join("\n");
      if (options.preview || options.yes !== true) {
        emit(io, options, { review, installed: false }, () => `${summary()}\n${options.preview ? "" : "Re-run with --yes to install this exact commit."}`.trimEnd());
        if (!options.preview) io.setExitCode(2);
        return;
      }
      const installed = record(record(expectOk(await client.request("POST", "/api/console/skills/catalog/install", { ...target, sha: review.sha }))).skill);
      emit(io, options, { skill: installed, installed: true }, () => `Added skill ${String(installed.name)} at ${String(review.sha).slice(0, 12)}.`);
    }));

  consoleOptions(skills.command("remove <name>").description("Remove a skill that was added from GitHub or the catalog").option("--yes", "Confirm the removal"))
    .action((name: string, options: OutputOptions & { yes?: boolean }) => run(options, async client => {
      requireYes(options.yes, `This removes skill ${name}.`);
      expectOk(await client.request("POST", "/api/console/skills/catalog/remove", { name }));
      emit(io, options, { ok: true, name }, () => `Removed skill ${name}.`);
    }));
}

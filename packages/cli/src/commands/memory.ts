// `0 memory`: the one list of short notes 0 remembers across threads, per folder and global.
// The notes are plain files under ~/.0/memory, so this command works with no engine running.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { NOTE_KINDS, applyExportSection, canonicalFolder, exportArchive, exportable, importArchive, isArchive, isKind, lineChanges, memoryOverview, openMemory, overflowLine, renderExportSection, type Note, type NoteKind, type NoteStore } from "@0/engine";
import { EXIT_FAILURE, EXIT_USAGE, UsageError, defaultIo, emit, renderTable, requireYes, type CommandIo } from "./console-output.js";

interface Common { json?: boolean; dbPath?: string }
const common = (command: Command): Command => command.option("--json", "Print machine-readable JSON").option("--db-path <path>", "Engine database to import older memories from");
const place = (note: Note) => (note.scope === "global" ? "global" : note.folder ?? "folder");

export function registerMemoryCommand(program: Command, io: CommandIo = defaultIo()): void {
  const memory = program.command("memory").description("List, add, remove, review, export and import what 0 remembers across threads");
  const run = async (options: Common, fn: (store: NoteStore) => void | Promise<void>) => {
    try { await fn(openMemory({ ...(options.dbPath ? { dbPath: options.dbPath } : {}) })); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.err(options.json ? JSON.stringify({ error: message }) : message);
      io.setExitCode(error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE);
    }
  };
  const kindOf = (value?: string): NoteKind | undefined => {
    if (value === undefined) return undefined;
    if (!isKind(value)) throw new UsageError(`--kind must be one of ${NOTE_KINDS.join(", ")}.`);
    return value;
  };

  common(memory.command("list").description("List notes, and say which ones do not fit what the model is shown").option("--folder <path>", "Only notes for this folder").option("--global", "Only global notes").option("--search <text>", "Only notes containing this text"))
    .action((options: Common & { folder?: string; global?: boolean; search?: string }) => run(options, store => {
      const notes = store.list({ ...(options.folder ? { folder: options.folder } : {}), ...(options.global ? { scope: "global" as const } : {}), ...(options.search ? { query: options.search } : {}) });
      const view = memoryOverview(store, options.folder ?? process.cwd());
      const left = new Set(view.omitted.map(note => note.id));
      const proposed = store.list({ status: "proposed" }).length;
      const overflow = { count: view.omitted.length, ids: [...left], ...(view.reason ? { reason: view.reason } : {}) };
      emit(io, options, { enabled: store.enabled(), notes, overflow, proposed }, () => [
        notes.length ? renderTable(notes.map(note => [note.id + (left.has(note.id) ? " *" : ""), place(note), note.kind ?? "", note.text.slice(0, 90)]), ["ID", "WHERE", "KIND", "NOTE"]) : "Nothing remembered yet.",
        ...(left.size ? [`* ${overflowLine(left.size)} Not shown to the model: ${view.reason}.`] : []),
        ...(proposed ? [`${proposed} proposed note${proposed === 1 ? "" : "s"} waiting for review: 0 memory proposed list`] : []),
      ].join("\n"));
    }));

  common(memory.command("add <text>").description("Remember a note").option("--folder <path>", "Folder the note is about (default: this folder)").option("--global", "Remember it everywhere").option("--kind <kind>", `One of ${NOTE_KINDS.join(", ")}`))
    .action((text: string, options: Common & { folder?: string; global?: boolean; kind?: string }) => run(options, store => {
      const note = store.add({ text, source: "user", kind: kindOf(options.kind), ...(options.global ? { scope: "global" as const } : { scope: "folder" as const, folder: options.folder ?? process.cwd() }) });
      emit(io, options, { note }, () => `Remembered ${note.id}.`);
    }));

  common(memory.command("remove <id>").description("Forget a note"))
    .action((id: string, options: Common) => run(options, store => {
      if (!store.remove(id)) throw new Error(`No note ${id}.`);
      emit(io, options, { removed: id }, () => `Forgot ${id}.`);
    }));

  common(memory.command("clear").description("Forget every note, or every note for one folder").option("--folder <path>", "Only this folder").option("--yes", "Confirm"))
    .action((options: Common & { folder?: string; yes?: boolean }) => run(options, store => {
      requireYes(options.yes, options.folder ? `This forgets every note for ${options.folder}.` : "This forgets every note.");
      const removed = store.clear(options.folder);
      emit(io, options, { removed }, () => `Forgot ${removed} note${removed === 1 ? "" : "s"}.`);
    }));

  for (const [verb, on, description] of [["disable", false, "Stop using notes in new threads (they stay on disk)"], ["enable", true, "Use notes in new threads again"]] as const) {
    common(memory.command(verb).description(description)).action((options: Common) => run(options, store => {
      store.setEnabled(on);
      emit(io, options, { enabled: on }, () => on ? "Memory is on." : "Memory is off.");
    }));
  }

  const proposed = memory.command("proposed").description("Review notes 0 proposed after reading web pages, files or tool output (they are not used until accepted)");
  common(proposed.command("list").description("List proposed notes")).action((options: Common) => run(options, store => {
    const notes = store.list({ status: "proposed" });
    emit(io, options, { notes }, () => notes.length ? renderTable(notes.map(note => [note.id, place(note), note.kind ?? "", note.text.slice(0, 90)]), ["ID", "WHERE", "KIND", "NOTE"]) : "Nothing proposed.");
  }));
  common(proposed.command("accept <id>").description("Accept a proposed note so it is used in new threads").option("--text <text>", "Correct the wording while accepting"))
    .action((id: string, options: Common & { text?: string }) => run(options, store => {
      const note = store.accept(id, options.text);
      if (!note) throw new Error(`No proposed note ${id}.`);
      emit(io, options, { note }, () => `Accepted ${id}.`);
    }));
  common(proposed.command("reject <id>").description("Discard a proposed note")).action((id: string, options: Common) => run(options, store => {
    if (!store.list({ status: "proposed" }).some(note => note.id === id)) throw new Error(`No proposed note ${id}.`);
    store.remove(id);
    emit(io, options, { rejected: id }, () => `Rejected ${id}.`);
  }));

  common(memory.command("export").description("Write notes to a file: JSON for 0 (default), or with --to a reviewable AGENTS.md section").option("--folder <path>", "Only this folder (default for --to: this folder)")
    .option("-o, --output <file>", "Write the JSON export to a file instead of stdout").option("--to <file>", "Add accepted notes to this markdown file (for example AGENTS.md) as a section you review and commit").option("--markdown", "Print the markdown section instead of JSON"))
    .action((options: Common & { folder?: string; output?: string; to?: string; markdown?: boolean }) => run(options, store => {
      if (options.to || options.markdown) {
        const folder = options.folder ?? process.cwd();
        const notes = exportable(store.list({ folder }));
        if (!notes.length) throw new Error(`No accepted or user-written notes for ${canonicalFolder(folder)}; nothing to export.`);
        const section = renderExportSection(notes);
        if (!options.to) { io.out(section); return; }
        const file = resolve(options.to);
        const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
        const after = applyExportSection(before, section);
        const changes = lineChanges(before ?? "", after);
        writeFileSync(file, after);
        emit(io, options, { ok: true, file: options.to, notes: notes.length, added: changes.added.length, removed: changes.removed.length }, () =>
          [`Updated ${options.to} with ${notes.length} note${notes.length === 1 ? "" : "s"}. Review with git diff, then commit it. 0 never reads notes back from a repository.`, ...changes.removed.map(line => `- ${line}`), ...changes.added.map(line => `+ ${line}`)].join("\n"));
        return;
      }
      const archive = exportArchive(store, options.folder);
      if (options.output) { writeFileSync(resolve(options.output), `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600 }); emit(io, options, { ok: true, file: options.output, notes: archive.notes.length }, () => `Wrote ${archive.notes.length} notes to ${options.output}.`); }
      else io.out(JSON.stringify(archive, null, 2));
    }));

  common(memory.command("import <file>").description("Add the notes from an export file"))
    .action((file: string, options: Common) => run(options, store => {
      let archive: unknown;
      try { archive = JSON.parse(readFileSync(resolve(file), "utf8")); } catch { throw new UsageError(`Cannot read ${file} as a JSON memory file.`); }
      if (!isArchive(archive)) throw new UsageError(`${file} is not a 0 memory file. Create one with \`0 memory export -o <file>\`.`);
      const result = importArchive(store, archive);
      emit(io, options, result, () => `Added ${result.added} of ${result.total} notes.`);
    }));
}

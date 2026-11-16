// `0 memory`: the one list of short notes 0 remembers across threads, per folder and global.
// The notes are plain files under ~/.0/memory, so this command works with no engine running.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { NOTE_KINDS, exportArchive, importArchive, isArchive, isKind, openMemory, type Note, type NoteKind, type NoteStore } from "@0/engine";
import { EXIT_FAILURE, EXIT_USAGE, UsageError, defaultIo, emit, renderTable, requireYes, type CommandIo } from "./console-output.js";

interface Common { json?: boolean; dbPath?: string }
const common = (command: Command): Command => command.option("--json", "Print machine-readable JSON").option("--db-path <path>", "Engine database to import older memories from");
const place = (note: Note) => (note.scope === "global" ? "global" : note.folder ?? "folder");

export function registerMemoryCommand(program: Command, io: CommandIo = defaultIo()): void {
  const memory = program.command("memory").description("List, add, remove, export and import what 0 remembers across threads");
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

  common(memory.command("list").description("List notes").option("--folder <path>", "Only notes for this folder").option("--global", "Only global notes").option("--search <text>", "Only notes containing this text"))
    .action((options: Common & { folder?: string; global?: boolean; search?: string }) => run(options, store => {
      const notes = store.list({ ...(options.folder ? { folder: options.folder } : {}), ...(options.global ? { scope: "global" as const } : {}), ...(options.search ? { query: options.search } : {}) });
      emit(io, options, { enabled: store.enabled(), notes }, () => notes.length ? renderTable(notes.map(note => [note.id, place(note), note.kind ?? "", note.text.slice(0, 90)]), ["ID", "WHERE", "KIND", "NOTE"]) : "Nothing remembered yet.");
    }));

  common(memory.command("add <text>").description("Remember a note").option("--folder <path>", "Folder the note is about (default: this folder)").option("--global", "Remember it everywhere").option("--kind <kind>", `One of ${NOTE_KINDS.join(", ")}`))
    .action((text: string, options: Common & { folder?: string; global?: boolean; kind?: string }) => run(options, store => {
      const note = store.add({ text, source: "you", kind: kindOf(options.kind), ...(options.global ? { scope: "global" as const } : { scope: "folder" as const, folder: options.folder ?? process.cwd() }) });
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

  common(memory.command("export").description("Write notes to a file").option("--folder <path>", "Only this folder").option("-o, --output <file>", "Write to a file instead of stdout"))
    .action((options: Common & { folder?: string; output?: string }) => run(options, store => {
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

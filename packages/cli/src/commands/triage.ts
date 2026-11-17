// `0 findings triage ...` (hidden, kept for one release). False-positive reasons are now notes in
// the one Memory (kind "avoid"); `0 memory` is where they are listed and removed.
import type { Command } from "commander";
import chalk from "chalk";

type DbOption = { dbPath?: string };
type TriageMemoryAddOptions = DbOption & { finding: string; reason: string; scope?: string; scopeValue?: string };
type TriageMarkFpOptions = DbOption & { reason: string; scope?: string; scopeValue?: string };

interface FindingRow { id: string; title: string; category: string }

function resolveFindingByPrefix(rows: FindingRow[], id: string): FindingRow | undefined {
  const exact = rows.find((row) => row.id === id);
  if (exact) return exact;
  const matches = rows.filter((row) => row.id.startsWith(id));
  if (matches.length > 1) throw new Error(`Finding prefix '${id}' is ambiguous (${matches.length} matches).`);
  return matches[0];
}

async function loadFinding(dbPath: string | undefined, findingId: string): Promise<FindingRow> {
  const { osecDB } = await import("@0/engine/storage");
  const db = new osecDB(dbPath);
  try {
    const row = resolveFindingByPrefix(db.listFindings({ limit: 5000 }) as FindingRow[], findingId);
    if (!row) throw new Error(`Finding '${findingId}' not found.`);
    return row;
  } finally { db.close(); }
}

async function rememberFalsePositive(row: FindingRow, reason: string, opts: DbOption & { scope?: string; scopeValue?: string }) {
  const { openMemory } = await import("@0/engine");
  const where = opts.scope && opts.scope !== "global" && opts.scopeValue ? ` (${opts.scope} ${opts.scopeValue})` : "";
  return openMemory(opts.dbPath ? { dbPath: opts.dbPath } : {}).add({ text: `Treat as a false positive${where}, ${row.category}: ${row.title}. Why: ${reason}`, scope: "global", kind: "avoid", source: "user" });
}

const fail = (err: unknown) => { console.error(chalk.red(err instanceof Error ? err.message : String(err))); process.exitCode = 1; };

export function registerTriageCommand(program: Command): void {
  const triage = program.command("triage").description("Triage findings and manage false-positive memories");
  const memory = triage.command("memory").description("Moved: false-positive reasons are notes in `0 memory`");

  memory.command("add").description("Create a memory from an existing finding")
    .requiredOption("--finding <id>", "Finding ID (full or prefix) to derive the memory from")
    .requiredOption("--reason <text>", "Why this finding is a false positive")
    .option("--scope <scope>", "Memory scope: global | target | package", "target")
    .option("--scope-value <value>", "Scope identifier (target URL or package name)")
    .option("--db-path <path>", "Path to SQLite database")
    .action(async (opts: TriageMemoryAddOptions) => {
      try { const note = await rememberFalsePositive(await loadFinding(opts.dbPath, opts.finding), opts.reason, opts); console.log(`${chalk.green("Remembered")} ${note.id}`); } catch (err) { fail(err); }
    });

  memory.command("list").description("List false-positive notes")
    .option("--db-path <path>", "Path to SQLite database")
    .action(async (opts: DbOption) => {
      try {
        const { openMemory } = await import("@0/engine");
        const notes = openMemory(opts.dbPath ? { dbPath: opts.dbPath } : {}).list().filter((note) => note.kind === "avoid");
        if (!notes.length) { console.log(chalk.gray("Nothing remembered yet.")); return; }
        for (const note of notes) console.log(`  ${chalk.cyan(note.id)} ${note.text}`);
      } catch (err) { fail(err); }
    });

  memory.command("remove").description("Forget a note by id").argument("<id>", "Note ID")
    .option("--db-path <path>", "Path to SQLite database")
    .action(async (id: string, opts: DbOption) => {
      try {
        const { openMemory } = await import("@0/engine");
        if (!openMemory(opts.dbPath ? { dbPath: opts.dbPath } : {}).remove(id)) { console.error(chalk.red(`No note ${id}.`)); process.exitCode = 1; return; }
        console.log(`${chalk.green("Forgot")} ${id}`);
      } catch (err) { fail(err); }
    });

  triage.command("mark-fp").description("Mark a finding as false positive and remember why")
    .argument("<finding-id>", "Finding ID (full or prefix)")
    .requiredOption("--reason <text>", "Why this finding is a false positive")
    .option("--scope <scope>", "Memory scope: global | target | package", "target")
    .option("--scope-value <value>", "Scope identifier (target URL or package name)")
    .option("--db-path <path>", "Path to SQLite database")
    .action(async (findingId: string, opts: TriageMarkFpOptions) => {
      try {
        const row = await loadFinding(opts.dbPath, findingId);
        const { osecDB } = await import("@0/engine/storage");
        const db = new osecDB(opts.dbPath);
        try { db.updateFindingTriage(row.id, "suppressed", opts.reason); } finally { db.close(); }
        const note = await rememberFalsePositive(row, opts.reason, opts);
        console.log(`${chalk.green("Marked FP")} ${chalk.gray(row.id.slice(0, 8))} ${chalk.gray("and remembered")} ${chalk.gray(note.id)}`);
      } catch (err) { fail(err); }
    });
}

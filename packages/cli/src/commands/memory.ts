// `0 memory` — what the Memory page does: list, disable or re-enable, export and import.
// False-positive and evaluation memories live under `0 findings triage memory`; improvement
// candidates live under `0 improve learning`.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { UsageError, consoleOptions, defaultIo, emit, expectOk, renderTable, runConsole, type CommandIo, type OutputOptions } from "./output.js";

interface MemoryRow { id: string; projectId: string; summary: string; status: string }
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const memoryPath = (id: string) => `/api/console/learning/knowledge/${encodeURIComponent(id)}`;

export function registerMemoryCommand(program: Command, io: CommandIo = defaultIo()): void {
  const memory = program.command("memory").description("List, disable, export and import what 0 remembers across missions");
  const run = (options: OutputOptions, fn: Parameters<typeof runConsole>[2]) => runConsole(io, options, fn);

  consoleOptions(memory.command("list").description("List memories").option("--folder <id>", "Only memories for this folder id").option("--limit <n>", "At most this many (1-200)", "100"))
    .action((options: OutputOptions & { folder?: string; limit: string }) => run(options, async client => {
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new UsageError("--limit must be between 1 and 200.");
      const query = new URLSearchParams({ limit: String(limit), ...(options.folder ? { projectId: options.folder } : {}) });
      const data = record(expectOk(await client.request("GET", `/api/console/learning?${query}`)));
      const rows = (data.knowledge ?? []) as MemoryRow[];
      emit(io, options, { memories: rows }, () => rows.length ? renderTable(rows.map(row => [row.id, row.status, row.summary.replace(/\s+/g, " ").slice(0, 80)]), ["ID", "STATUS", "MEMORY"]) : "No memories yet.");
    }));

  for (const [verb, status, description] of [["disable", "disabled", "Stop using a memory in future missions"], ["enable", "current", "Use a disabled memory again"]] as const) {
    consoleOptions(memory.command(`${verb} <id>`).description(description)).action((id: string, options: OutputOptions) => run(options, async client => {
      const entry = record(record(expectOk(await client.request("PATCH", memoryPath(id), { status }))).knowledge);
      emit(io, options, { memory: entry }, () => `Memory ${id} is now ${String(entry.status)}.`);
    }));
  }

  consoleOptions(memory.command("export").description("Export memories as a portable archive").option("--folder <id>", "Only memories for this folder id").option("-o, --output <file>", "Write to a file instead of stdout"))
    .action((options: OutputOptions & { folder?: string; output?: string }) => run(options, async client => {
      const archive = expectOk(await client.request("GET", `/api/console/learning/export${options.folder ? `?${new URLSearchParams({ projectId: options.folder })}` : ""}`));
      if (options.output) { writeFileSync(resolve(options.output), `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600 }); emit(io, options, { ok: true, file: options.output }, () => `Wrote ${options.output}.`); }
      else io.out(JSON.stringify(archive, null, 2));
    }));

  consoleOptions(memory.command("import <file>").description("Import a memory archive; imported memories start disabled").option("--preview", "Only show what would be imported"))
    .action((file: string, options: OutputOptions & { preview?: boolean }) => run(options, async client => {
      let archive: unknown;
      try { archive = JSON.parse(readFileSync(resolve(file), "utf8")); } catch { throw new UsageError(`Cannot read ${file} as a JSON memory archive.`); }
      const preview = record(record(expectOk(await client.request("POST", "/api/console/learning/import/preview", { archive }))).preview);
      const summary = `${String(preview.importable)} of ${String(preview.total)} memories can be imported (${String(preview.duplicates)} duplicates).`;
      if (options.preview) { emit(io, options, { preview }, () => summary); return; }
      const result = record(record(expectOk(await client.request("POST", "/api/console/learning/import", { archive, digest: preview.digest }))).result);
      emit(io, options, { preview, result }, () => `${summary}\nImported as disabled; enable one with \`0 memory enable <id>\`.`);
    }));
}

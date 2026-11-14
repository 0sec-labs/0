import type { Command } from "commander";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { importCiReport } from "../report-import.js";
import { assertLocalEngineAvailable } from "../local-engine.js";

function readArtifact(path: string, limit: number): string {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(`Artifact must be a regular file of at most ${limit} bytes.`);
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > stat.size || size > limit) throw new Error("Artifact changed or exceeded its size limit while reading.");
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

export function registerReportsCommand(program: Command): void {
  const reports = program.command("reports").description("Import retained CI reports for browser review without running an assessment");
  reports.command("import")
    .argument("<report>", "JSON report produced by 0; importing executes no report commands")
    .option("--metadata <path>", "Optional run.json invocation and revision metadata")
    .requiredOption("--db-path <path>", "Destination engine database; stop its browser engine before importing")
    .action(async (report: string, options: { metadata?: string; dbPath: string }) => {
      const reportJson = readArtifact(report, 20 * 1024 * 1024);
      const metadataJson = options.metadata ? readArtifact(options.metadata, 64 * 1024) : undefined;
      const dbPath = resolve(options.dbPath);
      assertLocalEngineAvailable(dbPath);
      const result = importCiReport({ reportJson, metadataJson, dbPath });
      console.log(JSON.stringify(result));
    });
}

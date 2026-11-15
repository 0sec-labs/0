import type { Command } from "commander";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { toShareSafeReport, type ScanReport } from "@0/engine/shared";
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
  const reports = program.command("reports").description("Import retained CI reports for browser review, or export a share-safe copy of one");
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
  reports.command("export")
    .argument("<report>", "JSON report produced by 0")
    .option("--include-description", "Include each finding's free-text description (can quote code or secrets)")
    .option("--output <path>", "Write the share-safe report to a file instead of stdout")
    .description("Write a share-safe copy of a report: an allowlist of fields, with no evidence, PoC, transcripts or local paths. Nothing is sent anywhere.")
    .action((report: string, options: { includeDescription?: boolean; output?: string }) => {
      const parsed: unknown = JSON.parse(readArtifact(report, 20 * 1024 * 1024));
      const candidate = parsed as Partial<ScanReport> | null;
      if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.findings) || !candidate.summary || typeof candidate.target !== "string") {
        throw new Error("Not a 0 scan report: expected target, summary and findings.");
      }
      const text = JSON.stringify(toShareSafeReport(candidate as ScanReport, { includeDescription: options.includeDescription === true }), null, 2);
      if (options.output) writeFileSync(resolve(options.output), `${text}\n`, { mode: 0o600 });
      else console.log(text);
    });
}

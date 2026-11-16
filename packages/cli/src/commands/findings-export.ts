import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import { exportReport, isReportExportFormat } from "@0/engine";
import { osecDB, resolveOsecRunStorage } from "@0/engine/storage";
import { retainedFindingSnapshot, retainedScanSnapshot } from "../web/report-artifacts.js";
import { finishWithError, UsageError } from "./output.js";

export interface FindingsExportDeps {
  out(text: string): void;
  err(text: string): void;
  writeBytes(path: string, bytes: Uint8Array): void;
  writeStdout(bytes: Uint8Array): void;
}
const defaults: FindingsExportDeps = {
  out: text => process.stdout.write(`${text}\n`),
  err: text => process.stderr.write(`${text}\n`),
  writeBytes: (path, bytes) => writeFileSync(path, bytes, { mode: 0o600 }),
  writeStdout: bytes => { process.stdout.write(bytes); },
};
interface ExportOptions { severity?: string; category?: string; status?: string; triage?: string; limit?: string; scan?: string; format: string; output?: string; dbPath?: string; json?: boolean }

export async function runFindingsExport(ids: string[], options: ExportOptions, deps: FindingsExportDeps = defaults): Promise<void> {
  try {
    const format = options.format === "md" ? "markdown" : options.format;
    if (!isReportExportFormat(format)) throw new UsageError("--format must be one of: json, md, sarif, html, pdf.");
    if (ids.length && options.scan) throw new UsageError("Use finding IDs or --scan, not both.");
    if (format === "pdf" && !options.output) throw new UsageError("PDF is binary; supply -o <file>.");
    const dbPath = options.dbPath ?? (options.scan ? resolveOsecRunStorage({ runId: options.scan, resume: true }).dbPath : undefined);
    let report;
    if (options.scan) report = retainedScanSnapshot(options.scan, dbPath);
    else {
      // Accept full IDs or unambiguous prefixes, like the other findings commands.
      const db = new osecDB(dbPath);
      let resolved: string[];
      try {
        const rows = db.listFindings({ limit: 5000, ...(options.severity ? { severity: options.severity } : {}), ...(options.category ? { category: options.category } : {}), ...(options.status ? { status: options.status } : {}), ...(options.triage ? { triageStatus: options.triage } : {}) }) as Array<{ id: string }>;
        // No IDs: every finding in the database (`0 findings list --format sarif`).
        if (!ids.length && rows.length === 0) throw new Error("No findings to export.");
        resolved = !ids.length ? rows.map(row => row.id) : ids.map(id => {
          const exact = rows.find(row => row.id === id);
          if (exact) return exact.id;
          const matches = rows.filter(row => row.id.startsWith(id));
          if (matches.length > 1) throw new UsageError(`Finding prefix '${id}' is ambiguous.`);
          if (!matches[0]) throw new Error(`Finding '${id}' not found.`);
          return matches[0].id;
        });
      } finally { db.close(); }
      report = retainedFindingSnapshot(resolved, dbPath);
    }
    const artifact = await exportReport(report, format, options.scan ? `0-scan-${options.scan}` : "0-findings");
    if (options.output) {
      deps.writeBytes(options.output, artifact.body);
      deps.err(options.json ? JSON.stringify({ ok: true, path: options.output, bytes: artifact.body.byteLength, format }) : `Wrote ${options.output} (${artifact.body.byteLength} bytes)`);
    } else deps.writeStdout(artifact.body);
  } catch (error) { finishWithError(error, deps, options.json); }
}

export function registerFindingsExportCommand(parent: Command, deps: FindingsExportDeps = defaults): void {
  parent.command("export [ids...]")
    .description("Export findings, a whole scan or, with no IDs, every finding as json, md, sarif, html or pdf")
    .option("--scan <id>", "Export every finding of this scan instead of selected IDs")
    .option("--format <format>", "json, md, sarif, html or pdf", "json")
    .option("-o, --output <file>", "Write to a file instead of stdout")
    .option("--severity <severity>", "With no IDs: only this severity")
    .option("--category <category>", "With no IDs: only this category")
    .option("--status <status>", "With no IDs: only this status")
    .option("--triage <triage>", "With no IDs: only this triage state")
    .option("--db-path <path>", "Path to SQLite database")
    .option("--json", "Print the result of writing a file as JSON")
    .action(async (ids: string[], options: ExportOptions, command: Command) => {
      // `findings` declares --db-path and --scan too; Commander may bind them to the parent.
      const merged = { ...command.parent?.opts(), ...command.opts() } as ExportOptions;
      await runFindingsExport(ids, { ...options, scan: options.scan ?? merged.scan, dbPath: options.dbPath ?? merged.dbPath }, deps);
    });
}

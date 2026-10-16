import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanReport } from "@0/shared";
import { formatMarkdown } from "./report-formatters/markdown.js";
import { formatHtml } from "./report-formatters/html.js";
import { formatSarif } from "./report-formatters/sarif.js";
import { generatePdfReport } from "./report-formatters/pdf.js";

export const REPORT_EXPORT_FORMATS = ["json", "markdown", "html", "sarif", "pdf"] as const;
export type ReportExportFormat = typeof REPORT_EXPORT_FORMATS[number];
export interface ReportExport { body: Uint8Array; contentType: string; filename: string }
const metadata: Record<ReportExportFormat, [string, string]> = {
  json: ["application/json", "json"], markdown: ["text/markdown; charset=utf-8", "md"],
  html: ["text/html; charset=utf-8", "html"], sarif: ["application/sarif+json", "sarif"], pdf: ["application/pdf", "pdf"],
};
export function isReportExportFormat(value: unknown): value is ReportExportFormat {
  return typeof value === "string" && REPORT_EXPORT_FORMATS.includes(value as ReportExportFormat);
}
/** Transport-independent bytes using the same serializers as CLI report output. */
export async function exportReport(report: ScanReport, format: ReportExportFormat, name = "0-report"): Promise<ReportExport> {
  if (!isReportExportFormat(format)) throw new Error("Unsupported report export format.");
  const [contentType, extension] = metadata[format];
  const filename = `${name.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^\.+/, "").slice(0, 120) || "0-report"}.${extension}`;
  if (format === "pdf") {
    const directory = await mkdtemp(join(tmpdir(), "0-report-export-"));
    try {
      const path = join(directory, "report.pdf");
      await generatePdfReport(report, path);
      return { body: await readFile(path), contentType, filename };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const text = format === "json" ? JSON.stringify(report, null, 2)
    : format === "markdown" ? formatMarkdown(report) : format === "html" ? formatHtml(report) : formatSarif(report);
  return { body: new TextEncoder().encode(text), contentType, filename };
}

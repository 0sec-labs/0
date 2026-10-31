// Keep pdfkit lazy: compiled binaries must not resolve build-host font paths at startup.
import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import type { ScanReport, Finding, Severity } from "@0/shared";
import { SEVERITY_RANK, getFindingPriority, compareFindingsByBusinessPriority } from "@0/shared";
import type PDFDocumentType from "pdfkit";

type PDFDoc = InstanceType<typeof PDFDocumentType>;
const SEVERITY_ORDER = (Object.keys(SEVERITY_RANK) as Severity[]).sort((a, b) => SEVERITY_RANK[b]! - SEVERITY_RANK[a]!);
const COLORS: Record<Severity, string> = { critical: "#dc2626", high: "#ea580c", medium: "#ca8a04", low: "#2563eb", info: "#6b7280" };
const MARGIN = 40;
const WIDTH = 532;
const MUTED = "#a1a1aa";
const TEXT = "#ededee";

type Block = { text: string; size: number; font?: string; color?: string; code?: boolean; table?: [string, string]; gap?: number; width?: number };
function shortTitle(title: string): string {
  return title.slice(Math.max(title.lastIndexOf("—"), title.lastIndexOf(":")) + 1).trim() || title;
}
function impactLine(description: string): string {
  const plain = description.replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "")
    .replace(/[*_`#~]/g, "").replace(/\s+/g, " ").trim();
  return plain.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? plain;
}
function blocks(f: Finding): Block[] {
  const priority = getFindingPriority(f);
  const annotation = f.reviewAnnotation;
  const result: Block[] = [
    { text: shortTitle(f.title), size: 13, font: "Helvetica-Bold", gap: 8 },
    { text: impactLine(f.description), size: 9, gap: 8 },
    ...(annotation ? [{ text: `${annotation.path} : ${annotation.startLine}`, size: 8, font: "Courier", color: "#fd802e", gap: 12 }] : []),
    { text: "TECHNICAL DETAILS", size: 8, color: MUTED, gap: 8 },
    { text: `Reference: ${f.title}`, size: 7, color: MUTED, gap: 8 },
    { text: f.description, size: 9, gap: 10, width: 350 },
    { text: `Business priority: ${priority.label}\nBusiness impact rationale: ${priority.rationale}\nTechnical severity: ${f.severity.charAt(0).toUpperCase() + f.severity.slice(1)}`, size: 8, color: MUTED, gap: 10 },
  ];
  if (f.impactAssessment) {
    result.push({ text: "IMPACT ASSESSMENT", size: 8, color: MUTED, gap: 6 });
    for (const [key, value] of Object.entries(f.impactAssessment)) {
      result.push({ text: "", size: 8, table: [key.replace(/_/g, " "), typeof value === "string" ? value : JSON.stringify(value) ?? ""], gap: 4 });
    }
  }
  for (const [label, value] of [["Request", f.evidence.request], ["Response", f.evidence.response], ["Analysis", f.evidence.analysis]]) {
    if (value) result.push({ text: label!, size: 8, color: MUTED, gap: 4 }, { text: value, size: 7.5, font: "Courier", code: true, gap: 10 });
  }
  result.push({ text: [
    `CVSS: ${f.cvssScore?.toFixed(1) ?? "Not provided"}`, `Confidence: ${f.confidence != null ? `${Math.round(f.confidence * 100)}%` : "Not provided"}`,
    `Category: ${f.category}`, `ID: ${f.id}`, `Status: ${f.status}`,
    f.cvssVector ? `CVSS vector: ${f.cvssVector}` : "", f.findingRank != null ? `Rank: ${f.findingRank}` : "",
    f.semanticDedupe ? `Canonical: ${f.semanticDedupe.canonicalId}` : "",
    annotation?.endLine != null ? `Source end line: ${annotation.endLine}` : "",
  ].filter(Boolean).join(" · "), size: 7, color: MUTED });
  return result;
}
function blockHeight(doc: PDFDoc, block: Block): number {
  doc.font(block.font ?? "Helvetica").fontSize(block.size);
  if (block.table) return Math.max(...block.table.map((s, i) => doc.heightOfString(s, { width: i ? WIDTH - 190 : 130, lineGap: 3 }))) + 12;
  return doc.heightOfString(block.text, { width: block.width ?? (block.code ? WIDTH - 56 : WIDTH - 32), lineGap: 3 }) + (block.code ? 24 : 0);
}
function renderBlock(doc: PDFDoc, block: Block, y: number): number {
  const height = blockHeight(doc, block);
  if (block.code) doc.roundedRect(MARGIN + 16, y, WIDTH - 32, height, 6).fillAndStroke("#19191b", "#303033");
  doc.font(block.font ?? "Helvetica").fontSize(block.size).fillColor(block.color ?? TEXT);
  if (block.table) {
    doc.fillColor(MUTED).text(block.table[0], MARGIN + 16, y + 6, { width: 130, lineGap: 3 });
    doc.fillColor(TEXT).text(block.table[1], MARGIN + 158, y + 6, { width: WIDTH - 190, lineGap: 3 });
    doc.moveTo(MARGIN + 16, y + height).lineTo(MARGIN + WIDTH - 16, y + height).strokeColor("#303033").stroke();
  } else doc.text(block.text, MARGIN + (block.code ? 28 : 16), y + (block.code ? 12 : 0), { width: block.width ?? (block.code ? WIDTH - 56 : WIDTH - 32), lineGap: 3 });
  return y + height + (block.gap ?? 0);
}

export async function generatePdfReport(report: ScanReport, outputPath: string): Promise<void> {
  const require_ = createRequire(import.meta.url);
  const PDFDocument = require_("pdfkit") as typeof PDFDocumentType;
  return new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, info: { Title: `0 Security Report - ${report.target}`, Author: "0" } });
    const stream = createWriteStream(outputPath);
    stream.on("error", reject);
    stream.on("finish", resolve);
    doc.on("error", reject);
    doc.pipe(stream);
    const paintPage = () => {
      doc.save().rect(0, 0, doc.page.width, doc.page.height).fill("#101011").restore();
      doc.fillColor(TEXT);
    };
    doc.on("pageAdded", paintPage);
    paintPage();
    doc.font("Helvetica-Bold").fontSize(28).fillColor("#ffffff").text("0", MARGIN, MARGIN);
    doc.font("Helvetica").fontSize(11).fillColor(MUTED).text("Security Report", MARGIN + 30, MARGIN + 11);
    doc.font("Courier").fontSize(9).text(report.target, MARGIN, MARGIN + 42, { width: WIDTH });
    let y = doc.y + 20;
    const tileWidth = (WIDTH - 30) / 4;
    SEVERITY_ORDER.filter(s => s !== "info").forEach((s, i) => {
      const x = MARGIN + i * (tileWidth + 10);
      doc.roundedRect(x, y, tileWidth, 72, 8).fill("#19191b");
      if (s === "critical" || s === "high") doc.roundedRect(x, y + 8, 3, 56, 1).fill(COLORS[s]);
      doc.font("Helvetica-Bold").fontSize(24).fillColor(TEXT).text(String(report.summary[s]), x + 14, y + 12, { width: tileWidth - 28 });
      doc.font("Helvetica").fontSize(7).fillColor(MUTED).text(s.toUpperCase(), x + 14, y + 48, { width: tileWidth - 28 });
    });
    y += 94;
    // Measure before drawing so no finding is split. Exceptionally long findings
    // receive a taller page rather than clipping evidence or losing content.
    const ensureSpace = (height: number) => {
      if (y > doc.page.height - 100 || y + height > doc.page.height - MARGIN) {
        doc.addPage({ size: height > 712 ? [612, height + MARGIN * 2] : "LETTER", margin: MARGIN });
        y = MARGIN;
      }
    };
    for (const f of [...report.findings].sort(compareFindingsByBusinessPriority)) {
      const content = blocks(f);
      const title = content.shift()!;
      const chip = f.severity.toUpperCase();
      doc.font("Helvetica-Bold").fontSize(8);
      const chipWidth = doc.widthOfString(chip) + 16;
      const titleWidth = WIDTH - chipWidth - 48;
      doc.font("Helvetica-Bold").fontSize(13);
      const titleHeight = doc.heightOfString(title.text, { width: titleWidth, lineGap: 3 });
      const headerHeight = Math.max(36, titleHeight + 23);
      const height = headerHeight + 16 + content.reduce((sum, b) => sum + blockHeight(doc, b) + (b.gap ?? 0), 0);
      ensureSpace(height);
      const start = y;
      doc.roundedRect(MARGIN, y, WIDTH, height, 12).fillAndStroke("#19191b", "#303033");
      doc.font("Helvetica-Bold").fontSize(8);
      doc.roundedRect(MARGIN + 16, y + 14, chipWidth, 18, 5).fill(COLORS[f.severity]);
      doc.fillColor("#ffffff").text(chip, MARGIN + 24, y + 19, { width: chipWidth, lineBreak: false });
      // The short title shares the chip's row; subsequent content flows below both.
      doc.font("Helvetica-Bold").fontSize(13).fillColor(TEXT);
      doc.text(title.text, MARGIN + chipWidth + 28, y + 15, { width: titleWidth, lineGap: 3 });
      y += headerHeight;
      for (const b of content) y = renderBlock(doc, b, y);
      y = Math.max(y + 16, start + height) + 14;
    }
    const extras: Block[] = [];
    if (!report.findings.length) extras.push({ text: report.warnings.length || report.executionSuccessful === false ? "No vulnerabilities confirmed. Scan finished with warnings." : "No security vulnerabilities found.", size: 9, gap: 14 });
    if (report.warnings.length) extras.push({ text: "WARNINGS", size: 8, color: MUTED, gap: 8 }, ...report.warnings.map(w => ({ text: `${w.stage}: ${w.message}`, size: 9, gap: 10 })));
    if (report.reviewChecks?.length) {
      extras.push({ text: "REVIEW CHECKS (ADVISORY)", size: 8, color: MUTED, gap: 8 });
      for (const c of report.reviewChecks) extras.push({ text: `${c.status.toUpperCase()}: ${c.name}\nID: ${c.id}\nReason: ${c.reason}${c.fix ? `\nSuggested fix: ${c.fix}` : ""}`, size: 9, gap: 14 });
    }
    extras.push({ text: `SCAN INFORMATION\nTarget: ${report.target}\nDepth: ${report.scanDepth}\nStarted: ${report.startedAt}\nCompleted: ${report.completedAt}\nDuration: ${report.durationMs}ms · Attacks tested: ${report.summary.totalAttacks} · Findings: ${report.summary.totalFindings} · Informational: ${report.summary.info}\nGenerated by 0`, size: 7, color: MUTED, gap: 10 });
    for (const b of extras) { ensureSpace(blockHeight(doc, b) + (b.gap ?? 0)); y = renderBlock(doc, b, y); }
    doc.end();
  });
}

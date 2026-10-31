// Resolve PDFKit at runtime so compiled binaries can locate its font assets.
import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import type { ScanReport } from "@0/shared";
import { compareFindingsByBusinessPriority } from "@0/shared";
import type PDFDocumentType from "pdfkit";
import { findingPresentation, targetLabel, reportDate } from "./presentation.js";

const M = 48, W = 516;
const colors = { critical: "#c33440", high: "#ad5926", medium: "#856618", low: "#3668a0", info: "#686875" };
function plain(text: string): string { return text.replace(/[–—‑]/g, "-").replace(/→/g, "->").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "..."); }
/** A reading brief. The companion HTML retains the complete technical evidence. */
export async function generatePdfReport(report: ScanReport, outputPath: string): Promise<void> {
  const require_ = createRequire(import.meta.url);
  const PDFDocument = require_("pdfkit") as typeof PDFDocumentType;
  const title = targetLabel(report.target);
  const doc = new PDFDocument({ size: "LETTER", margins: { top: M, bottom: 66, left: M, right: M }, bufferPages: true, info: { Title: `${title} - Security review`, Author: "0", Subject: "Security findings brief" } });
  const stream = createWriteStream(outputPath);
  const done = new Promise<void>((resolve, reject) => { stream.on("finish", resolve); stream.on("error", reject); doc.on("error", reject); });
  doc.pipe(stream);
  const sorted = [...report.findings].sort(compareFindingsByBusinessPriority);
  function text(value: string, size = 11, color = "#4d4d57", bold = false): void {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color).text(plain(value), M, doc.y, { width: W, lineGap: 3 });
  }
  function line(y: number): void { doc.moveTo(M, y).lineTo(564, y).lineWidth(.5).strokeColor("#dcdce1").stroke(); }
  function page(): void { doc.addPage(); text(`${title} / Findings`, 9, "#73737d"); doc.y = 80; }
  doc.rect(0, 0, 612, 792).fill("#101011");
  doc.y = 42; text("0", 35, "#ffffff", true);
  doc.font("Helvetica").fontSize(9).fillColor("#aaaab4").text("SECURITY REVIEW", 94, 58, { width: 200 });
  doc.y = 150; text(title, 46, "#ffffff", true); doc.moveDown(.3); text(reportDate(report.startedAt), 11, "#aaaab4");
  doc.y = Math.max(doc.y + 54, 280); text(`${sorted.length} findings`, 27, "#ffffff"); doc.moveDown(.8);
  const active = (["critical", "high", "medium", "low", "info"] as const).filter(s => report.summary[s]);
  text(active.map(s => `${report.summary[s]} ${s}`).join("   /   ") || "No findings reported", 13, "#ffb28b");
  doc.moveDown(2); text("Findings and recommended actions", 12, "#eeeeef", true);
  text("Supporting evidence is available in the companion HTML report.", 10, "#aaaab4");
  if (report.executionSuccessful === false) { doc.moveDown(); text("The assessment did not complete. Results may be incomplete.", 10, "#e5c777"); }
  if (report.warnings.length) { doc.moveDown(); text("Scope and limitations are listed at the end of this brief.", 10, "#aaaab4"); }
  doc.fontSize(8).fillColor("#aaaab4").text("CONFIDENTIAL", M, 710, { width: W });
  if (sorted.length) page();
  sorted.forEach((f, i) => {
    const copy = findingPresentation(f);
    const measure = (value: string, size: number, bold = false) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).heightOfString(plain(value), { width: W, lineGap: 3 });
    const height = 22 + measure(copy.title, 17, true) + 10 + measure(copy.summary, 11) + (copy.action ? 18 + measure(`Fix: ${copy.action}`, 10) : 0) + 34;
    if (doc.y + height > 710 && doc.y > 80) page();
    const start = doc.y;
    text(`${String(i + 1).padStart(2, "0")} / ${f.severity.toUpperCase()}`, 8, colors[f.severity], true);
    doc.y += 7; text(copy.title, 17, "#202025", true);
    doc.y += 7; text(copy.summary);
    if (copy.action) { doc.y += 10; text(`Fix: ${copy.action}`, 10, "#3d6550"); }
    doc.y += 20; line(doc.y); doc.y += 20;
    // Very long source findings can continue naturally; no text is clipped.
    if (doc.y < start) doc.x = M;
  });
  if (report.warnings.length || report.reviewChecks?.length) {
    if (doc.y > 540 || !sorted.length) page(); else doc.y += 16;
    text("Scope & limitations", 18, "#202025", true); doc.moveDown();
    report.warnings.forEach(w => { text(w.message, 10); doc.moveDown(); });
    report.reviewChecks?.forEach(c => { if (doc.y > 620) page(); text(`${c.name} (${c.status})`, 11, "#202025", true); text(c.reason, 10); if (c.fix) text(c.fix, 10); doc.moveDown(); });
  }
  const count = doc.bufferedPageRange().count;
  for (let i = 1; i < count; i++) {
    doc.switchToPage(i); const bottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    line(742);
    doc.font("Helvetica").fontSize(8).fillColor("#73737e").text(`0 / ${plain(title)}`, M, 752, { width: 300, lineBreak: false });
    doc.text(`${i + 1} / ${count}`, 480, 752, { width: 84, align: "right", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end(); await done;
}

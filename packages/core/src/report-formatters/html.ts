import type { ScanReport, Finding, Severity } from "@0/shared";
import { SEVERITY_RANK, getFindingPriority, compareFindingsByBusinessPriority } from "@0/shared";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SEVERITY_COLORS: Record<Severity, { bg: string; text: string; accent: string }> = {
  critical: { bg: "#222225", text: "#dc2626", accent: "#dc2626" },
  high: { bg: "#222225", text: "#ea580c", accent: "#ea580c" },
  medium: { bg: "#222225", text: "#ca8a04", accent: "#ca8a04" },
  low: { bg: "#222225", text: "#2563eb", accent: "#2563eb" },
  info: { bg: "#222225", text: "#6b7280", accent: "#6b7280" },
};

// Descending display order (critical → info), derived from the shared
// SEVERITY_RANK so it can't drift from the canonical rank (#629).
const SEVERITY_ORDER: Severity[] = (Object.keys(SEVERITY_RANK) as Severity[]).sort(
  (a, b) => SEVERITY_RANK[b]! - SEVERITY_RANK[a]!,
);

// Keep display titles compact while retaining the original in the disclosure.
function shortTitle(title: string): string {
  const lastSeparator = Math.max(title.lastIndexOf("—"), title.lastIndexOf(":"));
  return title.slice(lastSeparator + 1).trim() || title;
}

function impactLine(description: string): string {
  const plain = description.replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "").replace(/[*_`#~]/g, "").replace(/\s+/g, " ").trim();
  return plain.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? plain;
}

function renderFinding(finding: Finding): string {
  const priority = getFindingPriority(finding);
  const confidence = finding.confidence != null ? `${Math.round(finding.confidence * 100)}%` : "Not provided";
  const annotation = finding.reviewAnnotation;
  const metadata = [
    `CVSS: ${finding.cvssScore?.toFixed(1) ?? "Not provided"}`,
    `Confidence: ${confidence}`, `Category: ${finding.category}`, `ID: ${finding.id}`,
    `Status: ${finding.status}`, finding.cvssVector ? `CVSS vector: ${finding.cvssVector}` : "",
    finding.findingRank != null ? `Rank: ${finding.findingRank}` : "",
    finding.semanticDedupe ? `Canonical: ${finding.semanticDedupe.canonicalId}` : "",
    annotation?.endLine != null ? `Source end line: ${annotation.endLine}` : "",
  ].filter(Boolean).join(" · ");
  return `<article class="finding-card">
    <div class="finding-header">
      <span class="severity-chip" style="--severity:${SEVERITY_COLORS[finding.severity].accent}">${finding.severity}</span>
      <h2>${escapeHtml(shortTitle(finding.title))}</h2>
      <span class="confidence">${finding.confidence != null ? confidence : ""}</span>
    </div>
    <p class="impact-line">${escapeHtml(impactLine(finding.description))}</p>
    ${annotation ? `<div class="location"><span>${escapeHtml(annotation.path)} : ${annotation.startLine}</span></div>` : ""}
    <details><summary>Technical details</summary>
      <p class="reference">Reference: ${escapeHtml(finding.title)}</p>
      <div class="finding-body">${escapeHtml(finding.description)}</div>
      <p class="priority">Business priority: ${escapeHtml(priority.label)}<br>Business impact rationale: ${escapeHtml(priority.rationale)}<br>Technical severity: ${finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)}</p>
      ${finding.impactAssessment ? `<table><caption>Impact assessment</caption><tbody>${Object.entries(finding.impactAssessment).map(([key, value]) => `<tr><th scope="row">${escapeHtml(key.replace(/_/g, " "))}</th><td>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value) ?? "")}</td></tr>`).join("")}</tbody></table>` : ""}
      ${([ ["Request", finding.evidence.request], ["Response", finding.evidence.response], ["Analysis", finding.evidence.analysis] ] as const).filter(([, value]) => value).map(([label, value]) => `<div class="evidence"><h3>${label}</h3><pre><code>${escapeHtml(value!)}</code></pre></div>`).join("")}
      <footer class="metadata">${escapeHtml(metadata)}</footer>
    </details>
  </article>`;
}

export function formatHtml(report: ScanReport): string {
  const sorted = [...report.findings].sort(compareFindingsByBusinessPriority);
  // Middle truncation keeps both the root and the filename visible without JS.
  const target = report.target.length > 80 ? `${report.target.slice(0, 36)}…${report.target.slice(-40)}` : report.target;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>0 Security Report — ${escapeHtml(report.target)}</title>
<style>
:root{color-scheme:dark;--muted:#a1a1aa;--border:rgba(255,255,255,.10)}
*{box-sizing:border-box}html,body{background:#101011;color:#ededee}body{max-width:1120px;margin:auto;padding:32px;font:14px/1.6 'Geist','Geist Variable',ui-sans-serif,system-ui,sans-serif}
.header{display:flex;align-items:center;gap:16px;margin-bottom:28px;min-width:0}.brand{font-size:24px;font-weight:700;color:#fff;line-height:1}.report-label{color:var(--muted);white-space:nowrap}.target{margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12px}
.mono,.target,.location,pre,code{font-family:'Geist Mono',ui-monospace,SFMono-Regular,Consolas,monospace}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:28px}.stat{border:1px solid var(--border);background:#19191b;border-radius:12px;padding:18px 20px}.stat.critical{border-left:3px solid #dc2626}.stat.high{border-left:3px solid #ea580c}.stat-number{font-size:32px;font-weight:700;line-height:1.2}.stat-label{font-size:11px;color:var(--muted);letter-spacing:.08em;margin-top:6px;text-transform:uppercase}
.finding-card,.advisory{background:#19191b;border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:14px}.finding-header{display:flex;align-items:center;gap:12px}.finding-header h2{font-size:16px;font-weight:600;line-height:1.4;margin:0;overflow-wrap:anywhere;min-width:0}.severity-chip{font-size:10px;text-transform:uppercase;font-weight:600;color:#fff;background:var(--severity);border-radius:6px;padding:3px 8px;flex-shrink:0}.confidence{margin-left:auto;color:var(--muted);font-size:12px;white-space:nowrap}.impact-line{font-size:14px;margin:10px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.location{font-size:12px;margin:10px 0 12px;overflow-wrap:anywhere}.location span{display:inline-block;background:#222225;border:1px solid var(--border);border-radius:6px;padding:3px 8px;color:#fd802e}
summary{font-size:12px;color:var(--muted);cursor:pointer;width:fit-content}summary:focus-visible{outline:2px solid #fd802e;outline-offset:4px}.reference,.metadata{font-size:11px;color:var(--muted);overflow-wrap:anywhere}.finding-body{max-width:70ch;white-space:pre-wrap;overflow-wrap:anywhere;margin:18px 0}.priority{font-size:12px;color:var(--muted)}table{border-collapse:collapse;width:100%;font-size:12px;margin:20px 0}caption{text-align:left;color:var(--muted);margin-bottom:8px}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--border);overflow-wrap:anywhere}th{font-weight:500;color:var(--muted);width:30%}h3{font-size:12px;font-weight:500;color:var(--muted);margin:16px 0 6px}pre{background:#101011;border:1px solid var(--border);border-radius:8px;padding:12px;max-height:300px;overflow:auto;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.metadata{border-top:1px solid var(--border);padding-top:12px;margin-top:20px}.advisory h2{font-size:16px}.advisory p{white-space:pre-wrap;overflow-wrap:anywhere}.report-footer{color:var(--muted);font-size:11px;margin-top:24px}.report-footer summary{font-size:11px}
@media(max-width:640px){body{padding:20px 16px}.header{gap:10px}.target{font-size:10px}.stats{gap:8px}.stat{padding:12px 8px}.stat-label{font-size:9px}.finding-header{gap:8px;flex-wrap:wrap}.confidence{margin-left:auto}}
@media print{body{max-width:none;padding:0}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}.stats,.finding-header,.location{break-inside:avoid}details::details-content{content-visibility:visible!important;display:block!important}details>*:not(summary){display:block!important}details table{display:table!important}.impact-line{white-space:normal}pre{max-height:none;overflow:visible}summary{display:none}.finding-card{box-decoration-break:clone}h2,h3,caption{break-after:avoid}@page{margin:15mm}}
</style></head><body>
<header class="header"><span class="brand">0</span><span class="report-label">Security Report</span><span class="target" title="${escapeHtml(report.target)}" aria-label="${escapeHtml(report.target)}">${escapeHtml(target)}</span></header>
<section class="stats" aria-label="Findings by severity">${SEVERITY_ORDER.filter(s => s !== "info").map(s => `<div class="stat ${s}"><div class="stat-number">${report.summary[s]}</div><div class="stat-label">${s}</div></div>`).join("")}</section>
<main>${sorted.map(renderFinding).join("\n") || `<div class="advisory">${report.warnings.length || report.executionSuccessful === false ? "No vulnerabilities confirmed. Scan finished with warnings." : "No security vulnerabilities found."}</div>`}</main>
${report.warnings.length ? `<section class="advisory"><h2>Warnings</h2>${report.warnings.map(w => `<p><strong>${escapeHtml(w.stage)}</strong> ${escapeHtml(w.message)}</p>`).join("")}</section>` : ""}
${report.reviewChecks?.length ? `<section class="advisory"><h2>Review Checks (Advisory)</h2>${report.reviewChecks.map(c => `<h3>${escapeHtml(c.status.toUpperCase())}: ${escapeHtml(c.name)}</h3><p>ID: ${escapeHtml(c.id)}</p><p>Reason: ${escapeHtml(c.reason)}</p>${c.fix ? `<p>Suggested fix: ${escapeHtml(c.fix)}</p>` : ""}`).join("")}</section>` : ""}
<footer class="report-footer"><details><summary>Scan information</summary><p>Target: ${escapeHtml(report.target)}<br>Depth: ${escapeHtml(report.scanDepth)}<br>Started: ${escapeHtml(report.startedAt)}<br>Completed: ${escapeHtml(report.completedAt)}<br>Duration: ${report.durationMs}ms<br>Attacks tested: ${report.summary.totalAttacks}<br>Findings: ${report.summary.totalFindings}<br>Informational: ${report.summary.info}</p></details><p>Generated by 0 · ${escapeHtml(new Date().toISOString())}</p></footer>
</body></html>`;
}

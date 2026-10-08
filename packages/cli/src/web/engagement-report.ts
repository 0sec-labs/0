import type { EngagementReport } from "./engagements.js";

const text = (value: string) => value.replace(/[\\`*_{}\[\]()#+.!|<>]/g, "\\$&");
function evidence(value: unknown): string {
  const content = JSON.stringify(value, null, 2) ?? "null";
  let longest = 2;
  for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}json\n${content}\n${fence}`;
}

/** Human-readable handoff, preserving evidence and exact retained-run coverage. */
export function engagementMarkdown(report: EngagementReport): string {
  const { engagement, summary } = report;
  const lines = [`# ${text(engagement.name)}`, "", engagement.description ? text(engagement.description) : "", "",
    "This report collects evidence from the selected retained runs. It does not establish complete asset coverage or that every finding was verified.", "",
    `Engagement ID: ${engagement.id}`, `Revision: ${engagement.revision}`, `Updated: ${engagement.updatedAt}`, ...(engagement.updatedBy ? [`Updated by: ${text(engagement.updatedBy.displayName)} (${text(engagement.updatedBy.userId)})`] : []), "",
    `Runs: ${summary.scanCount} · Finding occurrences: ${summary.findingCount} · Unique findings: ${summary.uniqueFindingCount}`,
    `Verified: ${summary.verified} · Rejected: ${summary.rejected} · Unreviewed: ${summary.unreviewed}`, "",
    "## Engagement notes", "", engagement.notes ? text(engagement.notes) : "No notes recorded.", "", "## Source runs", ""];
  if (!report.scans.length) lines.push("No runs attached.", "");
  for (const scan of report.scans) {
    lines.push(`### ${text(scan.target)}`, "", `Scan ID: ${text(scan.id)}`, `Status: ${text(scan.status)}`, `Started: ${scan.startedAt}`,
      `Completed: ${scan.completedAt ?? "Not recorded"}`, `Recorded duration (ms): ${scan.durationMs ?? "Not recorded"}`, "");
    lines.push(`Execution successful: ${scan.executionSuccessful === undefined ? "Not recorded" : scan.executionSuccessful ? "Yes" : "No"}`, `Exit reason: ${scan.exitReason ? text(scan.exitReason) : "Not recorded"}`, "");
    if (scan.error) lines.push(`Execution error: ${text(scan.error)}`, "");
    for (const warning of scan.warnings ?? []) lines.push(`Warning: ${text(warning.message)}`, "");
  }
  lines.push("## Findings", "");
  if (!report.findingGroups.length) lines.push("No findings recorded in the selected runs.", "");
  for (const group of report.findingGroups) {
    const finding = group.occurrences[0]!.finding;
    lines.push(`### ${text(finding.title)}`, "", `Review status: ${group.reviewStatus}`, `Severity: ${text(finding.severity)}`, "");
    for (const occurrence of group.occurrences) {
      lines.push(`Source scan: ${text(occurrence.scanId)} · Finding ID: ${text(occurrence.findingId)}`, "", evidence(occurrence.finding), "");
    }
  }
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n");
}

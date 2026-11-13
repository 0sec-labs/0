import { posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [jsonReportPath, sarifReportPath, primaryFormat, mode, targetLabel, severityThreshold, countThresholdRaw] = process.argv.slice(2);

if (!jsonReportPath || !sarifReportPath || !primaryFormat || !mode || !targetLabel || !severityThreshold || !countThresholdRaw) {
  throw new Error("Missing required arguments.");
}

let report;
try { report = JSON.parse(fs.readFileSync(jsonReportPath, "utf8")); }
catch { throw new Error("0 did not produce valid JSON; inspect the retained report privately."); }
if (!report || typeof report !== "object" || !Array.isArray(report.findings)) {
  throw new Error("0 report must contain a findings array; refusing an empty success from an unrecognized report.");
}
if (report.findings.some(finding => !finding || typeof finding !== "object" ||
  !["info", "low", "medium", "high", "critical"].includes(finding.severity) ||
  typeof finding.title !== "string")) throw new Error("0 report contains an invalid finding.");
if (!/^[0-9]+$/.test(countThresholdRaw) || !Number.isSafeInteger(Number(countThresholdRaw))) {
  throw new Error("Invalid finding count threshold.");
}

const findings = Array.isArray(report.findings) ? report.findings : [];
const warnings = Array.isArray(report.warnings) ? report.warnings : [];
const summary = report.summary ?? {};
const severityOrder = ["info", "low", "medium", "high", "critical"];
const countThreshold = Number.parseInt(countThresholdRaw, 10);

function severityToLevel(severity) {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
    case "info":
    default:
      return "note";
  }
}

/** Review annotations are relative to the reviewed source root, not the repository root. */
function annotationUri(annotationPath, target) {
  // Persisted reports may bypass annotation validation. Never reinterpret an
  // absolute path, URL, or traversal as a location below the reviewed root.
  if (!annotationPath || annotationPath.startsWith("/") || annotationPath.includes("\\") || annotationPath.split("/").includes("..") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(annotationPath)) return undefined;
  const encoded = (value) => value.split("/").map(part => encodeURIComponent(part)).join("/");
  const root = target.startsWith("repo:") ? target.slice(5) : target;
  if (/^file:\/\//i.test(root)) {
    try { return new URL(encoded(annotationPath), root.endsWith("/") ? root : root + "/").href; } catch { return undefined; }
  }
  if (/^[A-Za-z]:[\\/]/.test(root)) {
    const path = win32.join(root, annotationPath).replace(/\\/g, "/");
    return "file:///" + path.slice(0, 2) + encoded(path.slice(2));
  }
  if (root.startsWith("\\\\")) {
    const [host, ...parts] = win32.join(root, annotationPath).replace(/\\/g, "/").slice(2).split("/");
    return "file://" + host + "/" + encoded(parts.join("/"));
  }
  if (root.startsWith("/")) return "file://" + encoded(posix.join(root, annotationPath));
  // A remote clone/package label does not identify its checkout location.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(root) || /^git@/.test(root)) return encoded(annotationPath);
  // Retain the original invocation-relative root without inventing an absolute
  // checkout based on whichever directory later renders a saved report.
  return encoded(posix.join(root || ".", annotationPath));
}

function findingLocation(finding, targetUri) {
  const annotation = finding.reviewAnnotation;
  if (typeof annotation?.path !== "string" || !annotation.path) {
    return { artifactLocation: { uri: targetUri } };
  }
  const uri = annotationUri(annotation.path, targetUri);
  if (!uri) return { artifactLocation: { uri: targetUri } };
  const location = { artifactLocation: { uri } };
  // SARIF lines start at 1. Keep only the file when the cited line is not valid.
  if (Number.isInteger(annotation.startLine) && annotation.startLine >= 1) {
    location.region = { startLine: annotation.startLine };
    if (Number.isInteger(annotation.endLine) && annotation.endLine >= annotation.startLine) {
      location.region.endLine = annotation.endLine;
    }
  }
  return location;
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const thresholdIndex = severityThreshold === "none" ? Number.POSITIVE_INFINITY : severityOrder.indexOf(severityThreshold);
if (thresholdIndex === -1) {
  throw new Error(`Unsupported severity threshold: ${severityThreshold}`);
}

const sortedFindings = findings.slice().sort((left, right) => {
  return severityOrder.indexOf(right.severity) - severityOrder.indexOf(left.severity);
});

const qualifyingFindings = thresholdIndex === Number.POSITIVE_INFINITY
  ? []
  : sortedFindings.filter((finding) => severityOrder.indexOf(finding.severity) >= thresholdIndex);

const shouldFail = qualifyingFindings.length > countThreshold;
// Explicit execution evidence outranks a zero process exit and empty findings.
const executionFailed = report.executionSuccessful === false || Boolean(report.error) ||
  report.costCeilingExceeded === true || (Boolean(report.exitReason) && report.exitReason !== "completed") ||
  (Array.isArray(report.attempts) && report.attempts.some(attempt => attempt?.status !== "completed")) ||
  (Number.isInteger(report.plannedRuns) && Number.isInteger(report.completedRuns) && report.completedRuns < report.plannedRuns);

const rulesById = new Map();
for (const finding of sortedFindings) {
  const ruleId = finding.templateId || finding.id || "0-finding";
  if (!rulesById.has(ruleId)) {
    rulesById.set(ruleId, {
      id: ruleId,
      name: finding.title || ruleId,
      shortDescription: {
        text: finding.title || "0 finding",
      },
      fullDescription: {
        text: finding.description || "0 detected a potential security issue.",
      },
      defaultConfiguration: {
        level: severityToLevel(finding.severity),
      },
      properties: {
        category: finding.category || "unknown",
        severity: finding.severity || "info",
      },
    });
  }
}

const sarif = {
  $schema: "https://json.schemastore.org/sarif-2.1.0.json",
  version: "2.1.0",
  runs: [
    {
      tool: {
        driver: {
          name: "0",
          informationUri: "https://github.com/0sec-labs/0",
          rules: Array.from(rulesById.values()),
        },
      },
      automationDetails: {
        id: `0/${mode}`,
      },
      properties: {
        mode,
        target: report.target || targetLabel,
        startedAt: report.startedAt || null,
        completedAt: report.completedAt || null,
      },
      results: sortedFindings.map((finding) => ({
        ruleId: finding.templateId || finding.id || "0-finding",
        level: severityToLevel(finding.severity),
        message: {
          text: [finding.description, finding.evidence?.analysis].filter(Boolean).join("\n\n") || finding.title || "0 finding",
        },
        locations: [
          {
            physicalLocation: findingLocation(finding, report.target || targetLabel),
          },
        ],
        properties: {
          severity: finding.severity || "info",
          category: finding.category || "unknown",
          findingId: finding.id || null,
        },
      })),
    },
  ],
};

fs.writeFileSync(sarifReportPath, JSON.stringify(sarif, null, 2));

const totalFindings = Number(summary.totalFindings ?? sortedFindings.length);
const critical = Number(summary.critical ?? 0);
const high = Number(summary.high ?? 0);
const medium = Number(summary.medium ?? 0);
const low = Number(summary.low ?? 0);
const info = Number(summary.info ?? 0);
const durationSeconds = typeof report.durationMs === "number" ? (report.durationMs / 1000).toFixed(1) : "0.0";
const reportFile = primaryFormat === "sarif" ? path.resolve(sarifReportPath) : path.resolve(jsonReportPath);
const gateMessage = severityThreshold === "none"
  ? "Threshold gate disabled."
  : `0 found ${qualifyingFindings.length} finding(s) at or above ${severityThreshold}; threshold allows ${countThreshold}.`;

const topFindings = sortedFindings.slice(0, 5);
const lines = [
  "<!-- 0-action -->",
  `## 0 ${mode} report`,
  "",
  `**Target:** \`${report.target || targetLabel}\``,
  `**Duration:** ${durationSeconds}s`,
  `**Gate:** ${severityThreshold === "none" ? "disabled" : `fail when findings at or above \`${severityThreshold}\` exceed \`${countThreshold}\``}`,
  "",
  "| Severity | Count |",
  "|----------|-------|",
  `| Critical | ${critical} |`,
  `| High | ${high} |`,
  `| Medium | ${medium} |`,
  `| Low | ${low} |`,
  `| Info | ${info} |`,
  `| **Total** | **${totalFindings}** |`,
  "",
];

if (topFindings.length > 0) {
  lines.push("### Top findings");
  lines.push("");
  lines.push("| Severity | Finding | Category |");
  lines.push("|----------|---------|----------|");
  for (const finding of topFindings) {
    lines.push(`| ${escapeCell(String(finding.severity).toUpperCase())} | ${escapeCell(finding.title)} | ${escapeCell(finding.category)} |`);
  }
  lines.push("");
} else {
  lines.push("No findings reported. This does not establish complete coverage or successful execution.");
  lines.push("");
}

if (warnings.length > 0) {
  lines.push("### Warnings");
  lines.push("");
  for (const warning of warnings.slice(0, 3)) {
    lines.push(`- **${escapeCell(warning.stage)}:** ${escapeCell(warning.message)}`);
  }
  lines.push("");
}

lines.push("---");
lines.push("*Generated by [0](https://github.com/0sec-labs/0)*");

const githubOutput = process.env.GITHUB_OUTPUT;
if (!githubOutput) {
  throw new Error("GITHUB_OUTPUT is not set.");
}

const stepSummary = process.env.GITHUB_STEP_SUMMARY;
if (stepSummary) {
  fs.appendFileSync(stepSummary, `${lines.filter((line) => line !== "<!-- 0-action -->").join("\n")}\n`);
}

const delimiter = `ZERO_${randomUUID().replaceAll("-", "")}`;
const outputLines = [
  `report-file=${reportFile}`,
  `json-report-file=${path.resolve(jsonReportPath)}`,
  `sarif-report-file=${path.resolve(sarifReportPath)}`,
  `total-findings=${totalFindings}`,
  `qualifying-findings=${qualifyingFindings.length}`,
  `should-fail=${shouldFail ? "true" : "false"}`,
  "skipped=false",
  `execution-successful=${executionFailed ? "false" : "true"}`,
  `gate-message=${gateMessage}`,
  `comment-body<<${delimiter}`,
  ...lines,
  delimiter,
];

fs.appendFileSync(githubOutput, `${outputLines.join("\n")}\n`);

if (process.env.ZERO_ACTION_ENFORCE_GATE === "1" && (shouldFail || executionFailed)) {
  if (shouldFail) console.error(`::error::${gateMessage}`);
  if (executionFailed) console.error("::error::The report records failed or incomplete execution; retained findings do not establish a clean run.");
  process.exitCode = 1;
}

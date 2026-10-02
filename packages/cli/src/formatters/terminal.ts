import chalk from "chalk";
import type { ScanReport, Finding, Severity } from "@0/shared";
import { getFindingPriority, compareFindingsByBusinessPriority } from "@0/shared";
import { buildShareUrl } from "../utils.js";

// ── Severity Design System ──

const SEVERITY_STYLE: Record<
  Severity,
  { badge: (s: string) => string; label: string; icon: string }
> = {
  critical: {
    badge: (s: string) => chalk.bgRed.white.bold(` ${s} `),
    label: "Critical",
    icon: "●",
  },
  high: {
    badge: (s: string) => chalk.bgRedBright.white.bold(` ${s} `),
    label: "High",
    icon: "●",
  },
  medium: {
    badge: (s: string) => chalk.bgYellow.black.bold(` ${s} `),
    label: "Medium",
    icon: "●",
  },
  low: {
    badge: (s: string) => chalk.bgBlue.white(` ${s} `),
    label: "Low",
    icon: "○",
  },
  info: {
    badge: (s: string) => chalk.bgGray.white(` ${s} `),
    label: "Info",
    icon: "·",
  },
};

const SEVERITY_COUNT_COLOR: Record<Severity, (s: string) => string> = {
  critical: chalk.red.bold,
  high: chalk.redBright.bold,
  medium: chalk.yellow.bold,
  low: chalk.blue,
  info: chalk.gray,
};

// ── Box Drawing ──

const BOX = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  teeRight: "├",
  teeLeft: "┤",
} as const;

function boxLine(width: number): string {
  return BOX.horizontal.repeat(width);
}

function boxTop(width: number): string {
  return `  ${chalk.gray(BOX.topLeft + boxLine(width) + BOX.topRight)}`;
}

function boxBottom(width: number): string {
  return `  ${chalk.gray(BOX.bottomLeft + boxLine(width) + BOX.bottomRight)}`;
}

function boxRow(content: string, width: number): string {
  // Strip ANSI to measure visible length
  const visible = stripAnsi(content);
  const pad = Math.max(0, width - visible.length);
  return `  ${chalk.gray(BOX.vertical)} ${content}${" ".repeat(pad)}${chalk.gray(BOX.vertical)}`;
}

function boxDivider(width: number): string {
  return `  ${chalk.gray(BOX.teeRight + boxLine(width) + BOX.teeLeft)}`;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Main Formatter ──

export function formatTerminal(report: ScanReport): string {
  const W = 60; // inner box width (excluding border chars)
  const lines: string[] = [];

  lines.push("");

  if (report.warnings.length > 0) {
    lines.push(`  ${chalk.yellow.bold("WARNINGS")}`);
    lines.push("");
    for (const warning of report.warnings) {
      lines.push(
        `  ${chalk.yellow.bold("!")} ${chalk.yellow(`[${warning.stage}] ${warning.message}`)}`
      );
    }
    lines.push("");
  }

  // ── Findings Section ──
  if (report.findings.length === 0) {
    lines.push("");
    if (report.warnings.length > 0 || report.executionSuccessful === false) {
      lines.push(
        `  ${chalk.yellow.bold("!")} ${chalk.yellow("No vulnerabilities confirmed. Scan finished with warnings.")}`
      );
    } else if (report.reviewChecks?.some(check => check.status !== "pass")) {
      lines.push(`  ${chalk.yellow.bold("!")} ${chalk.yellow("No security vulnerabilities found. Advisory review checks need attention.")}`);
    } else {
      lines.push(`  ${chalk.green.bold("✓")} ${chalk.green("No vulnerabilities found.")}`);
    }
  } else {
    lines.push(`  ${chalk.bold.white("FINDINGS")}`);
    lines.push("");

    const sorted = [...report.findings].sort(compareFindingsByBusinessPriority);

    for (const finding of sorted) {
      lines.push(formatFinding(finding));
    }
  }

  if (report.reviewChecks?.length) {
    lines.push("", `  ${chalk.bold.white("REVIEW CHECKS (advisory)")}`, "");
    for (const check of report.reviewChecks) {
      const color = check.status === "pass" ? chalk.green : chalk.yellow;
      lines.push(`  ${color(check.status.toUpperCase())} ${check.name} (${check.id})`);
      lines.push(`    Reason: ${check.reason}`);
      if (check.fix) lines.push(`    Suggested fix: ${check.fix}`);
      lines.push("");
    }
  }

  // ── Summary ──
  lines.push("");
  lines.push(`  ${chalk.gray("─".repeat(50))}`);
  lines.push("");

  const { summary } = report;
  const sev = [
    summary.critical > 0 ? chalk.red.bold(`${summary.critical} critical`) : chalk.gray(`${summary.critical} critical`),
    summary.high > 0 ? chalk.hex("#f97316").bold(`${summary.high} high`) : chalk.gray(`${summary.high} high`),
    summary.medium > 0 ? chalk.yellow.bold(`${summary.medium} medium`) : chalk.gray(`${summary.medium} medium`),
    chalk.gray(`${summary.low} low`),
    chalk.gray(`${summary.info} info`),
  ].join(chalk.gray("  "));
  for (const label of ["Urgent", "High", "Moderate", "Low", "Not assessed"]) {
    const count = report.findings.filter(finding => getFindingPriority(finding).label === label).length;
    if (count) lines.push(`  Business priority ${label}: ${count}`);
  }
  lines.push(`  ${chalk.gray("Technical severity:")} ${sev}`);
  lines.push(`  ${chalk.white.bold(String(summary.totalFindings))} findings ${chalk.gray("in")} ${chalk.white(formatDuration(report.durationMs))}`);
  lines.push(`  ${chalk.gray("Share:")} ${chalk.cyan(buildShareUrl(report))}`);
  lines.push("");

  return lines.join("\n");
}

// ── Finding Card ──

function formatFinding(finding: Finding): string {
  const priority = getFindingPriority(finding);
  const lines: string[] = [];

  // Badge + Title
  lines.push(`  ${chalk.bold(`Business priority: ${priority.label}`)} ${chalk.bold.white(finding.title)}`);
  lines.push(`    ${chalk.gray("Business impact rationale:")} ${priority.rationale}`);
  lines.push(`    ${chalk.gray("Technical severity:")} ${finding.severity}${finding.cvssScore !== undefined ? `  CVSS: ${finding.cvssScore}` : ""}${finding.cvssVector ? `  CVSS vector: ${finding.cvssVector}` : ""}`);

  // Category + OWASP
  const meta: string[] = [];
  meta.push(`${chalk.gray("Category:")} ${formatCategory(finding.category)}`);
  if (finding.status === "confirmed") {
    meta.push(chalk.green("✓ Confirmed"));
  }
  lines.push(`  ${" ".repeat(11)}${meta.join(chalk.gray("  ·  "))}`);

  // Description
  if (finding.description) {
    const desc =
      finding.description.length > 100
        ? finding.description.slice(0, 97) + "..."
        : finding.description;
    lines.push(`  ${" ".repeat(11)}${chalk.gray(desc)}`);
  }

  // Evidence snippet
  if (finding.evidence.analysis) {
    const ev =
      finding.evidence.analysis.length > 100
        ? finding.evidence.analysis.slice(0, 97) + "..."
        : finding.evidence.analysis;
    lines.push(`  ${" ".repeat(11)}${chalk.gray.italic("↳ " + ev)}`);
  }

  lines.push("");
  return lines.join("\n");
}

// ── Helpers ──

function buildSeverityLine(summary: {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}): string {
  const parts: string[] = [];
  const severities: Severity[] = ["critical", "high", "medium", "low", "info"];

  for (const sev of severities) {
    const count = summary[sev];
    const color = SEVERITY_COUNT_COLOR[sev];
    const icon = SEVERITY_STYLE[sev].icon;
    parts.push(` ${color(icon)} ${color(String(count))} ${chalk.gray(SEVERITY_STYLE[sev].label)}`);
  }

  return parts.join(chalk.gray("  "));
}

function formatCategory(cat: string): string {
  return cat
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Progress Bar (exported for use in index.ts) ──


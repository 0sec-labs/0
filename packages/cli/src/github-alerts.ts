import { createHash } from "node:crypto";
import { osecDB, recordAudit, resolveOsecDbPath, type AuditInput } from "@0/engine/storage";
import {
  CWE_CATEGORY,
  cweNumbers,
  type AttackCategory,
  type Finding,
  type ScanReport,
  type Severity,
} from "@0/engine/shared";
import { UsageError } from "./commands/output.js";
import { audit } from "./web/audit.js";

const REPO_PATTERN = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const severities = ["critical", "high", "medium", "low", "info"] as const;

export type GithubAlertKind = "code-scanning" | "dependabot" | "secret-scanning";
export type GithubAlertState = "open" | "dismissed" | "fixed" | "all";

export interface GithubCodeScanningAlert {
  number: number;
  created_at?: string;
  url?: string;
  html_url: string;
  state: "open" | "dismissed" | "fixed" | (string & {});
  dismissed_reason?: string | null;
  rule: {
    id: string;
    name?: string;
    severity?: string | null;
    security_severity_level?: string | null;
    description?: string;
    tags?: string[];
  };
  tool?: {
    name: string;
    guid?: string | null;
    version?: string | null;
  };
  most_recent_instance?: {
    ref?: string;
    analysis_key?: string;
    environment?: string;
    category?: string;
    state?: string;
    commit_sha?: string;
    message?: {
      text?: string;
    };
    location?: {
      path?: string;
      start_line?: number;
      end_line?: number;
      start_column?: number;
      end_column?: number;
    };
    classifications?: string[];
  };
}

export interface GithubDependabotAlert {
  number: number;
  state: "auto_dismissed" | "dismissed" | "fixed" | "open" | (string & {});
  dismissed_reason?: string | null;
  dependency: {
    package: {
      ecosystem?: string;
      name: string;
    };
    manifest_path?: string;
    scope?: string;
  };
  security_advisory: {
    ghsa_id: string;
    cve_id?: string | null;
    summary: string;
    description?: string;
    severity: "low" | "medium" | "high" | "critical" | (string & {});
    cvss?: {
      score?: number;
      vector_string?: string | null;
    };
    cwes?: Array<{
      cwe_id: string;
      name?: string;
    }>;
  };
  security_vulnerability?: {
    package?: {
      ecosystem?: string;
      name: string;
    };
    severity?: string;
    vulnerable_version_range?: string;
    first_patched_version?: {
      identifier?: string;
    } | null;
  };
  url?: string;
  html_url: string;
  created_at?: string;
}

export interface GithubSecretScanningAlert {
  number: number;
  created_at?: string;
  updated_at?: string;
  url?: string;
  html_url: string;
  locations_url?: string;
  state: "open" | "resolved" | (string & {});
  resolution?: string | null;
  secret_type: string;
  secret_type_display_name?: string;
  validity?: "active" | "inactive" | "unknown" | (string & {});
  locations?: Array<{
    type?: string;
    details?: {
      path?: string;
      start_line?: number;
      end_line?: number;
      start_column?: number;
      end_column?: number;
      blob_sha?: string;
    };
  }>;
}

export interface FetchedGithubAlerts {
  codeScanning: GithubCodeScanningAlert[];
  dependabot: GithubDependabotAlert[];
  secretScanning: GithubSecretScanningAlert[];
  warnings: Array<{ stage: string; message: string }>;
}

export interface GithubAlertsDeps {
  gh(args: string[], input?: string): Promise<string>;
}

export interface FetchGithubAlertsOptions {
  repo: string;
  state?: GithubAlertState;
  types?: GithubAlertKind[];
  ref?: string;
  tool?: string;
}

export interface ImportGithubAlertsOptions extends FetchGithubAlertsOptions {
  dbPath: string;
  now?: Date;
}

export interface GithubAlertsImportResult {
  scanId: string;
  findings: number;
  alreadyImported: boolean;
  dbPath: string;
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error("Report JSON nesting exceeds the limit.");
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Report JSON contains a nonfinite number.");
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseAlertKinds(raw?: string): GithubAlertKind[] {
  if (!raw || raw.trim() === "" || raw === "all") {
    return ["code-scanning", "dependabot", "secret-scanning"];
  }
  const parts = raw.split(",").map(part => part.trim().toLowerCase());
  const kinds = new Set<GithubAlertKind>();
  for (const part of parts) {
    if (part === "all") {
      return ["code-scanning", "dependabot", "secret-scanning"];
    }
    if (part === "code-scanning" || part === "dependabot" || part === "secret-scanning") {
      kinds.add(part);
    } else {
      throw new UsageError(`Unknown alert kind "${part}". Use code-scanning, dependabot, secret-scanning, or all.`);
    }
  }
  return [...kinds];
}

export function detectCategoryFromRule(ruleId: string, tags?: string[]): AttackCategory {
  const cwes = cweNumbers(tags ?? []);
  for (const cwe of cwes) {
    const match = CWE_CATEGORY[cwe];
    if (match) return match;
  }
  const lower = ruleId.toLowerCase();
  if (lower.includes("sql")) return "sql-injection";
  if (lower.includes("xss")) return "xss";
  if (lower.includes("path") || lower.includes("traversal")) return "path-traversal";
  if (lower.includes("command") || lower.includes("exec")) return "command-injection";
  if (lower.includes("code") || lower.includes("eval")) return "code-injection";
  if (lower.includes("ssrf")) return "ssrf";
  if (lower.includes("crypto") || lower.includes("cipher") || lower.includes("hash")) return "crypto-misuse";
  if (lower.includes("deserial")) return "unsafe-deserialization";
  if (lower.includes("regex") || lower.includes("dos")) return "regex-dos";
  if (lower.includes("pollution")) return "prototype-pollution";
  if (lower.includes("disclosure") || lower.includes("secret") || lower.includes("leak") || lower.includes("credential")) {
    return "information-disclosure";
  }
  if (lower.includes("overflow") || lower.includes("oob")) return "stack-buffer-overflow";
  if (lower.includes("cors")) return "cors";
  return "security-misconfiguration";
}

export function detectSeverityFromRule(securitySeverityLevel?: string | null, ruleSeverity?: string | null): Severity {
  if (securitySeverityLevel) {
    const lower = securitySeverityLevel.toLowerCase();
    if (lower === "critical" || lower === "high" || lower === "medium" || lower === "low") return lower;
  }
  if (ruleSeverity) {
    const lower = ruleSeverity.toLowerCase();
    if (lower === "error") return "high";
    if (lower === "warning") return "medium";
    if (lower === "note") return "low";
    if (lower === "none") return "info";
  }
  return "medium";
}

export function detectCategoryFromAdvisory(cwes?: Array<{ cwe_id?: string }>): AttackCategory {
  if (cwes) {
    const nums = cweNumbers(cwes.map(c => c.cwe_id ?? ""));
    for (const n of nums) {
      const match = CWE_CATEGORY[n];
      if (match) return match;
    }
  }
  return "known-vulnerable-package";
}

function isAuthError(msg: string): boolean {
  return /auth login|authentication|not logged in|unauthorized|bad credentials/i.test(msg);
}

async function fetchEndpointPages<T>(
  repo: string,
  subpath: string,
  params: Record<string, string>,
  deps: GithubAlertsDeps,
): Promise<{ items: T[]; warning?: string }> {
  const items: T[] = [];
  let page = 1;
  const perPage = 100;
  const maxPages = 20;

  while (page <= maxPages) {
    const query = new URLSearchParams({ ...params, per_page: String(perPage), page: String(page) }).toString();
    const endpoint = `repos/${repo}/${subpath}?${query}`;
    let stdout: string;
    try {
      stdout = await deps.gh(["api", endpoint]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthError(msg)) {
        throw new Error(`GitHub authentication required: ${msg}`);
      }
      if (page === 1) {
        return { items: [], warning: msg };
      }
      break;
    }
    const text = stdout.trim();
    if (!text) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      break;
    }
    if (!Array.isArray(parsed)) {
      break;
    }
    items.push(...(parsed as T[]));
    if (parsed.length < perPage) {
      break;
    }
    page++;
  }
  return { items };
}

export async function fetchGithubAlerts(
  options: FetchGithubAlertsOptions,
  deps: GithubAlertsDeps,
): Promise<FetchedGithubAlerts> {
  const repo = options.repo.trim();
  if (!REPO_PATTERN.test(repo)) {
    throw new UsageError(`Invalid repository name "${repo}". Expected format: owner/repo.`);
  }

  const state = options.state ?? "open";
  if (!["open", "dismissed", "fixed", "all"].includes(state)) {
    throw new UsageError(`Unknown alert state "${state}". Use one of: open, dismissed, fixed, all.`);
  }

  const types = options.types ?? ["code-scanning", "dependabot", "secret-scanning"];
  const warnings: Array<{ stage: string; message: string }> = [];

  let codeScanning: GithubCodeScanningAlert[] = [];
  let dependabot: GithubDependabotAlert[] = [];
  let secretScanning: GithubSecretScanningAlert[] = [];

  for (const type of types) {
    if (type === "code-scanning") {
      const params: Record<string, string> = {};
      if (state !== "all") params.state = state;
      if (options.ref) params.ref = options.ref;
      if (options.tool) params.tool_name = options.tool;

      const { items, warning } = await fetchEndpointPages<GithubCodeScanningAlert>(
        repo,
        "code-scanning/alerts",
        params,
        deps,
      );
      if (warning) {
        if (types.length === 1) {
          throw new Error(`Failed to fetch code-scanning alerts for ${repo}: ${warning}`);
        }
        warnings.push({ stage: "code-scanning", message: warning });
      } else {
        codeScanning = items;
      }
    } else if (type === "dependabot") {
      const params: Record<string, string> = {};
      if (state === "open") params.state = "open";
      else if (state === "dismissed") params.state = "dismissed,auto_dismissed";
      else if (state === "fixed") params.state = "fixed";

      const { items, warning } = await fetchEndpointPages<GithubDependabotAlert>(
        repo,
        "dependabot/alerts",
        params,
        deps,
      );
      if (warning) {
        if (types.length === 1) {
          throw new Error(`Failed to fetch dependabot alerts for ${repo}: ${warning}`);
        }
        warnings.push({ stage: "dependabot", message: warning });
      } else {
        dependabot = items;
      }
    } else if (type === "secret-scanning") {
      const params: Record<string, string> = {};
      if (state === "open") params.state = "open";
      else if (state === "dismissed" || state === "fixed") params.state = "resolved";

      const { items, warning } = await fetchEndpointPages<GithubSecretScanningAlert>(
        repo,
        "secret-scanning/alerts",
        params,
        deps,
      );
      if (warning) {
        if (types.length === 1) {
          throw new Error(`Failed to fetch secret-scanning alerts for ${repo}: ${warning}`);
        }
        warnings.push({ stage: "secret-scanning", message: warning });
      } else {
        secretScanning = items;
      }
    }
  }

  if (warnings.length === types.length && codeScanning.length === 0 && dependabot.length === 0 && secretScanning.length === 0) {
    throw new Error(`Failed to fetch GitHub security alerts for ${repo}: ${warnings.map(w => w.message).join("; ")}`);
  }

  return { codeScanning, dependabot, secretScanning, warnings };
}

export function mapGithubAlertsToFindings(
  alerts: FetchedGithubAlerts,
  scanId: string,
  now: Date,
  toolOverride?: string,
): Finding[] {
  const timestamp = now.getTime();
  const findings: Finding[] = [];
  const seenIds = new Set<string>();

  // 1. Code scanning alerts
  for (const alert of alerts.codeScanning) {
    const tool = toolOverride ?? alert.tool?.name ?? "code-scanning";
    const templateId = `${tool}/${alert.rule.id}`;
    const category = detectCategoryFromRule(alert.rule.id, alert.rule.tags);
    const severity = detectSeverityFromRule(alert.rule.security_severity_level, alert.rule.severity);
    const loc = alert.most_recent_instance?.location;
    const path = loc?.path;
    const startLine = loc?.start_line;
    const endLine = loc?.end_line;
    const where = path ? `${path}${startLine ? `:${startLine}` : ""}` : "repository";

    const findingKey = hash(`code-scanning:${alert.number}:${alert.rule.id}:${path ?? ""}`);
    let id = `${scanId}-${findingKey}`;
    if (seenIds.has(id)) id = `${id}-${alert.number}`;
    seenIds.add(id);

    findings.push({
      id,
      fingerprint: `${scanId}:${findingKey}`,
      templateId,
      title: alert.rule.description || alert.rule.name || alert.rule.id,
      description: alert.most_recent_instance?.message?.text || alert.rule.description || alert.rule.id,
      category,
      severity,
      tool,
      evidence: {
        request: where,
        response: alert.most_recent_instance?.message?.text || alert.state,
        analysis: `Imported from GitHub Code Scanning (${alert.html_url}). Alert #${alert.number}, state: ${alert.state}. Tool: ${alert.tool?.name ?? "unknown"}${alert.tool?.version ? ` ${alert.tool.version}` : ""}.`,
      },
      ...(path && startLine ? { reviewAnnotation: { path, startLine, ...(endLine && endLine >= startLine ? { endLine } : {}) } } : {}),
      timestamp: alert.created_at ? Date.parse(alert.created_at) || timestamp : timestamp,
      status: "discovered",
      triageStatus: alert.state === "dismissed" ? "suppressed" : "new",
      workflowStatus: "backlog",
    });
  }

  // 2. Dependabot alerts
  for (const alert of alerts.dependabot) {
    const tool = toolOverride ?? "dependabot";
    const templateId = alert.security_advisory.ghsa_id || `dependabot/${alert.dependency.package.name}`;
    const category = detectCategoryFromAdvisory(alert.security_advisory.cwes);
    const advisorySev = alert.security_advisory.severity?.toLowerCase();
    const severity: Severity = severities.includes(advisorySev as Severity) ? (advisorySev as Severity) : "medium";
    const manifestPath = alert.dependency.manifest_path;
    const pkg = alert.dependency.package.name;
    const ecosystem = alert.dependency.package.ecosystem ?? "package";

    const findingKey = hash(`dependabot:${alert.number}:${alert.security_advisory.ghsa_id}:${pkg}`);
    let id = `${scanId}-${findingKey}`;
    if (seenIds.has(id)) id = `${id}-${alert.number}`;
    seenIds.add(id);

    const cve = alert.security_advisory.cve_id;
    const cwes = alert.security_advisory.cwes?.map(c => c.cwe_id).join(", ");

    findings.push({
      id,
      fingerprint: `${scanId}:${findingKey}`,
      templateId,
      title: alert.security_advisory.summary || `${pkg} vulnerability`,
      description: alert.security_advisory.description || alert.security_advisory.summary,
      category,
      severity,
      tool,
      evidence: {
        request: `${manifestPath ?? "manifest"}: ${pkg} (${ecosystem})`,
        response: `Vulnerable range: ${alert.security_vulnerability?.vulnerable_version_range ?? "unknown"}. Patched version: ${alert.security_vulnerability?.first_patched_version?.identifier ?? "none"}.`,
        analysis: `Imported from GitHub Dependabot (${alert.html_url}). Alert #${alert.number}, state: ${alert.state}.${cve ? ` CVE: ${cve}.` : ""}${cwes ? ` CWEs: ${cwes}.` : ""}`,
      },
      ...(manifestPath ? { reviewAnnotation: { path: manifestPath, startLine: 1 } } : {}),
      ...(alert.security_advisory.cvss?.score != null ? { cvssScore: alert.security_advisory.cvss.score } : {}),
      ...(alert.security_advisory.cvss?.vector_string ? { cvssVector: alert.security_advisory.cvss.vector_string } : {}),
      timestamp: alert.created_at ? Date.parse(alert.created_at) || timestamp : timestamp,
      status: "discovered",
      triageStatus: alert.state === "dismissed" || alert.state === "auto_dismissed" ? "suppressed" : "new",
      workflowStatus: "backlog",
    });
  }

  // 3. Secret scanning alerts
  for (const alert of alerts.secretScanning) {
    const tool = toolOverride ?? "secret-scanning";
    const templateId = `secret-scanning/${alert.secret_type}`;
    const category: AttackCategory = "information-disclosure";
    const severity: Severity = alert.validity === "active" ? "critical" : "high";
    const displayName = alert.secret_type_display_name || alert.secret_type;

    const loc = alert.locations?.[0]?.details;
    const path = loc?.path;
    const startLine = loc?.start_line;
    const endLine = loc?.end_line;

    const findingKey = hash(`secret-scanning:${alert.number}:${alert.secret_type}`);
    let id = `${scanId}-${findingKey}`;
    if (seenIds.has(id)) id = `${id}-${alert.number}`;
    seenIds.add(id);

    findings.push({
      id,
      fingerprint: `${scanId}:${findingKey}`,
      templateId,
      title: `${displayName} exposed`,
      description: `GitHub Secret Scanning detected a potential secret of type ${displayName} (alert #${alert.number}).`,
      category,
      severity,
      tool,
      evidence: {
        request: displayName,
        response: `Validity: ${alert.validity ?? "unknown"}. State: ${alert.state}.${alert.resolution ? ` Resolution: ${alert.resolution}.` : ""}`,
        analysis: `Imported from GitHub Secret Scanning (${alert.html_url}). Alert #${alert.number}, state: ${alert.state}.`,
      },
      ...(path && startLine ? { reviewAnnotation: { path, startLine, ...(endLine && endLine >= startLine ? { endLine } : {}) } } : {}),
      timestamp: alert.created_at ? Date.parse(alert.created_at) || timestamp : timestamp,
      status: "discovered",
      triageStatus: alert.state === "resolved" ? "suppressed" : "new",
      workflowStatus: "backlog",
    });
  }

  return findings;
}

export function prepareGithubAlertsImport(
  repo: string,
  alerts: FetchedGithubAlerts,
  options: { state?: GithubAlertState; types?: GithubAlertKind[]; ref?: string; tool?: string; now?: Date } = {},
): Parameters<osecDB["importCiReport"]>[0] {
  const now = options.now ?? new Date();
  const importedAt = now.toISOString();
  const selectedTypes = options.types ?? ["code-scanning", "dependabot", "secret-scanning"];
  const target = `github:${repo}`;

  const payload = {
    repo,
    state: options.state ?? "open",
    types: selectedTypes,
    ref: options.ref ?? null,
    tool: options.tool ?? null,
    codeScanningCount: alerts.codeScanning.length,
    dependabotCount: alerts.dependabot.length,
    secretScanningCount: alerts.secretScanning.length,
    codeScanning: alerts.codeScanning.map(a => ({ number: a.number, state: a.state, rule: a.rule?.id })),
    dependabot: alerts.dependabot.map(a => ({ number: a.number, state: a.state, ghsa: a.security_advisory?.ghsa_id })),
    secretScanning: alerts.secretScanning.map(a => ({ number: a.number, state: a.state, type: a.secret_type })),
  };

  const digest = hash(canonical(payload));
  const scanId = `ci-${digest}`;
  const findings = mapGithubAlertsToFindings(alerts, scanId, now, options.tool);

  const report = {
    target,
    scanDepth: "default",
    startedAt: importedAt,
    completedAt: importedAt,
    durationMs: 0,
    findings: [],
    warnings: alerts.warnings,
  } as unknown as ScanReport;

  const provenance = {
    schemaVersion: 1,
    source: "github-alerts",
    trust: "unverified",
    sourceExecutionStatus: "unknown",
    digest,
    importedAt,
    repository: repo,
    ref: options.ref ?? null,
    state: options.state ?? "open",
    types: selectedTypes,
    metadata: null,
  };

  return {
    scanId,
    report,
    findings,
    status: "completed",
    provenance,
    summary: {
      totalAttacks: 0,
      totalFindings: findings.length,
      ...Object.fromEntries(severities.map(severity => [severity, findings.filter(f => f.severity === severity).length])),
      executionSuccessful: true,
      exitReason: "completed",
    },
  };
}

export async function importGithubAlerts(
  options: ImportGithubAlertsOptions,
  deps: GithubAlertsDeps,
): Promise<GithubAlertsImportResult> {
  const dbPath = resolveOsecDbPath(options.dbPath);
  if (!dbPath) throw new UsageError("An explicit destination database path is required.");

  const alerts = await fetchGithubAlerts(options, deps);
  const input = prepareGithubAlertsImport(options.repo, alerts, options);

  const db = new osecDB(dbPath);
  let result: { scanId: string; alreadyImported: boolean };
  try {
    result = db.importCiReport(input);
  } finally {
    db.close();
  }

  const selectedTypes = options.types ?? ["code-scanning", "dependabot", "secret-scanning"];
  const auditEvent: AuditInput = {
    actor: "cli",
    action: "findings.import.github",
    subject: options.repo,
    outcome: "ok",
    detail: {
      id: result.scanId,
      count: input.findings.length,
      repo: options.repo,
      kind: selectedTypes.join(","),
      status: result.alreadyImported ? "already_imported" : "imported",
    },
  };

  try {
    recordAudit(auditEvent, { dbPath });
  } catch {
    /* Audit recording should not block import completion */
  }

  try {
    audit(auditEvent);
  } catch {
    /* Optional runtime audit */
  }

  return {
    scanId: result.scanId,
    findings: input.findings.length,
    alreadyImported: result.alreadyImported,
    dbPath,
  };
}

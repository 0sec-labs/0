/**
 * Read findings from a SARIF 2.1.0 log written by another scanner.
 *
 * The input is untrusted text from a file: every string is length-limited and
 * stripped of control characters, locations are repo-relative paths that cannot
 * leave the repository, and nothing in the log is executed or fetched.
 */
import { createHash } from "node:crypto";
import { normalizeAttackCategory } from "./finding-schemas.js";
import type { AttackCategory, Severity } from "./types.js";

export const MAX_SARIF_RESULTS = 5000;
const MAX_RUNS = 20;

export interface ImportedFinding {
  /** Scanner that produced the finding, for example `CodeQL` or `foxguard`. */
  tool: string;
  toolVersion?: string;
  ruleId: string;
  title: string;
  description: string;
  severity: Severity;
  category: AttackCategory;
  /** Repo-relative path, forward slashes. */
  path?: string;
  startLine?: number;
  endLine?: number;
  snippet?: string;
  /** Stable across runs of the same scanner on the same code. */
  fingerprint: string;
  cwe: string[];
}

export interface SarifImport {
  findings: ImportedFinding[];
  tools: string[];
  repository?: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(CONTROL, "").trim().slice(0, max) : "";
}
const textOf = (value: unknown, max: number): string => isObject(value) ? clean(value.text ?? value.markdown, max) : clean(value, max);
const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** A SARIF artifact URI as a path inside the repository, or undefined when it points anywhere else. */
export function repoRelativePath(uri: unknown, roots: readonly string[] = []): string | undefined {
  let value = clean(uri, 2048);
  if (!value) return undefined;
  value = value.replace(/^file:\/\/(?:localhost)?/i, "");
  try { value = decodeURIComponent(value); } catch { return undefined; }
  value = value.replace(/\\/g, "/").replace(/^\.\//, "");
  // An absolute path is kept only when it is inside a root the caller named (the folder that was scanned).
  for (const root of roots) {
    const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (base && value.startsWith(`${base}/`)) { value = value.slice(base.length + 1); break; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:\//i.test(value)) return undefined;
  if (value.startsWith("/") || /^[a-z]:\//i.test(value)) return undefined;
  const parts = value.split("/").filter(part => part && part !== ".");
  if (!parts.length || parts.includes("..")) return undefined;
  return parts.join("/");
}

export const CWE_CATEGORY: Record<number, AttackCategory> = {
  22: "path-traversal", 23: "path-traversal", 36: "path-traversal", 73: "path-traversal",
  78: "command-injection", 77: "command-injection", 88: "command-injection",
  79: "xss", 80: "xss", 83: "xss", 87: "xss",
  89: "sql-injection", 564: "sql-injection",
  94: "code-injection", 95: "code-injection", 96: "code-injection", 1336: "code-injection",
  200: "information-disclosure", 209: "information-disclosure", 532: "information-disclosure", 312: "information-disclosure", 798: "information-disclosure",
  326: "crypto-misuse", 327: "crypto-misuse", 328: "crypto-misuse", 330: "crypto-misuse", 338: "crypto-misuse",
  352: "security-misconfiguration", 942: "cors", 16: "security-misconfiguration", 1004: "security-misconfiguration", 614: "security-misconfiguration",
  502: "unsafe-deserialization", 918: "ssrf", 1333: "regex-dos", 400: "regex-dos", 1321: "prototype-pollution",
  20: "missing-validation", 129: "missing-validation",
  416: "use-after-free", 476: "null-pointer-deref", 787: "out-of-bounds-write", 125: "out-of-bounds-read", 119: "out-of-bounds-write",
  120: "stack-buffer-overflow", 121: "stack-buffer-overflow", 122: "heap-overflow", 190: "integer-overflow", 362: "race-condition",
};

export function cweNumbers(...sources: unknown[]): number[] {
  const found = new Set<number>();
  for (const source of sources) {
    for (const entry of list(source)) {
      const match = /cwe[-_/ ]?0*(\d{1,5})\b/i.exec(typeof entry === "string" ? entry : "");
      if (match) found.add(Number(match[1]));
    }
  }
  return [...found];
}

function severityOf(level: unknown, rule: Json | undefined, result: Json): Severity {
  const properties = isObject(rule?.properties) ? rule.properties : {};
  const resultProperties = isObject(result.properties) ? result.properties : {};
  const score = Number(resultProperties["security-severity"] ?? properties["security-severity"]);
  if (Number.isFinite(score) && score > 0) return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";
  switch (level) {
    case "error": return "high";
    case "warning": return "medium";
    case "note": return "low";
    case "none": return "info";
    default: return "medium";
  }
}

/** The folder a SARIF base id points at, when it is an absolute file URI. */
function repoUriBase(uri: unknown): string {
  const value = clean(uri, 2048).replace(/^file:\/\/(?:localhost)?/i, "");
  try { const decoded = decodeURIComponent(value); return decoded.startsWith("/") || /^[a-z]:[\\/]/i.test(decoded) ? decoded : ""; } catch { return ""; }
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);

/** Parse a SARIF log. Throws a short message when the document is not SARIF 2.1.0 or is too large. */
export function parseSarif(text: string, options: { tool?: string; roots?: readonly string[] } = {}): SarifImport {
  let log: unknown;
  try { log = JSON.parse(text); } catch { throw new Error("The file is not valid JSON."); }
  if (!isObject(log) || !Array.isArray(log.runs)) throw new Error("This is not a SARIF log: it has no runs.");
  if (typeof log.version === "string" && !log.version.startsWith("2.1")) throw new Error(`Unsupported SARIF version ${clean(log.version, 16)}; expected 2.1.0.`);
  if (log.runs.length > MAX_RUNS) throw new Error(`The log has more than ${MAX_RUNS} runs.`);

  const findings: ImportedFinding[] = [];
  const tools = new Set<string>();
  let repository: string | undefined;
  for (const run of log.runs) {
    if (!isObject(run)) continue;
    const driver = isObject(run.tool) && isObject(run.tool.driver) ? run.tool.driver : {};
    const tool = options.tool?.trim() ? clean(options.tool, 80) : clean(driver.name, 80) || "unknown";
    const toolVersion = clean(driver.semanticVersion ?? driver.version, 40) || undefined;
    tools.add(tool);
    const provenance = list(run.versionControlProvenance).find(isObject);
    repository ??= provenance ? clean(provenance.repositoryUri, 300) || undefined : undefined;
    const bases = isObject(run.originalUriBaseIds) ? Object.values(run.originalUriBaseIds).filter(isObject).map(entry => repoUriBase(entry.uri)).filter(Boolean) : [];
    const roots = [...(options.roots ?? []), ...bases];
    const rules = list(driver.rules).filter(isObject);
    const byId = new Map(rules.map(rule => [clean(rule.id, 200), rule] as const));
    for (const raw of list(run.results)) {
      if (!isObject(raw)) continue;
      if (findings.length >= MAX_SARIF_RESULTS) throw new Error(`The log has more than ${MAX_SARIF_RESULTS} results; split it and import the parts.`);
      if (raw.suppressions && list(raw.suppressions).length) continue;
      const index = typeof raw.ruleIndex === "number" ? raw.ruleIndex : -1;
      const ruleId = clean(raw.ruleId, 200) || clean(isObject(raw.rule) ? raw.rule.id : "", 200) || clean(rules[index]?.id, 200) || "unknown-rule";
      const rule = byId.get(ruleId) ?? rules[index];
      const message = textOf(raw.message, 4000);
      const ruleTitle = textOf(rule?.shortDescription, 300) || clean(rule?.name, 300);
      const title = (ruleTitle || message.split("\n")[0] || ruleId).slice(0, 300);
      const help = textOf(rule?.fullDescription, 2000) || textOf(rule?.help, 2000);
      const description = [message, help && help !== message ? help : ""].filter(Boolean).join("\n\n").slice(0, 6000) || title;

      const physical = list(raw.locations).filter(isObject).map(location => location.physicalLocation).find(isObject);
      const artifact = physical && isObject(physical.artifactLocation) ? physical.artifactLocation : undefined;
      const path = repoRelativePath(artifact?.uri, roots);
      const region = physical && isObject(physical.region) ? physical.region : undefined;
      const startLine = positive(region?.startLine);
      const endLine = positive(region?.endLine);
      const snippet = region && isObject(region.snippet) ? clean(region.snippet.text, 2000) || undefined : undefined;

      const ruleProperties = isObject(rule?.properties) ? rule.properties : {};
      const resultProperties = isObject(raw.properties) ? raw.properties : {};
      const cwe = cweNumbers(ruleProperties.tags, resultProperties.tags, ruleProperties.cwe, resultProperties.cwe);
      const fromCwe = cwe.map(number => CWE_CATEGORY[number]).find(Boolean);
      const category = fromCwe ?? normalizeAttackCategory(ruleId).category;

      const partial = isObject(raw.partialFingerprints) ? Object.entries(raw.partialFingerprints).find(([, value]) => typeof value === "string" && value) : undefined;
      const key = partial
        ? `${partial[0]}:${clean(partial[1], 200)}`
        : `${path ?? ""}:${startLine ?? ""}:${message.slice(0, 200)}`;
      findings.push({
        tool, ...(toolVersion ? { toolVersion } : {}), ruleId, title, description,
        severity: severityOf(raw.level ?? (isObject(rule?.defaultConfiguration) ? rule.defaultConfiguration.level : undefined), rule, raw),
        category, ...(path ? { path } : {}), ...(startLine ? { startLine } : {}), ...(endLine ? { endLine } : {}), ...(snippet ? { snippet } : {}),
        fingerprint: `sarif:${sha(`${tool}\n${ruleId}\n${path ?? ""}\n${key}`)}`,
        cwe: cwe.map(number => `CWE-${number}`),
      });
    }
  }
  return { findings, tools: [...tools], ...(repository ? { repository } : {}) };
}

/** True when the parsed JSON looks like a SARIF log rather than one of 0's own reports. */
export function looksLikeSarif(text: string): boolean {
  if (!/"runs"\s*:/.test(text)) return false;
  try { const value = JSON.parse(text); return isObject(value) && Array.isArray(value.runs); } catch { return false; }
}

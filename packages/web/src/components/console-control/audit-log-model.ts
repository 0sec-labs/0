import { formatRelativeAge } from "@/lib/relative-time";
import { webSettingDetails } from "./web-settings";
import { describeSettingValue } from "./settings-reset-model";

/** "titleInstructions" -> its screen label, else "Title instructions". */
function settingName(key: string): string {
  const label = webSettingDetails(key)?.label;
  if (label) return label;
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Settings subjects read as screen labels; other subjects stay as recorded. */
export function auditSubject(event: { action: string; subject: string; detail: Record<string, unknown> }, sentinelNames: ReadonlyMap<string, string> = new Map()): string {
  if (event.action.startsWith("sentinel.") && typeof event.detail.sentinelId === "string" && event.subject === event.detail.sentinelId) return sentinelNames.get(event.subject) ?? event.subject;
  if (event.action === "settings.change") return settingName(event.subject);
  if (event.action === "settings.reset") {
    const keys = Array.isArray(event.detail.keys) ? event.detail.keys.filter((key): key is string => typeof key === "string") : [];
    if (keys.length === 1) return settingName(keys[0]!);
    return keys.length > 1 ? `${keys.length} settings` : "All settings";
  }
  return event.subject;
}

export type AuditEntry = { id: number; ts: string; actor: string; action: string; subject: string; outcome: "ok" | "denied" | "error"; detail: Record<string, unknown> };
export type AuditLogResponse = { events: AuditEntry[]; nextBefore: number | null };
export type AuditSort = "newest" | "oldest";

export const AUDIT_PAGE_SIZE = 100;
export const AUDIT_EMPTY = "Privileged actions on this computer will be recorded here.";

export function auditLogPath(options: { q?: string; before?: number | null; limit?: number } = {}): string {
  const params = new URLSearchParams({ limit: String(options.limit ?? AUDIT_PAGE_SIZE) });
  const q = options.q?.trim();
  if (q) params.set("q", q);
  if (options.before) params.set("before", String(options.before));
  return `/api/console/audit-log?${params}`;
}

const ACRONYMS = new Map([["mcp", "MCP"], ["github", "GitHub"], ["ok", "OK"]]);
/** "mcp.create" -> "MCP create", "access.browser_only" -> "Access browser only". */
const SENTINEL_STATUS_LABEL: Record<string, string> = { archived: "Sentinel archived", active: "Sentinel turned on", paused: "Sentinel paused" };
export function auditActionLabel(action: string, detail: Record<string, unknown> = {}): string {
  if (action === "finding.triage") return detail.decision === "accepted" ? "Finding accepted" : detail.decision === "suppressed" ? "Finding dismissed" : detail.decision === "new" ? "Finding restored" : "Finding reviewed";
  if (action === "sentinel.update" && typeof detail.status === "string" && SENTINEL_STATUS_LABEL[detail.status]) return SENTINEL_STATUS_LABEL[detail.status]!;
  if (action === "sentinel.file.edit") return "Sentinel file edited";
  if (action === "sentinel.file.delete") return "Sentinel file deleted";
  const words = action.split(/[._-]+/).filter(Boolean).map(word => ACRONYMS.get(word) ?? word);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function auditWhen(ts: string, now = Date.now()): { relative: string; exact: string } {
  const time = Date.parse(ts);
  if (!Number.isFinite(time)) return { relative: "Unknown", exact: ts };
  const age = formatRelativeAge(time, now);
  return { relative: age === "now" ? "Just now" : `${age} ago`, exact: new Date(time).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") };
}

export function sortAudit(events: readonly AuditEntry[], sort: AuditSort): AuditEntry[] {
  return [...events].sort((a, b) => sort === "newest" ? b.id - a.id : a.id - b.id);
}

/** One-line summary of the safe detail keys, for the Subject column's second line. */
export function auditDetailSummary(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof detail.key === "string" && ("old" in detail || "new" in detail)) parts.push(`${detail.old === undefined || detail.old === null ? "Not set" : describeSettingValue(detail.key, detail.old)} → ${detail.new === undefined || detail.new === null ? "Not set" : describeSettingValue(detail.key, detail.new)}`);
  if (Array.isArray(detail.keys) && detail.keys.length > 1) parts.push(detail.keys.slice(0, 20).map(key => settingName(String(key))).join(", "));
  if (Array.isArray(detail.envKeys) && detail.envKeys.length) parts.push(`env: ${detail.envKeys.join(", ")}`);
  if (typeof detail.path === "string") parts.push(detail.path);
  if (typeof detail.fingerprint === "string" && typeof detail.decision !== "string") parts.push(`fingerprint ${detail.fingerprint}`);
  if (typeof detail.callerKind === "string" && typeof detail.route === "string") parts.push(`${detail.callerKind} → ${String(detail.method ?? "")} ${detail.route}`.replace("  ", " "));
  if (typeof detail.reason === "string") parts.push(detail.reason);
  return parts.join(" · ");
}

/** The exported file is exactly the rows on screen. */
export function auditExportJson(events: readonly AuditEntry[]): string {
  return JSON.stringify(events.map(({ id, ts, actor, action, subject, outcome, detail }) => ({ id, ts, actor, action, subject, outcome, detail })), null, 2);
}

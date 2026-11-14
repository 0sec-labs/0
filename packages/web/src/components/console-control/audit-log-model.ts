import { formatRelativeAge } from "@/lib/relative-time";

export type AuditEntry = { id: number; ts: string; actor: string; action: string; subject: string; outcome: "ok" | "denied" | "error"; detail: Record<string, unknown> };
export type AuditLogResponse = { events: AuditEntry[]; nextBefore: number | null };
export type AuditSort = "newest" | "oldest";

export const AUDIT_PAGE_SIZE = 100;
export const AUDIT_EMPTY = "Privileged actions on this engine will be recorded here.";

export function auditLogPath(options: { q?: string; before?: number | null; limit?: number } = {}): string {
  const params = new URLSearchParams({ limit: String(options.limit ?? AUDIT_PAGE_SIZE) });
  const q = options.q?.trim();
  if (q) params.set("q", q);
  if (options.before) params.set("before", String(options.before));
  return `/api/console/audit-log?${params}`;
}

const ACRONYMS = new Map([["mcp", "MCP"], ["github", "GitHub"], ["ok", "OK"]]);
/** "mcp.create" -> "MCP create", "access.browser_only" -> "Access browser only". */
export function auditActionLabel(action: string): string {
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
  if (typeof detail.key === "string" && ("old" in detail || "new" in detail)) parts.push(`${String(detail.old ?? "unset")} → ${String(detail.new ?? "unset")}`);
  if (Array.isArray(detail.envKeys) && detail.envKeys.length) parts.push(`env: ${detail.envKeys.join(", ")}`);
  if (typeof detail.fingerprint === "string") parts.push(`fingerprint ${detail.fingerprint}`);
  if (typeof detail.callerKind === "string" && typeof detail.route === "string") parts.push(`${detail.callerKind} → ${String(detail.method ?? "")} ${detail.route}`.replace("  ", " "));
  if (typeof detail.reason === "string") parts.push(detail.reason);
  return parts.join(" · ");
}

/** The exported file is exactly the rows on screen. */
export function auditExportJson(events: readonly AuditEntry[]): string {
  return JSON.stringify(events.map(({ id, ts, actor, action, subject, outcome, detail }) => ({ id, ts, actor, action, subject, outcome, detail })), null, 2);
}

import { ensureDatabaseDirectory } from "./db-directory.js";
import { resolveOsecDbPath } from "./database.js";
import { createShimmedDatabase, type ShimmedDatabase } from "./wasm-shim.js";

/** Rows kept in the local audit log. Older rows are rotated out; nothing else ever deletes or edits a row. */
export const AUDIT_MAX_ROWS = 50_000;
export const AUDIT_FIELD_MAX = 200;
export const AUDIT_DETAIL_MAX_BYTES = 4_000;

export type AuditOutcome = "ok" | "denied" | "error";
export interface AuditEvent { id: number; ts: string; actor: string; action: string; subject: string; outcome: AuditOutcome; detail: Record<string, unknown> }
export interface AuditInput { actor: string; action: string; subject?: string; outcome?: AuditOutcome; detail?: Record<string, unknown>; ts?: string }
export interface AuditTarget { dbPath?: string; /** Row cap override (tests). */ maxRows?: number }

/** Only these detail keys are ever stored. Anything else a caller passes is dropped. */
export const AUDIT_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "key", "keys", "old", "new", "scope", "enabled", "approved", "decision", "fingerprint", "name", "transport", "envKeys", "headerKeys",
  "callerKind", "route", "method", "status", "code", "kind", "id", "sentinelId", "triggerId", "trigger", "reason", "role", "autonomy",
  "seed", "preset", "count", "source", "repo", "sessionId", "decisionId", "path", "version",
]);
const SECRET_KEY = /secret|token|passw|api[-_]?key|authorization|credential|private[-_]?key|cookie|bearer|session[-_]?key/i;
const SECRET_VALUE: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g, /\bgh[pousr]_[A-Za-z0-9]{16,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, /\b(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g,
  /\b(?:password|passwd|secret|token|api[-_]?key|authorization)\s*[=:]\s*\S+/gi,
];

export function isSecretName(name: string): boolean { return SECRET_KEY.test(name); }

function scrub(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE) out = out.replace(pattern, "[redacted]");
  return out.length > AUDIT_FIELD_MAX ? `${out.slice(0, AUDIT_FIELD_MAX - 1)}…` : out;
}
function scalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return scrub(value);
  return undefined;
}

/** Whitelists keys, keeps scalars and short scalar arrays, truncates strings, strips secret-looking values. */
export function redactAuditDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!detail || typeof detail !== "object") return out;
  const secretSubject = typeof detail.key === "string" && isSecretName(detail.key);
  for (const [name, raw] of Object.entries(detail)) {
    if (!AUDIT_DETAIL_KEYS.has(name)) continue;
    if ((name === "old" || name === "new") && secretSubject) { out[name] = "[redacted]"; continue; }
    if (Array.isArray(raw)) {
      const items = raw.slice(0, 20).map(scalar).filter(item => item !== undefined);
      out[name] = items;
      continue;
    }
    const value = scalar(raw);
    if (value !== undefined) out[name] = value;
  }
  let json = JSON.stringify(out);
  while (json.length > AUDIT_DETAIL_MAX_BYTES) { delete out[Object.keys(out).at(-1)!]; json = JSON.stringify(out); }
  return out;
}

const handles = new Map<string, { db: ShimmedDatabase; inserts: number }>();
function open(path: string) {
  const known = handles.get(path);
  if (known) return known;
  if (path !== ":memory:") ensureDatabaseDirectory(path);
  const db = createShimmedDatabase(path);
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, outcome TEXT NOT NULL, detail_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_events_ts ON audit_events(ts);
    CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;`);
  const entry = { db, inserts: 0 };
  handles.set(path, entry);
  return entry;
}
const resolvePath = (target?: AuditTarget) => target?.dbPath === ":memory:" ? ":memory:" : resolveOsecDbPath(target?.dbPath);

/** Releases cached connections (database reset, tests). */
export function closeAuditLog(dbPath?: string): void {
  const paths = dbPath === undefined ? [...handles.keys()] : [dbPath === ":memory:" ? ":memory:" : resolveOsecDbPath(dbPath)];
  for (const path of paths) { try { handles.get(path)?.db.close(); } catch { /* already closed */ } handles.delete(path); }
}

/** Appends one audit event. Never throws: auditing must not break the action it records. */
export function recordAudit(input: AuditInput, target?: AuditTarget): void {
  try {
    const entry = open(resolvePath(target));
    const maxRows = Math.max(1, target?.maxRows ?? AUDIT_MAX_ROWS);
    const outcome: AuditOutcome = input.outcome === "denied" || input.outcome === "error" ? input.outcome : "ok";
    entry.db.prepare("INSERT INTO audit_events (ts, actor, action, subject, outcome, detail_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.ts ?? new Date().toISOString(), scrub(String(input.actor ?? "system")), scrub(String(input.action ?? "unknown")), scrub(String(input.subject ?? "")), outcome, JSON.stringify(redactAuditDetail(input.detail)));
    entry.inserts += 1;
    if (entry.inserts % Math.min(100, maxRows) === 0) entry.db.prepare("DELETE FROM audit_events WHERE id <= (SELECT MAX(id) FROM audit_events) - ?").run(maxRows);
  } catch { /* never surface */ }
}

export interface AuditQuery { limit?: number; before?: number; q?: string }
export interface AuditPage { events: AuditEvent[]; nextBefore: number | null }

/** Newest first. `before` is an exclusive id cursor; `q` matches action, subject or actor. */
export function listAudit(query: AuditQuery = {}, target?: AuditTarget): AuditPage {
  try {
    const { db } = open(resolvePath(target));
    const limit = Math.min(500, Math.max(1, Math.trunc(query.limit ?? 100) || 100));
    const where: string[] = []; const args: unknown[] = [];
    if (typeof query.before === "number" && Number.isFinite(query.before)) { where.push("id < ?"); args.push(query.before); }
    const q = query.q?.trim().slice(0, 100);
    if (q) { const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`; where.push("(action LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\')"); args.push(like, like, like); }
    const rows = db.prepare(`SELECT id, ts, actor, action, subject, outcome, detail_json FROM audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit).map((row): AuditEvent => {
      let detail: Record<string, unknown> = {};
      try { detail = JSON.parse(String(row.detail_json)) as Record<string, unknown>; } catch { /* keep empty */ }
      return { id: Number(row.id), ts: String(row.ts), actor: String(row.actor), action: String(row.action), subject: String(row.subject), outcome: row.outcome as AuditOutcome, detail };
    });
    return { events: page, nextBefore: rows.length > limit ? page.at(-1)!.id : null };
  } catch { return { events: [], nextBefore: null }; }
}

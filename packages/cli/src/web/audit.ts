import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { closeAuditLog, listAudit, recordAudit, resolveOsecDbPath, type AuditInput } from "@0/engine/storage";
import { getSettings } from "../state/settings-store.js";

/**
 * Local append-only audit log of privileged actions. Nothing is written until the dashboard calls
 * configureAudit(dbPath), so tests and tools that reach handlers never touch the operator's real database.
 * Details carry key names and non-secret old/new values only; recordAudit whitelists and redacts again.
 */
let auditDbPath: string | undefined;
/** `undefined` selects the default control database, `null` turns auditing off. */
export function configureAudit(dbPath?: string | null): void { auditDbPath = dbPath === null ? undefined : resolveOsecDbPath(dbPath); }
export function audit(event: AuditInput): void { if (auditDbPath) recordAudit(event, { dbPath: auditDbPath }); }

export interface AuditCaller { engineRequest: boolean; teamEnabled?: boolean; displayName?: string; userId?: string }
export function auditActor(caller: AuditCaller): string {
  if (caller.engineRequest) return "engine";
  return caller.teamEnabled && caller.displayName ? `operator ${caller.displayName} (browser)` : "operator (browser)";
}

const body = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex").slice(0, 16);
const seg = (path: string, index: number): string => decodeURIComponent(path.split("/")[index] ?? "");
const names = (value: unknown): string[] => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).slice(0, 20) : [];

export interface AuditDescriptor { action: string; subject: string; detail?: Record<string, unknown> }

/** Maps a /api/console route to an audit entry, or null for routes that are not security relevant. `path` has no /api/console/ prefix. */
export function describeConsoleAudit(path: string, method: string, input: unknown): AuditDescriptor | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  const b = body(input);
  let m: RegExpExecArray | null;
  if ((m = /^sessions\/([^/]+)\/decisions\/([^/]+)$/.exec(path)) && method === "POST") return { action: b.approve === true ? "decision.approved" : "decision.denied", subject: `session ${decodeURIComponent(m[1]!)}`, detail: { sessionId: decodeURIComponent(m[1]!), decisionId: decodeURIComponent(m[2]!), approved: b.approve === true } };
  if (path === "github/webhook/secret" && method === "POST") return { action: "github.webhook.secret.create", subject: "github webhook" };
  if (path === "github/webhook/secret/rotate" && method === "POST") return { action: "github.webhook.secret.rotate", subject: "github webhook" };
  if (path === "skills/catalog/install" && method === "POST") return { action: "skill.install", subject: String(b.id ?? `${b.repo ?? "github"}/${b.path ?? ""}`), detail: { source: typeof b.id === "string" ? "catalog" : "github", id: b.id, repo: b.repo, path: b.path, version: typeof b.sha === "string" ? b.sha.slice(0, 12) : undefined } };
  if (path === "skills/catalog/remove" && method === "POST") return { action: "skill.remove", subject: String(b.name ?? "skill"), detail: { name: b.name } };
  if ((m = /^extensions\/connectors\/([a-z0-9._-]+)\/(connect|sign-in|cancel|disconnect)$/.exec(path)) && method === "POST") return { action: `extension.connector.${m[2]!.replace("-", ".")}`, subject: m[1]!, detail: { name: m[1] } };
  if ((m = /^extensions\/(preview|install|update\/preview|update|enable|disable|remove)$/.exec(path)) && method === "POST") {
    const action = { preview: "review", install: "install", "update/preview": "update.review", update: "update", enable: "enable", disable: "disable", remove: "remove" }[m[1]!]!;
    const revision = typeof b.approvedRevision === "string" ? b.approvedRevision.slice(0, 12) : undefined;
    return { action: `extension.${action}`, subject: String(b.name ?? b.source ?? "extension").slice(0, 200), detail: { name: b.name, source: typeof b.source === "string" ? b.source.slice(0, 200) : undefined, version: revision, approved: b.approve === true || b.confirm === true ? true : undefined } };
  }
  if (path === "connections" && method === "POST") {
    if (b.action === "disconnect" || b.action === "activate") return { action: b.action === "disconnect" ? "connection.remove" : "connection.update", subject: [b.providerId, b.accountId].filter(value => typeof value === "string" && value).join("/") || "connection", detail: { kind: b.providerId } };
    return { action: "connection.add", subject: String(b.providerId ?? b.provider ?? "connection"), detail: { kind: b.providerId ?? b.provider } };
  }
  if (path === "checks" && method === "POST") { const change = body(b.mutation); return { action: `checks.${typeof change.action === "string" ? change.action : "change"}`, subject: String(change.name ?? change.id ?? "review check"), detail: { id: change.id, name: change.name, path: b.path } }; }
  if ((m = /^connections\/([^/]+)(?:\/([^/]+))?$/.exec(path)) && m[1] !== "order" && m[1] !== "spread") {
    const subject = decodeURIComponent(m[2] ? `${m[1]}/${m[2]}` : m[1]!);
    if (method === "DELETE") return { action: "connection.remove", subject };
    if (method === "PATCH" && "label" in b) return { action: "connection.rename", subject };
    return { action: "connection.update", subject };
  }
  if (/^providers\/[^/]+\/device-auth$/.test(path)) return { action: method === "DELETE" ? "connection.auth.cancel" : "connection.auth.start", subject: seg(path, 1) };
  if (path === "settings" && method === "PATCH") {
    const key = String(b.key ?? ""); let old: unknown;
    try { old = (getSettings() as unknown as Record<string, unknown>)[key]; } catch { /* old value unknown */ }
    if (old !== undefined && JSON.stringify(old) === JSON.stringify(b.value)) return null; // a no-op write is not a change
    return { action: "settings.change", subject: key, detail: { key, old, new: b.value, scope: b.scope } };
  }
  if (path === "settings/reset" && method === "POST") {
    const keys = Array.isArray(b.keys) ? b.keys.filter((key): key is string => typeof key === "string") : typeof b.key === "string" ? [b.key] : [];
    return { action: "settings.reset", subject: keys.length === 1 ? keys[0]! : keys.length ? `${keys.length} settings` : "all settings", detail: { key: keys.length === 1 ? keys[0] : undefined, keys } };
  }
  if (path.startsWith("instructions/")) return { action: "instructions.edit", subject: decodeURIComponent(path.slice("instructions/".length)), detail: { key: decodeURIComponent(path.slice("instructions/".length)) } };
  if (path === "project/choose-directory" && method === "POST") return { action: "project.folder.choose", subject: "native folder chooser" };
  if (path === "project/open-privacy-settings" && method === "POST") return { action: "project.privacy-settings.open", subject: "macOS Privacy & Security settings", detail: { pane: typeof b.pane === "string" ? b.pane : "files" } };
  if (path === "github/connect") return { action: "github.connect", subject: "github" };
  if (path === "github/device-auth") return { action: method === "DELETE" ? "github.auth.cancel" : "github.auth.start", subject: "github", ...(method === "POST" && b.mode === "refresh" ? { detail: { mode: "refresh" } } : {}) };
  if ((m = /^self-edit\/(start|stop|gates|apply)$/.exec(path))) return { action: `self-edit.${m[1] === "gates" ? "gate" : m[1]}`, subject: "self-edit preview", detail: { count: b.discard === true ? 1 : undefined } };
  if (path === "workflow-definitions" && method === "POST") return { action: "automation.create", subject: String(b.name ?? "automation") };
  if ((m = /^workflow-definitions\/([^/]+)(?:\/(run|rollback))?$/.exec(path))) {
    const id = decodeURIComponent(m[1]!);
    if (m[2]) return method === "POST" ? { action: `automation.${m[2]}`, subject: id, detail: { id } } : null;
    return method === "DELETE" ? { action: "automation.delete", subject: id, detail: { id } } : null;
  }
  if (path === "sentinels" && method === "POST") return { action: "sentinel.create", subject: String(b.name ?? "sentinel") };
  if ((m = /^sentinels\/([^/]+)(?:\/(.*))?$/.exec(path))) {
    const id = decodeURIComponent(m[1]!); const rest = m[2];
    const detail = { sentinelId: id };
    if (rest === undefined) return method === "DELETE" ? { action: "sentinel.delete", subject: id, detail } : method === "PATCH" ? { action: "sentinel.update", subject: id, detail: typeof b.status === "string" ? { ...detail, status: b.status } : detail } : null;
    if (rest === "pause" || rest === "resume") return { action: `sentinel.${rest}`, subject: id, detail: { ...detail, approved: rest === "resume" ? b.acknowledge === true : undefined } };
    if (rest === "run" || rest === "acknowledge") return { action: `sentinel.${rest}`, subject: id, detail };
    if (rest.startsWith("files/") && (method === "PUT" || method === "DELETE")) return { action: method === "PUT" ? "sentinel.file.edit" : "sentinel.file.delete", subject: id, detail: { ...detail, path: decodeURIComponent(rest.slice("files/".length)) } };
    if (rest.startsWith("triggers")) return { action: method === "POST" ? "sentinel.trigger.create" : method === "DELETE" ? "sentinel.trigger.delete" : typeof b.enabled === "boolean" ? (b.enabled ? "sentinel.trigger.enable" : "sentinel.trigger.disable") : "sentinel.trigger.update", subject: id, detail: { ...detail, triggerId: rest.split("/")[1] } };
    return null;
  }
  return null;
}

const OPERATOR_FAILURE: Record<number, "denied"> = { 401: "denied", 403: "denied" };
/** Registers the audit write for a console request; recorded once the response is finished so the real status decides the outcome. */
export function auditConsoleRequest(res: ServerResponse, path: string, method: string, input: unknown, caller: AuditCaller): void {
  const descriptor = describeConsoleAudit(path, method, input);
  if (!descriptor) return;
  res.once("finish", () => {
    const status = res.statusCode;
    if (status >= 400 && status !== 403 && status !== 401) return; // failed validation, not a security event
    audit({ actor: auditActor(caller), action: descriptor.action, subject: descriptor.subject, outcome: status < 400 ? "ok" : OPERATOR_FAILURE[status] ?? "error", detail: { ...descriptor.detail, status } });
  });
}

/** 403 browser_only / owner_required denials: caller kind and route only, never a body. */
export function auditDenial(req: Pick<IncomingMessage, "method">, pathname: string, code: string, callerKind: "engine" | "browser"): void {
  audit({ actor: callerKind === "engine" ? "engine" : "operator (browser)", action: `access.${code}`, subject: pathname, outcome: "denied", detail: { callerKind, route: pathname, method: req.method ?? "GET", code, status: 403 } });
}

export function handleAuditLogRequest(path: string, method: string, query: URLSearchParams, caller: { teamEnabled: boolean; role?: string }): { status: number; data: unknown } | null {
  if (path !== "audit-log") return null;
  if (method !== "GET") return { status: 405, data: { error: "Use GET." } };
  if (caller.teamEnabled && caller.role !== "owner") return { status: 403, data: { code: "owner_required", error: "Only workspace owners can read the audit log." } };
  if (!auditDbPath) return { status: 200, data: { events: [], nextBefore: null } };
  const limit = Number(query.get("limit")); const before = Number(query.get("before"));
  return { status: 200, data: listAudit({ ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}), ...(Number.isFinite(before) && before > 0 ? { before } : {}), q: query.get("q") ?? "" }, { dbPath: auditDbPath }) };
}

/** The reset replaced the database file: drop the stale handle, then log the reset as the first event of the fresh log. */
export function auditDatabaseReset(seed: string, caller: AuditCaller): void {
  if (!auditDbPath) return;
  closeAuditLog(auditDbPath);
  audit({ actor: auditActor(caller), action: "database.reset", subject: "local database", detail: { seed } });
}

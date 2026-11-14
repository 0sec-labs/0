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

export interface AuditCaller { engineRequest: boolean; teamEnabled?: boolean; displayName?: string }
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
  if (path === "mcp-servers" && method === "POST") {
    const config = body(b.config);
    return { action: "mcp.create", subject: String(config.name ?? "custom MCP server"), detail: { name: config.name, transport: config.transport, fingerprint: hash({ c: config.command, a: config.args, u: config.url, cwd: config.cwd }), envKeys: names(config.env), headerKeys: names(config.headers), enabled: b.enable === true } };
  }
  if ((m = /^mcp-servers\/([^/]+)(\/test)?$/.exec(path)) && m[1] !== "preview") {
    const id = decodeURIComponent(m[1]!);
    if (m[2]) return { action: "mcp.test", subject: id };
    if (method === "DELETE") return { action: "mcp.delete", subject: id };
    const config = body(b.config);
    const action = typeof b.approvedFingerprint === "string" ? "mcp.approve" : b.enabled === true ? "mcp.enable" : b.enabled === false ? "mcp.disable" : "mcp.update";
    return { action, subject: id, detail: { enabled: typeof b.enabled === "boolean" ? b.enabled : undefined, envKeys: b.config ? names(config.env) : undefined, fingerprint: b.config ? hash({ c: config.command, a: config.args, u: config.url, cwd: config.cwd }) : undefined } };
  }
  if (path === "plugins/install-github") return { action: "plugin.github.review", subject: String(b.repo ?? b.url ?? "github plugin"), detail: { repo: b.repo ?? b.url } };
  if (path === "plugins/install-github/approve") return { action: "plugin.github.approve", subject: "github plugin" };
  if ((m = /^plugins\/(install|enable|disable|run)$/.exec(path))) return { action: `plugin.${m[1]}`, subject: String(b.id ?? b.name ?? b.plugin ?? "plugin") };
  if ((m = /^service-plugins\/([a-z0-9-]+)(\/connect)?$/.exec(path))) return { action: m[2] ? "plugin.service.connect" : method === "DELETE" ? "plugin.service.remove" : "plugin.service.update", subject: m[1]! };
  if (path === "connections" && method === "POST") return { action: "connection.add", subject: String(b.providerId ?? b.provider ?? "connection"), detail: { kind: b.providerId ?? b.provider } };
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
    return { action: "settings.change", subject: key, detail: { key, old, new: b.value, scope: b.scope } };
  }
  if (path === "settings/reset" && method === "POST") return { action: "settings.reset", subject: String(b.key ?? "all settings"), detail: { key: b.key } };
  if (path.startsWith("instructions/")) return { action: "instructions.edit", subject: decodeURIComponent(path.slice("instructions/".length)), detail: { key: decodeURIComponent(path.slice("instructions/".length)) } };
  if (path === "github/connect") return { action: "github.connect", subject: "github" };
  if (path === "github/device-auth") return { action: method === "DELETE" ? "github.auth.cancel" : "github.auth.start", subject: "github" };
  if ((m = /^self-edit\/(start|stop|gates|apply)$/.exec(path))) return { action: `self-edit.${m[1] === "gates" ? "gate" : m[1]}`, subject: "self-edit preview", detail: { count: b.discard === true ? 1 : undefined } };
  if (path === "sentinels" && method === "POST") return { action: "sentinel.create", subject: String(b.name ?? "sentinel") };
  if ((m = /^sentinels\/([^/]+)(?:\/(.*))?$/.exec(path))) {
    const id = decodeURIComponent(m[1]!); const rest = m[2];
    const detail = { sentinelId: id };
    if (rest === undefined) return method === "DELETE" ? { action: "sentinel.delete", subject: id, detail } : method === "PATCH" ? { action: "sentinel.update", subject: id, detail } : null;
    if (rest === "pause" || rest === "resume") return { action: `sentinel.${rest}`, subject: id, detail: { ...detail, approved: rest === "resume" ? b.acknowledge === true : undefined } };
    if (rest === "run" || rest === "acknowledge") return { action: `sentinel.${rest}`, subject: id, detail };
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

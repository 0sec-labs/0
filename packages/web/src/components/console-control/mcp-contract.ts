import { safeLogo, type McpServerPayload, type McpToolInfo } from "./mcp-model";

/** Pure client for the MCP server, GitHub plugin and connection routes (contract: /api/console/mcp-servers, plugins/install-github, connections/*). Every call takes an injected fetch so it is testable without a DOM. */
export type FetchJson = <T>(path: string, init?: RequestInit) => Promise<T>;
const asString = (value: unknown) => typeof value === "string" && value !== "" ? value : undefined;
const asNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown) => list(value).filter((entry): entry is string => typeof entry === "string");

/** The host answered "no such route": an older build, not an application failure. */
export const isUnsupported = (error: unknown) => error instanceof Error && /^(404\b|not found|unknown route|no such route)/i.test(error.message.trim());

export type McpStatus = "untested" | "ok" | "error" | "disabled";
export interface McpServerEntry {
  id: string; name: string; transport: "stdio" | "http" | "sse"; status: McpStatus; statusMessage?: string; enabled: boolean;
  command?: string; args: string[]; cwd?: string; envKeys: string[]; url?: string; headerNames: string[];
  toolCount: number; resourceCount: number; skillCount: number; version?: string; logo?: string;
  tools: McpToolInfo[]; fingerprint?: string; approved: boolean; testedAt?: string;
}
const tools = (raw: unknown): McpToolInfo[] => list(raw).flatMap(entry => { const item = asRecord(entry); const name = asString(item.name); return name ? [{ name, description: asString(item.description) ?? "" }] : []; });

export function normalizeMcpServer(raw: unknown): McpServerEntry | null {
  const item = asRecord(raw); const id = asString(item.id); const name = asString(item.name);
  if (!id || !name) return null;
  const status = item.status === "ok" || item.status === "error" || item.status === "disabled" ? item.status : "untested";
  const transport = item.transport === "http" || item.transport === "sse" ? item.transport : "stdio";
  const parsedTools = tools(item.tools);
  return { id, name, transport, status, statusMessage: asString(item.statusMessage), enabled: item.enabled === true, command: asString(item.command), args: strings(item.args), cwd: asString(item.cwd), envKeys: strings(item.envKeys), url: asString(item.url), headerNames: strings(item.headerNames),
    toolCount: asNumber(item.toolCount) ?? parsedTools.length, resourceCount: asNumber(item.resourceCount) ?? 0, skillCount: asNumber(item.skillCount) ?? 0, version: asString(item.version), logo: safeLogo(item.logo), tools: parsedTools, fingerprint: asString(item.fingerprint), approved: item.approved === true, testedAt: asString(item.testedAt) };
}
export const normalizeMcpServers = (raw: unknown): McpServerEntry[] => list(asRecord(raw).items).flatMap(entry => { const item = normalizeMcpServer(entry); return item ? [item] : []; });

export interface McpApproval { fingerprint: string; action: string; transport: string; warnings: string[]; summary: { command?: string; args: string[]; cwd?: string; envKeys: string[]; url?: string; headerNames: string[] } }
export function normalizeApproval(raw: unknown): McpApproval {
  const item = asRecord(asRecord(raw).approval); const summary = asRecord(item.summary); const fingerprint = asString(item.fingerprint);
  if (!fingerprint) throw new Error("The host did not return a reviewable approval.");
  return { fingerprint, action: asString(item.action) ?? "create", transport: asString(item.transport) ?? "stdio", warnings: strings(item.warnings), summary: { command: asString(summary.command), args: strings(summary.args), cwd: asString(summary.cwd), envKeys: strings(summary.envKeys), url: asString(summary.url), headerNames: strings(summary.headerNames) } };
}

export interface McpTestResult { toolCount: number; resourceCount: number; serverVersion?: string; tools: McpToolInfo[]; durationMs?: number }
export const normalizeTest = (raw: unknown): McpTestResult => { const item = asRecord(raw); const parsed = tools(item.tools); return { toolCount: asNumber(item.toolCount) ?? parsed.length, resourceCount: asNumber(item.resourceCount) ?? list(item.resources).length, serverVersion: asString(item.serverVersion), tools: parsed, durationMs: asNumber(item.durationMs) }; };

export interface GithubReview { reviewId: string; repo: string; ref: string; sha: string; id: string; name: string; version?: string; capabilities: string[]; tools: (McpToolInfo & { capabilities: string[] })[]; permissionHash: string; entryBytes?: number; alreadyInstalled: boolean; expiresAt?: string }
export function normalizeReview(raw: unknown): GithubReview {
  const item = asRecord(asRecord(raw).review); const reviewId = asString(item.reviewId); const sha = asString(item.sha); const permissionHash = asString(item.permissionHash);
  if (!reviewId || !sha || !permissionHash) throw new Error("The host did not return a reviewable commit and permission set.");
  return { reviewId, sha, permissionHash, repo: asString(item.repo) ?? "", ref: asString(item.ref) ?? "HEAD", id: asString(item.id) ?? "", name: asString(item.name) ?? asString(item.id) ?? asString(item.repo) ?? "Plugin", version: asString(item.version), capabilities: strings(item.capabilities),
    tools: list(item.tools).flatMap(entry => { const tool = asRecord(entry); const name = asString(tool.name); return name ? [{ name, description: asString(tool.description) ?? "", capabilities: strings(tool.capabilities) }] : []; }), entryBytes: asNumber(item.entryBytes), alreadyInstalled: item.alreadyInstalled === true, expiresAt: asString(item.expiresAt) };
}

const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
const enc = encodeURIComponent;
const MCP = "/api/console/mcp-servers";

export const mcpClient = (fetchJson: FetchJson) => ({
  list: async (signal?: AbortSignal) => normalizeMcpServers(await fetchJson(MCP, { signal })),
  preview: async (config: McpServerPayload) => normalizeApproval(await fetchJson(`${MCP}/preview`, send("POST", { config }))),
  create: async (config: McpServerPayload, approvedFingerprint: string, enable: boolean) => normalizeMcpServer(asRecord(await fetchJson(`${MCP}`, send("POST", { config, approvedFingerprint, enable }))).item),
  update: (id: string, patch: { enabled?: boolean; approvedFingerprint?: string; config?: Partial<McpServerPayload> }) => fetchJson<unknown>(`${MCP}/${enc(id)}`, send("PATCH", patch)),
  remove: (id: string) => fetchJson<unknown>(`${MCP}/${enc(id)}`, { method: "DELETE" }),
  test: async (id: string) => normalizeTest(await fetchJson(`${MCP}/${enc(id)}/test`, send("POST", {}))),
  githubReview: async (input: { repo: string; ref?: string }) => normalizeReview(await fetchJson("/api/console/plugins/install-github", send("POST", input.ref && input.ref !== "HEAD" ? input : { repo: input.repo }))),
  githubApprove: (input: { reviewId: string; sha: string; permissionHash: string; replaceExisting?: boolean }) => fetchJson<{ ok?: boolean; id?: string; message?: string }>("/api/console/plugins/install-github/approve", send("POST", { ...input, approved: true })),
});

export interface ConnectionUsage { available?: boolean; window?: unknown }
export interface ConnectionEntry { id: string; providerId: string; accountId: string; kind: string; label: string; defaultLabel: string; active: boolean; order: number; disabledModels: string[]; usage: ConnectionUsage | null }
/** `GET connections/:id/usage` -> `{ usage }`. Only OpenRouter reports real numbers; everything else says why not. Never invent values. */
export interface ConnectionUsageResult { available: boolean; window: unknown; reason: string | null }
export function normalizeConnectionUsage(raw: unknown): ConnectionUsageResult {
  const usage = asRecord(asRecord(raw).usage);
  const available = usage.available === true && Object.keys(asRecord(usage.window)).length > 0;
  return { available, window: available ? usage.window : null, reason: available ? null : asString(usage.reason) ?? "not_exposed" };
}
const USAGE_NOTES: Record<string, string> = {
  not_exposed: "Usage isn't available for this provider.",
  no_saved_key: "Save a key for this connection to see usage.",
  credentials_rejected: "The provider rejected this key, so usage can't be shown.",
  provider_error: "The provider didn't return usage right now.",
  provider_unreachable: "Couldn't reach the provider to check usage.",
};
/** Muted one-liner for an unavailable usage result. */
export const usageUnavailableNote = (reason: string | null | undefined): string => USAGE_NOTES[reason ?? "not_exposed"] ?? USAGE_NOTES.not_exposed!;

export interface ConnectionsState { connections: ConnectionEntry[]; spread: Record<string, boolean> }
export function normalizeConnections(raw: unknown): ConnectionsState {
  const root = asRecord(raw);
  const connections = list(root.connections).flatMap((entry): ConnectionEntry[] => {
    const item = asRecord(entry); const id = asString(item.id); const providerId = asString(item.providerId); const accountId = asString(item.accountId);
    if (!id || !providerId || !accountId) return [];
    const usage = asRecord(item.usage);
    return [{ id, providerId, accountId, kind: asString(item.kind) ?? "api_key", label: asString(item.label) ?? asString(item.defaultLabel) ?? accountId, defaultLabel: asString(item.defaultLabel) ?? accountId, active: item.active === true, order: asNumber(item.order) ?? 0, disabledModels: strings(item.disabledModels), usage: Object.keys(usage).length ? { available: usage.available === true, window: usage.window } : null }];
  });
  const spread = Object.fromEntries(Object.entries(asRecord(root.spread)).map(([key, value]) => [key, value === true]));
  return { connections, spread };
}
export const connectionsClient = (fetchJson: FetchJson) => ({
  list: async (signal?: AbortSignal) => normalizeConnections(await fetchJson("/api/console/connections", { signal })),
  rename: async (id: string, label: string | null) => normalizeConnections(await fetchJson(`/api/console/connections/${enc(id)}`, send("PATCH", { label }))),
  reorder: async (providerId: string, accountIds: string[]) => normalizeConnections(await fetchJson("/api/console/connections/order", send("PUT", { providerId, accountIds }))),
  spread: async (providerId: string, enabled: boolean) => normalizeConnections(await fetchJson("/api/console/connections/spread", send("PUT", { providerId, enabled }))),
  usage: async (id: string, signal?: AbortSignal) => normalizeConnectionUsage(await fetchJson(`/api/console/connections/${enc(id)}/usage`, { signal })),
  setDisabledModels: (id: string, disabled: string[]) => fetchJson<unknown>(`/api/console/connections/${enc(id)}/models`, send("PUT", { disabled })),
});

/**
 * /api/console/extensions/connectors/*: one Connect surface for every connector extension (built-in or installed).
 *
 *   GET  extensions/connectors                          each connector's contract (read/write list, methods) and live status
 *   POST extensions/connectors/<name>/connect           { token }   token method
 *   POST extensions/connectors/<name>/sign-in           {}          oauth-device method
 *   POST extensions/connectors/<name>/cancel | disconnect
 *
 * The contract and the secret store live in the engine; a service with its own sign-in (GitHub) is supplied as an
 * adapter. Mutations are browser-only and owner-only through the existing `extensions/*` privilege rule.
 */
import { defaultAdapter, listConnectors, type ConnectorAuthPort, type ConnectorEntry, type ConnectorStatus, type ExtensionService } from "@0/engine";
import { z } from "zod";

export interface ConnectorReply { status: number; data: unknown }
const NONE: ConnectorStatus = { state: "unavailable", account: null, detail: "No way to connect this service is available on this computer.", health: "unknown" };
const token = z.object({ token: z.string().min(1).max(16_384) }).strict();
const fail = (status: number, error: string): ConnectorReply => ({ status, data: { error } });

export async function handleConnectorRequest(svc: ExtensionService, hosted: Readonly<Record<string, ConnectorAuthPort>>, path: string, method: string, input: unknown): Promise<ConnectorReply | null> {
  if (!/^extensions\/connectors(?:\/|$)/.test(path)) return null;
  const entries = listConnectors(svc.store, null);
  const adapterFor = (e: ConnectorEntry): ConnectorAuthPort | null => hosted[e.extension] ?? defaultAdapter(e, svc.secrets);
  if (path === "extensions/connectors" && method === "GET") {
    const rows = await Promise.all(entries.map(async e => ({ extension: e.extension, builtin: e.builtin, enabled: e.enabled, connector: e.connector, status: e.enabled ? await (adapterFor(e)?.status() ?? Promise.resolve(NONE)) : { ...NONE, state: "unavailable" as const, detail: "Turned off." } })));
    return { status: 200, data: { connectors: rows } };
  }
  const m = /^extensions\/connectors\/([a-z0-9._-]+)\/(connect|sign-in|cancel|disconnect)$/.exec(path);
  if (!m || method !== "POST") return fail(404, "Route not found.");
  const entry = entries.find(e => e.extension === m[1]);
  if (!entry) return fail(404, "That connector is not installed, approved and enabled.");
  if (!entry.enabled) return fail(409, "Turn this extension on first.");
  const adapter = adapterFor(entry); const action = m[2]!;
  const method_ = { connect: "token", "sign-in": "oauth-device", cancel: "oauth-device", disconnect: "token" }[action]!;
  if (!adapter) return fail(400, "This connector cannot be connected here.");
  if (action !== "cancel" && action !== "disconnect" && !entry.connector.methods.includes(method_ as never)) return fail(400, `This connector does not use ${method_}.`);
  try {
    if (action === "connect") {
      const body = token.safeParse(input ?? {}); if (!body.success || !adapter.connectToken) return fail(400, "Enter a token.");
      return { status: 200, data: { status: await adapter.connectToken(body.data.token) } };
    }
    if (action === "sign-in") return adapter.signIn ? { status: 202, data: { status: await adapter.signIn() } } : fail(400, "This connector has no browser sign-in.");
    if (action === "cancel") return { status: 200, data: { status: await (adapter.cancel?.() ?? adapter.status()) } };
    return { status: 200, data: { status: await (adapter.disconnect?.() ?? adapter.status()) } };
  } catch (cause) {
    const status = typeof (cause as { status?: unknown }).status === "number" ? (cause as { status: number }).status : 500;
    return fail(status, cause instanceof Error ? cause.message : "The connection failed.");
  }
}

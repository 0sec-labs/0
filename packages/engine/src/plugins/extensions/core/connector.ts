/**
 * The connector contract: what an extension declares when it connects 0 to a service (`0.connector` in the manifest).
 * Pure data and pure functions. Signing in, storing a secret and probing the service are adapters behind the ports in
 * `../ports.ts`; nothing here does I/O.
 *
 * A connector declares: how the operator connects (`auth`, `methods`), the variable its secret fills (`env`), what it
 * may read and write (`access`), where it may connect (`hosts`), how to tell the connection works (`health`) and how
 * the Connections page shows it (`display`: one Connect button).
 */
import { z } from "zod";
import { isSafeExtensionEnvName } from "./env.js";

/** `cli-login`: a program already signed in on this computer (gh). `oauth-device`: a one-time code entered in the browser. */
export const CONNECTOR_AUTHS = ["token", "oauth-device", "cli-login", "none"] as const;
export type ConnectorAuth = (typeof CONNECTOR_AUTHS)[number];
/** `adapter`: ask the auth adapter (for example `gh auth status`). `http`: GET an https url on a declared host with the secret as a bearer token. */
export type ConnectorHealth = { type: "none" } | { type: "adapter" } | { type: "http"; url: string };

export interface ConnectorDecl {
  service: string;
  title: string;
  description: string;
  category: string;
  /** The default way to connect; `methods` lists every way (first is preselected). */
  auth: ConnectorAuth;
  methods: ConnectorAuth[];
  /** Variable names the connection fills for this extension's scripts. A script receives one only if it is declared here AND approved. */
  env: string[];
  hosts: string[];
  read: string[];
  write: string[];
  health: ConnectorHealth;
  connectLabel: string;
  /** Optional UI surface folder or file inside the extension. */
  surface: string | null;
}

const text = z.string().min(1).max(512).refine(s => !s.includes("\0"));
const list = <T extends z.ZodType>(item: T, max = 64) => z.array(item).max(max).default([]);
const host = z.string().regex(/^[a-z0-9*]([a-z0-9.*-]*[a-z0-9])?$/i);

/** `cli` was the first spelling of `cli-login`; both are accepted. */
const auth = z.enum(["token", "oauth-device", "cli-login", "cli", "none"]).transform((a): ConnectorAuth => (a === "cli" ? "cli-login" : a));

export const connectorShape = z.object({
  service: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  title: text.max(60).optional(), description: text.max(200).optional(), category: text.max(40).optional(),
  auth, methods: list(auth, 4),
  env: list(z.string().refine(isSafeExtensionEnvName, "not an allowed variable name: use UPPER_CASE ending in _TOKEN, _KEY, _SECRET, _URL, _ID, _HOST ... (PATH, GIT_*, LD_*, NODE_OPTIONS and other loader variables are never allowed)")),
  hosts: list(host, 32),
  access: z.object({ read: list(text), write: list(text) }).default({ read: [], write: [] }),
  health: z.union([z.object({ type: z.literal("none") }), z.object({ type: z.literal("adapter") }), z.object({ type: z.literal("http"), url: z.string().url().max(512) })]).default({ type: "none" }),
  connectLabel: text.max(30).optional(),
});
export type ConnectorInput = z.output<typeof connectorShape> & { surface?: string | undefined };

/** The host patterns a connector may reach: exact, or `*.example.com` for subdomains. */
export const hostAllowed = (hostname: string, patterns: readonly string[]): boolean =>
  patterns.some(p => { const h = hostname.toLowerCase(); const q = p.toLowerCase(); return q.startsWith("*.") ? h.endsWith(q.slice(1)) && h.length > q.length - 1 : h === q; });

/** Cross-field rules a single field cannot express. Returns a message or null. */
export function connectorProblem(c: ConnectorInput): string | null {
  const methods = c.methods.length ? c.methods : [c.auth];
  if (!methods.includes(c.auth)) return "connector.methods must include connector.auth.";
  if (c.auth === "token" && c.env.length === 0) return "a token connector must declare connector.env: the variable its token fills.";
  if (c.health.type === "http") {
    let url: URL; try { url = new URL(c.health.url); } catch { return "connector.health.url is not a valid URL."; }
    if (url.protocol !== "https:" || url.username || url.password) return "connector.health.url must be https without credentials.";
    if (!hostAllowed(url.hostname, c.hosts)) return `connector.health.url host ${url.hostname} is not in connector.hosts.`;
  }
  return null;
}

export function toConnectorDecl(c: ConnectorInput): ConnectorDecl {
  const methods = c.methods.length ? [...new Set(c.methods)] : [c.auth];
  return {
    service: c.service, title: c.title ?? c.service, description: c.description ?? "", category: c.category ?? "Services", auth: c.auth, methods,
    env: [...new Set(c.env)].sort(), hosts: c.hosts, read: c.access.read, write: c.access.write, health: c.health, connectLabel: c.connectLabel ?? "Connect", surface: c.surface ?? null,
  };
}

/** One plain sentence for the install prompt: where it connects, what it reads, what it writes. */
export function connectorCanDo(c: Pick<ConnectorDecl, "title" | "methods" | "hosts" | "read" | "write">): string {
  return `connects to ${c.title} (${c.methods.join(" / ")}${c.hosts.length ? `; ${c.hosts.join(", ")}` : ""}); reads: ${c.read.join(", ") || "nothing"}; writes: ${c.write.join(", ") || "nothing"}`;
}

export const healthLine = (h: ConnectorHealth): string => (h.type === "http" ? `http ${h.url}` : h.type);

/** What a connection looks like right now, whatever adapter produced it. */
export type ConnectorState = "connected" | "not-connected" | "signing-in" | "needs-attention" | "unavailable";
export interface ConnectorStatus {
  state: ConnectorState;
  /** Who is connected (a login name), never a secret. */
  account: string | null;
  /** One line for the operator: what is missing or what to do next. */
  detail: string;
  health: "ok" | "rejected" | "unreachable" | "unknown";
  /** Present while an `oauth-device` sign-in is waiting for the operator. */
  device?: { userCode: string; verificationUrl: string };
}

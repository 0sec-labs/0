/**
 * Auth adapter for a plain `token` connector: the operator pastes a token, it is checked against the connector's
 * declared health URL (when it declares one), stored in {@link ConnectionSecrets} under the declared variable, and
 * filled into a script's environment only when the extension declared the name and the operator approved it.
 */
import { hostAllowed, type ConnectorDecl, type ConnectorStatus } from "../core/connector.js";
import type { ConnectionSecrets, ConnectorAuthPort } from "../ports.js";

const HEALTH_TIMEOUT_MS = 5_000;
const validToken = (t: string) => t.length > 0 && t.length <= 16_384 && !/\s/.test(t);

export class TokenConnector implements ConnectorAuthPort {
  constructor(private readonly extension: string, private readonly decl: ConnectorDecl, private readonly secrets: ConnectionSecrets, private readonly fetchImpl: typeof fetch = fetch) {}

  /** The variable the connection fills: the first declared name. */
  get slot(): string | undefined { return this.decl.env[0]; }

  async #probe(token: string): Promise<ConnectorStatus["health"]> {
    const h = this.decl.health;
    if (h.type !== "http") return "unknown";
    try {
      const url = new URL(h.url);
      // Re-checked at use: the declared host list is the only place a token can be sent.
      if (url.protocol !== "https:" || !hostAllowed(url.hostname, this.decl.hosts)) return "unknown";
      const r = await this.fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      return r.status === 401 || r.status === 403 ? "rejected" : r.status >= 200 && r.status < 300 ? "ok" : "unknown";
    } catch { return "unreachable"; }
  }

  async status(): Promise<ConnectorStatus> {
    const slot = this.slot; const token = slot ? this.secrets.read(this.extension, slot) : undefined;
    if (!slot) return { state: "unavailable", account: null, detail: "This connector declares no variable for its token.", health: "unknown" };
    if (!token) return { state: "not-connected", account: null, detail: "", health: "unknown" };
    const health = await this.#probe(token);
    return health === "rejected" ? { state: "needs-attention", account: null, detail: `${this.decl.title} did not accept the stored token.`, health } : { state: "connected", account: null, detail: "", health };
  }

  async connectToken(token: string): Promise<ConnectorStatus> {
    const slot = this.slot; const value = token.trim();
    if (!slot) return this.status();
    if (!validToken(value)) return { state: "not-connected", account: null, detail: "Enter a token without spaces.", health: "unknown" };
    if (await this.#probe(value) === "rejected") return { state: "not-connected", account: null, detail: `${this.decl.title} did not accept this token.`, health: "rejected" };
    const saved = this.secrets.write(this.extension, slot, value);
    if (!saved.ok) return { state: "needs-attention", account: null, detail: saved.error.message, health: "unknown" };
    return this.status();
  }

  async disconnect(): Promise<ConnectorStatus> { if (this.slot) this.secrets.remove(this.extension, this.slot); return this.status(); }
}

import type { ConnectorAuthPort, ConnectorStatus } from "@0/engine";
import type { GitHubPublicationAuth } from "./github-auth.js";

/**
 * GitHub's side of the connector contract. The contract names the methods (cli-login, oauth-device, token); this adapter
 * runs them through {@link GitHubPublicationAuth}, which keeps owning `gh`. Nothing here sees a token after it is handed to `gh`.
 */
export class GitHubConnector implements ConnectorAuthPort {
  constructor(private readonly auth: GitHubPublicationAuth) {}

  async status(): Promise<ConnectorStatus> {
    const a = await this.auth.status();
    if (!a.available) return { state: "unavailable", account: null, detail: a.deviceAuth.message || "The GitHub CLI is not installed on this computer.", health: "unknown" };
    const device = a.deviceAuth.userCode && a.deviceAuth.verificationUrl ? { userCode: a.deviceAuth.userCode, verificationUrl: a.deviceAuth.verificationUrl } : undefined;
    if (a.deviceAuth.phase === "running") return { state: "signing-in", account: a.account, detail: a.deviceAuth.message, health: "unknown", ...(device ? { device } : {}) };
    if (!a.connected) return { state: "not-connected", account: null, detail: a.deviceAuth.phase === "idle" || a.deviceAuth.phase === "connected" ? "" : a.deviceAuth.message, health: "unknown" };
    if (a.missingScopes.length) return { state: "needs-attention", account: a.account, detail: `Needs permissions: ${a.missingScopes.join(", ")}`, health: "ok" };
    return { state: "connected", account: a.account, detail: a.source === "environment" ? "via token" : "via GitHub CLI", health: "ok" };
  }
  async signIn(): Promise<ConnectorStatus> { await this.auth.start("login"); return this.status(); }
  async connectToken(token: string): Promise<ConnectorStatus> { await this.auth.connect({ token }); return this.status(); }
  async cancel(): Promise<ConnectorStatus> { await this.auth.cancel(); return this.status(); }
}

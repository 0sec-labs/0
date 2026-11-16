/** Pure model of the Connect surface for connector extensions (the engine's `connector` contract, as the API sends it). */
export type ConnectorAuthDto = "token" | "oauth-device" | "cli-login" | "none";
export interface ConnectorDto {
  service: string; title: string; description: string; category: string;
  auth: ConnectorAuthDto; methods: ConnectorAuthDto[]; env: string[]; hosts: string[]; read: string[]; write: string[];
  health: { type: "none" | "adapter" | "http"; url?: string }; connectLabel: string;
}
export type ConnectorStateDto = "connected" | "not-connected" | "signing-in" | "needs-attention" | "unavailable";
export interface ConnectorStatusDto { state: ConnectorStateDto; account: string | null; detail: string; health: "ok" | "rejected" | "unreachable" | "unknown"; device?: { userCode: string; verificationUrl: string } }
export interface ConnectorRowDto { extension: string; builtin: boolean; enabled: boolean; connector: ConnectorDto; status: ConnectorStatusDto }

/** Who is connected and how, or what is missing. */
export function connectorHeadline(row: Pick<ConnectorRowDto, "connector" | "status">): string {
  const { status, connector } = row; const who = status.account ?? connector.title;
  switch (status.state) {
    case "connected": return `Connected as ${who}${status.detail ? ` ${status.detail}` : ""}`;
    case "needs-attention": return status.detail || "Needs attention";
    case "signing-in": return "Signing in";
    case "unavailable": return status.detail || "Not available on this computer";
    default: return "Not connected";
  }
}

/** `rejected`: the service answered 401/403. `unreachable`: it did not answer. Otherwise nothing worth saying. */
export const healthNote = (status: ConnectorStatusDto): string | null =>
  status.state !== "connected" && status.state !== "needs-attention" ? null : status.health === "rejected" ? "The service rejected this connection." : status.health === "unreachable" ? "The service could not be reached." : null;

/** The ONE Connect button: what it does for this connector. `none` when a click would have nothing to do. */
export type ConnectAction = { kind: "token" | "sign-in" | "none"; label: string };
export function connectAction(row: Pick<ConnectorRowDto, "connector" | "status">): ConnectAction {
  const { connector, status } = row;
  if (status.state === "unavailable" || status.state === "signing-in") return { kind: "none", label: connector.connectLabel };
  if (connector.methods.includes("token")) return { kind: "token", label: status.state === "connected" ? "Replace token" : connector.connectLabel };
  if (connector.methods.includes("oauth-device")) return { kind: "sign-in", label: status.state === "connected" ? "Sign in again" : connector.connectLabel };
  return { kind: "none", label: connector.connectLabel };
}

/** The declared read/write list, in the words the install prompt uses. */
export const accessSummary = (c: Pick<ConnectorDto, "read" | "write">): { reads: string; writes: string } =>
  ({ reads: c.read.join(", ") || "nothing", writes: c.write.join(", ") || "nothing" });

export function deviceLine(device: ConnectorStatusDto["device"]): string | null { return device ? `Enter code ${device.userCode}` : null; }
export const validConnectorToken = (value: string): boolean => { const t = value.trim(); return t.length > 0 && t.length <= 16384 && !/\s/.test(t); };

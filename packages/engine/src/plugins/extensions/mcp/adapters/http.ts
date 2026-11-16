import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConnector, McpLaunch, McpSession } from "../ports.js";
import { connectSdk } from "./sdk-session.js";

/** HTTPS only (plain http on loopback for local servers), no URL credentials, no redirects. */
export function httpEndpoint(raw: string): URL {
  const url = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) throw new Error("MCP HTTP endpoint requires HTTPS (HTTP on loopback only), without URL credentials or a fragment");
  return url;
}

export class HttpMcpConnector implements McpConnector {
  async connect(launch: McpLaunch): Promise<McpSession> {
    if (launch.kind !== "http") throw new Error("not an http launch");
    const url = httpEndpoint(launch.url); const init = { headers: { ...launch.headers }, redirect: "error" as const };
    return connectSdk(launch.transport === "sse" ? new SSEClientTransport(url, { requestInit: init }) : new StreamableHTTPClientTransport(url, { requestInit: init }));
  }
}

/** Routes a launch to the adapter for its kind. */
export class SdkMcpConnector implements McpConnector {
  constructor(private readonly stdio: McpConnector, private readonly http: McpConnector = new HttpMcpConnector()) {}
  connect(launch: McpLaunch): Promise<McpSession> { return (launch.kind === "stdio" ? this.stdio : this.http).connect(launch); }
}

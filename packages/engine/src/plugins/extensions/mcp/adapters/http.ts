import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConnector, McpLaunch, McpSession } from "../ports.js";
import { checkRemoteEndpoint, systemResolver, type Resolver } from "./endpoint.js";
import { connectSdk, type SessionOptions } from "./sdk-session.js";

/** Remote servers. The endpoint is checked (HTTPS, public addresses after DNS) before connecting and again before every request; redirects are refused. */
export class HttpMcpConnector implements McpConnector {
  constructor(private readonly options: SessionOptions & { resolve?: Resolver } = {}) {}
  async connect(launch: McpLaunch): Promise<McpSession> {
    if (launch.kind !== "http") throw new Error("not an http launch");
    const resolve = this.options.resolve ?? systemResolver;
    const url = await checkRemoteEndpoint(launch.url, resolve);
    const guarded: typeof fetch = async (input, init) => { await checkRemoteEndpoint(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, resolve); return fetch(input, init); };
    const init = { headers: { ...launch.headers }, redirect: "error" as const };
    return connectSdk(launch.transport === "sse" ? new SSEClientTransport(url, { requestInit: init, fetch: guarded }) : new StreamableHTTPClientTransport(url, { requestInit: init, fetch: guarded }), this.options);
  }
}

/** Routes a launch to the adapter for its kind. */
export class SdkMcpConnector implements McpConnector {
  constructor(private readonly stdio: McpConnector, private readonly http: McpConnector = new HttpMcpConnector()) {}
  connect(launch: McpLaunch): Promise<McpSession> { return (launch.kind === "stdio" ? this.stdio : this.http).connect(launch); }
}

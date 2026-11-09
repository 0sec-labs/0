import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NativeToolDef } from "./types.js";

/** MCP server name the bridge registers under in Claude Code (`mcp__<name>__<tool>`). */
export const CLAUDE_TOOL_BRIDGE_SERVER = "zero";
export const CLAUDE_TOOL_BRIDGE_PREFIX = `mcp__${CLAUDE_TOOL_BRIDGE_SERVER}__`;

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_KEEPALIVE_MS = 15_000;

export interface ClaudeToolBridgeCall {
  /** Claude Code's `tool_use` id, sent as `_meta["claudecode/toolUseId"]` when available. */
  toolUseId?: string;
  /** Native tool name (without the `mcp__zero__` prefix). */
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolBridgeResult {
  content: string;
  isError?: boolean;
}

/** Return a native tool name for a Claude Code tool name, or undefined when it is not a bridged tool. */
export function nativeToolNameFromClaude(name: string): string | undefined {
  return name.startsWith(CLAUDE_TOOL_BRIDGE_PREFIX) ? name.slice(CLAUDE_TOOL_BRIDGE_PREFIX.length) : undefined;
}

/**
 * Loopback MCP server (Streamable HTTP transport) that advertises the native
 * loop's tool definitions to a `claude -p` subprocess and hands every
 * `tools/call` back to the host instead of executing it.
 *
 * The native agent loop owns tool execution: scope checks, evidence capture
 * and finding state all live in 0, not in Claude Code. The bridge therefore
 * holds each call open until the host supplies the result through the
 * `respond` callback, which keeps Claude Code's conversation intact (its
 * tool_use is answered by the matching tool_result) while 0 decides what the
 * tool actually does.
 *
 * Responses to `tools/call` are sent as an SSE stream with periodic comment
 * keepalives so a long-running tool cannot be cut off by an idle-connection
 * timeout in the HTTP stack. The server binds 127.0.0.1 on an ephemeral port
 * and requires a per-bridge bearer token.
 */
export class ClaudeToolBridge {
  private readonly token = randomBytes(32).toString("hex");
  private readonly open = new Set<() => void>();
  private listener: ((call: ClaudeToolBridgeCall, respond: (result: ClaudeToolBridgeResult) => void) => void) | undefined;
  private closed = false;
  private url = "";

  private constructor(
    private readonly server: Server,
    private readonly tools: NativeToolDef[],
    private readonly keepAliveMs: number,
  ) {}

  static async start(tools: NativeToolDef[], options: { keepAliveMs?: number } = {}): Promise<ClaudeToolBridge> {
    let bridge!: ClaudeToolBridge;
    const server = createServer((req, res) => { void bridge.handle(req, res); });
    bridge = new ClaudeToolBridge(server, tools, options.keepAliveMs ?? DEFAULT_KEEPALIVE_MS);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Claude tool bridge did not bind a TCP port.");
    bridge.url = `http://127.0.0.1:${address.port}/mcp`;
    return bridge;
  }

  /** Value for `claude --mcp-config`. */
  mcpConfig(): string {
    return JSON.stringify({
      mcpServers: {
        [CLAUDE_TOOL_BRIDGE_SERVER]: { type: "http", url: this.url, headers: { Authorization: `Bearer ${this.token}` } },
      },
    });
  }

  /** Register the single handler that receives tool calls. */
  onCall(listener: (call: ClaudeToolBridgeCall, respond: (result: ClaudeToolBridgeResult) => void) => void): void {
    this.listener = listener;
  }

  /** Stop accepting requests and fail any call still waiting for a result. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const fail of [...this.open]) fail();
    this.open.clear();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const expected = Buffer.from(`Bearer ${this.token}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closed) { res.writeHead(503).end(); return; }
    if (!this.authorized(req)) { res.writeHead(401).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }

    let body = "";
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) { res.writeHead(413).end(); return; }
      body += chunk;
    }
    let message: Record<string, any>;
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a single JSON-RPC message");
      message = parsed as Record<string, any>;
    } catch {
      sendJson(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    // Notifications and responses carry no id and need no reply.
    if (message.id === undefined || message.id === null) { res.writeHead(202).end(); return; }
    const id = message.id;
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, any>;

    switch (message.method) {
      case "initialize":
        sendJson(res, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "0-native-tools", version: "1" },
          },
        });
        return;
      case "ping":
        sendJson(res, { jsonrpc: "2.0", id, result: {} });
        return;
      case "tools/list":
        sendJson(res, {
          jsonrpc: "2.0",
          id,
          result: { tools: this.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })) },
        });
        return;
      case "tools/call":
        this.handleCall(id, params, res);
        return;
      default:
        sendJson(res, { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
    }
  }

  private handleCall(id: unknown, params: Record<string, any>, res: ServerResponse): void {
    const name = typeof params.name === "string" ? params.name : "";
    const input = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown>
      : {};
    const meta = params._meta && typeof params._meta === "object" ? params._meta as Record<string, unknown> : {};
    const toolUseId = typeof meta["claudecode/toolUseId"] === "string" ? meta["claudecode/toolUseId"] as string : undefined;
    const response = (result: ClaudeToolBridgeResult) => ({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: result.content }], ...(result.isError ? { isError: true } : {}) },
    });

    if (!this.tools.some(tool => tool.name === name) || !this.listener) {
      sendJson(res, response({ content: `Unknown tool: ${name}`, isError: true }));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let settled = false;
    const keepAlive = setInterval(() => { if (!settled) res.write(": keepalive\n\n"); }, this.keepAliveMs);
    keepAlive.unref?.();
    const finish = (result: ClaudeToolBridgeResult) => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      this.open.delete(fail);
      if (!res.writableEnded && !res.destroyed) res.end(`event: message\ndata: ${JSON.stringify(response(result))}\n\n`);
    };
    const fail = () => finish({ content: "The host closed the tool bridge before this call completed.", isError: true });
    this.open.add(fail);
    // `res` (not `req`) closes when the client goes away; `req` closes as soon
    // as its body has been read.
    res.once("close", () => {
      if (!res.writableEnded) { settled = true; clearInterval(keepAlive); this.open.delete(fail); }
    });
    this.listener({ ...(toolUseId ? { toolUseId } : {}), name, input }, finish);
  }
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/** The MCP SDK client behind `McpSession`. Shared by the stdio and http adapters. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpCallResult, McpSession } from "../ports.js";
import { boundedText } from "../core/response.js";
import type { McpToolInfo } from "../core/tool-hash.js";

type Transport = Parameters<Client["connect"]>[0];
export const CONNECT_TIMEOUT_MS = 15_000;
export const CALL_TIMEOUT_MS = 60_000;
export interface SessionOptions { readonly connectTimeoutMs?: number; readonly callTimeoutMs?: number }

/**
 * The client declares NO capabilities: no sampling, no elicitation, no roots. A server that asks for any of them gets a
 * JSON-RPC "method not found" from the SDK, so a server cannot make the model or the operator do anything on its behalf.
 */
export async function connectSdk(transport: Transport, options: SessionOptions = {}): Promise<McpSession> {
  const connectTimeout = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS; const callTimeout = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const client = new Client({ name: "0", version: "0.1.0" }, { capabilities: {} });
  const changed: Array<() => void> = []; const closed: Array<(reason: string) => void> = [];
  let ended: string | null = null;
  const end = (reason: string) => { if (ended !== null) return; ended = reason; for (const l of closed) l(reason); };
  client.onclose = () => end("the server connection closed (its process exited or the stream ended)");
  client.onerror = () => undefined;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { for (const l of changed) l(); });
  try { await client.connect(transport, { timeout: connectTimeout }); }
  catch (error) { await client.close().catch(() => undefined); throw error; }
  const close = () => client.close().catch(() => undefined);
  return {
    async tools(): Promise<McpToolInfo[]> {
      const out: McpToolInfo[] = []; const seen = new Set<string>(); let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout: connectTimeout });
        for (const t of listed.tools ?? []) {
          if (seen.has(t.name)) throw new Error("server advertised duplicate tool names");
          seen.add(t.name);
          out.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) });
        }
        cursor = listed.nextCursor; if (!cursor) break;
      }
      return out;
    },
    async call(name, args): Promise<McpCallResult> {
      if (ended !== null) throw new Error(`the server is not running: ${ended}`);
      try {
        const res = await client.callTool({ name, arguments: args }, undefined, { timeout: callTimeout }) as { content?: unknown; isError?: boolean };
        // Bounded BEFORE any text is joined or scanned: block count, total size, no nested walk.
        const bounded = boundedText(res.content);
        return { text: bounded.clipped ? `${bounded.text}\n[response clipped by the host]` : bounded.text, isError: res.isError === true };
      } catch (error) {
        // A hung server is shut down (the child is killed by closing its transport), never left running behind a failed call.
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) { end("a call timed out and the server was shut down"); await close(); throw new Error(`the server did not answer within ${Math.round(callTimeout / 1000)}s and was shut down`); }
        throw error;
      }
    },
    close,
    onToolsChanged: l => { changed.push(l); },
    onClosed: l => { closed.push(l); if (ended !== null) l(ended); },
  };
}

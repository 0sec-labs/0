/** The MCP SDK client behind `McpSession`. Shared by the stdio and http adapters. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpCallResult, McpSession } from "../ports.js";
import type { McpToolInfo } from "../core/tool-hash.js";

type Transport = Parameters<Client["connect"]>[0];
export const CONNECT_TIMEOUT_MS = 15_000;
export const CALL_TIMEOUT_MS = 60_000;

const textOf = (content: unknown): string => {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object") return [];
    const b = block as Record<string, unknown>;
    return b["type"] === "text" && typeof b["text"] === "string" ? [b["text"]] : typeof b["type"] === "string" ? [`[${b["type"]} content omitted]`] : [];
  }).join("\n");
};

export async function connectSdk(transport: Transport, timeoutMs = CONNECT_TIMEOUT_MS): Promise<McpSession> {
  const client = new Client({ name: "0", version: "0.1.0" }, { capabilities: {} });
  try { await client.connect(transport, { timeout: timeoutMs }); }
  catch (error) { await client.close().catch(() => undefined); throw error; }
  return {
    async tools(): Promise<McpToolInfo[]> {
      const out: McpToolInfo[] = []; let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
        for (const t of listed.tools ?? []) out.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) });
        cursor = listed.nextCursor; if (!cursor) break;
      }
      return out;
    },
    async call(name, args): Promise<McpCallResult> {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }) as { content?: unknown; isError?: boolean };
      return { text: textOf(res.content), isError: res.isError === true };
    },
    close: () => client.close().catch(() => undefined),
  };
}

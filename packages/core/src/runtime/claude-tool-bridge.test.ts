import { request } from "node:http";
import { describe, it, expect, afterEach, vi } from "vitest";
import { ClaudeToolBridge, nativeToolNameFromClaude, type ClaudeToolBridgeResult } from "./claude-tool-bridge.js";
import type { NativeToolDef } from "./types.js";

const tools: NativeToolDef[] = [
  {
    name: "http_request",
    description: "Send an HTTP request to the target.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
];

function endpoint(bridge: ClaudeToolBridge): { url: string; headers: Record<string, string> } {
  const server = JSON.parse(bridge.mcpConfig()).mcpServers.zero;
  return { url: server.url, headers: server.headers };
}

async function rpc(bridge: ClaudeToolBridge, method: string, params: Record<string, unknown> = {}, headers?: Record<string, string>) {
  const target = endpoint(bridge);
  return fetch(target.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(headers ?? target.headers) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  });
}

async function rpcResult(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  const data = text.split("\n").find(line => line.startsWith("data: "));
  return JSON.parse(data ? data.slice("data: ".length) : text);
}

describe("ClaudeToolBridge", () => {
  let bridge: ClaudeToolBridge | undefined;
  afterEach(async () => { await bridge?.close(); bridge = undefined; });

  it("maps Claude Code tool names back to native names", () => {
    expect(nativeToolNameFromClaude("mcp__zero__http_request")).toBe("http_request");
    expect(nativeToolNameFromClaude("Bash")).toBeUndefined();
    expect(nativeToolNameFromClaude("mcp__other__http_request")).toBeUndefined();
  });

  it("binds loopback and rejects requests without the bearer token", async () => {
    bridge = await ClaudeToolBridge.start(tools);
    expect(endpoint(bridge).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const denied = await rpc(bridge, "tools/list", {}, { Authorization: "Bearer wrong" });
    expect(denied.status).toBe(401);
    const missing = await rpc(bridge, "tools/list", {}, {});
    expect(missing.status).toBe(401);
  });

  it("answers initialize and lists exactly the native tool definitions", async () => {
    bridge = await ClaudeToolBridge.start(tools);
    const init = await rpcResult(await rpc(bridge, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities).toEqual({ tools: { listChanged: true } });
    const listed = await rpcResult(await rpc(bridge, "tools/list"));
    expect(listed.result.tools).toEqual([
      { name: "http_request", description: "Send an HTTP request to the target.", inputSchema: tools[0]!.input_schema },
    ]);
  });

  it("holds tools/call open until the host responds, passing the Claude tool_use id", async () => {
    bridge = await ClaudeToolBridge.start(tools, { keepAliveMs: 20 });
    let respond: ((result: ClaudeToolBridgeResult) => void) | undefined;
    const seen: unknown[] = [];
    bridge.onCall((call, reply) => { seen.push(call); respond = reply; });

    let settled = false;
    const pending = rpc(bridge, "tools/call", {
      name: "http_request",
      arguments: { url: "https://example.test" },
      _meta: { "claudecode/toolUseId": "toolu_1" },
    }).then(rpcResult).finally(() => { settled = true; });

    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toEqual({ toolUseId: "toolu_1", name: "http_request", input: { url: "https://example.test" } });
    await new Promise(resolve => setTimeout(resolve, 80)); // several keepalive intervals
    expect(settled).toBe(false);

    respond!({ content: '{"status":200}' });
    const result = await pending;
    expect(result.id).toBe(7);
    expect(result.result).toEqual({ content: [{ type: "text", text: '{"status":200}' }] });
  });

  it("reports unknown tools as tool errors without calling the host", async () => {
    bridge = await ClaudeToolBridge.start(tools);
    let called = false;
    bridge.onCall(() => { called = true; });
    const result = await rpcResult(await rpc(bridge, "tools/call", { name: "Bash", arguments: { command: "id" } }));
    expect(result.result).toEqual({ content: [{ type: "text", text: "Unknown tool: Bash" }], isError: true });
    expect(called).toBe(false);
  });

  it("fails calls still waiting when the bridge closes", async () => {
    bridge = await ClaudeToolBridge.start(tools);
    const seen: unknown[] = [];
    bridge.onCall(call => { seen.push(call); });
    const pending = rpc(bridge, "tools/call", { name: "http_request", arguments: { url: "https://x" } }).then(rpcResult);
    await expect.poll(() => seen.length).toBe(1);
    const closing = bridge.close();
    bridge = undefined;
    const result = await pending.catch(() => undefined);
    await closing;
    // Either the error result reached the client or the connection was torn down; never a success.
    if (result) expect(result.result.isError).toBe(true);
  });
  it("handles an authenticated body disconnect without rejecting in the host", async () => {
    bridge = await ClaudeToolBridge.start(tools);
    const rejection = vi.fn(); process.on("unhandledRejection", rejection);
    try {
      const target = endpoint(bridge);
      await new Promise<void>(resolve => {
        const client = request(target.url, { method: "POST", headers: { ...target.headers, "Content-Length": "1000" } });
        client.on("error", () => undefined); client.on("close", resolve);
        client.write("{"); setTimeout(() => client.destroy(), 25);
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(rejection).not.toHaveBeenCalled();
      expect((await rpcResult(await rpc(bridge, "ping"))).result).toEqual({});
    } finally { process.off("unhandledRejection", rejection); }
  });
  it("keeps UTF-8 tool input intact across request chunks and contains listener errors", async () => {
    bridge = await ClaudeToolBridge.start(tools);
    let value: unknown;
    bridge.onCall((call, respond) => { value = call.input.text; respond({ content: "ok" }); });
    const target = endpoint(bridge);
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "http_request", arguments: { text: "€" } } }));
    const split = bytes.indexOf(Buffer.from("€")) + 1;
    await new Promise<void>((resolve, reject) => {
      const client = request(target.url, { method: "POST", headers: { ...target.headers, "Content-Length": bytes.length } }, res => { res.resume(); res.on("end", resolve); });
      client.on("error", reject); client.write(bytes.subarray(0, split)); setTimeout(() => client.end(bytes.subarray(split)), 15);
    });
    expect(value).toBe("€");
    bridge.onCall(() => { throw new Error("private host failure"); });
    const failed = await rpcResult(await rpc(bridge, "tools/call", { name: "http_request", arguments: {} }));
    expect(failed.result.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("private host failure");
    bridge.onCall(async () => { throw new Error("private async failure"); });
    expect((await rpcResult(await rpc(bridge, "tools/call", { name: "http_request", arguments: {} }))).result.isError).toBe(true);
  });
  it("authenticates dynamic tool notifications and survives stream disconnect/reconnect", async () => {
    bridge = await ClaudeToolBridge.start(tools);
    const target = endpoint(bridge);
    expect((await fetch(target.url, { headers: { Accept: "text/event-stream" } })).status).toBe(401);
    const stream = await fetch(target.url, { headers: { ...target.headers, Accept: "text/event-stream" } });
    const reader = stream.body!.getReader(); await reader.read();
    bridge.updateTools([...tools, { name: "new_tool", description: "new", input_schema: { type: "object", properties: {} } }]);
    const notification = new TextDecoder().decode((await reader.read()).value);
    expect(notification).toContain('"method":"notifications/tools/list_changed"');
    expect((await rpcResult(await rpc(bridge, "tools/list"))).result.tools.map((tool: any) => tool.name)).toContain("new_tool");
    await reader.cancel();
    const replacement = await fetch(target.url, { headers: { ...target.headers, Accept: "text/event-stream" } });
    const replacementReader = replacement.body!.getReader(); await replacementReader.read();
    bridge.updateTools(tools);
    expect(new TextDecoder().decode((await replacementReader.read()).value)).toContain("notifications/tools/list_changed");
    await replacementReader.cancel();
    expect((await rpcResult(await rpc(bridge, "ping"))).result).toEqual({});
  });

});

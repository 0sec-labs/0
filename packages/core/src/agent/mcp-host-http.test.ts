import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { connectMcpServers, McpHost, parseMcpConfig } from "./mcp-host.js";

describe("HTTP MCP configuration", () => {
  it("preserves HTTP authentication headers alongside legacy stdio servers", () => {
    const configs = [
      { id: "elastic", url: "https://elastic.example/mcp", headers: { Authorization: "ApiKey test-key" } },
      { id: "local", command: "npx", args: ["-y", "example-server"] },
    ];
    expect(parseMcpConfig(JSON.stringify(configs))).toEqual(configs);
  });

  it.each([
    "http://127.0.0.1:9876/mcp",
    "http://localhost:9876/mcp",
    "http://[::1]:9876/mcp",
    "https://elastic.example/mcp",
  ])("accepts a secure or loopback endpoint: %s", (url) => {
    expect(parseMcpConfig(JSON.stringify([{ id: "test", url }]))).toEqual([{ id: "test", url }]);
  });

  it.each([
    "http://elastic.example/mcp",
    "http://localhost.evil.example/mcp",
    "http://192.168.1.10/mcp",
    "ftp://elastic.example/mcp",
    "https://user:password@elastic.example/mcp",
    "https://elastic.example/mcp#fragment",
    "not a URL",
  ])("rejects insecure, credential-bearing, or malformed endpoint: %s", (url) => {
    expect(parseMcpConfig(JSON.stringify([{ id: "test", url }]))).toEqual([]);
  });

  it("rejects ambiguous transports while keeping independent valid entries", () => {
    expect(parseMcpConfig(JSON.stringify([
      { id: "ambiguous", command: "node", url: "https://elastic.example/mcp" },
      { id: "valid", url: "https://elastic.example/mcp" },
    ]))).toEqual([{ id: "valid", url: "https://elastic.example/mcp" }]);
  });

  it.each([
    { Authorization: 123 },
    { Authorization: "ApiKey safe\r\nX-Injected: yes" },
    { "X-Injected\r\nHeader": "value" },
    { "Invalid Header": "value" },
    ["Authorization", "value"],
    "Authorization: value",
  ])("rejects invalid header objects without downgrading authentication", (headers) => {
    expect(parseMcpConfig(JSON.stringify([{ id: "test", url: "https://elastic.example/mcp", headers }]))).toEqual([]);
  });
});

describe("McpHost HTTP transport", () => {
  it("discovers and calls tools over authenticated HTTP, handles tool errors, and tears down", async () => {
    const server = new McpServer({ name: "http-test", version: "1.0.0" });
    server.registerTool("platform.core.search", {
      description: "Echo through a remote service",
      inputSchema: { message: z.string() },
    }, async ({ message }) => ({ content: [{ type: "text", text: `remote: ${message}` }] }));
    server.registerTool("fail", { description: "Return a service error" }, async () => ({
      isError: true,
      content: [{ type: "text", text: "service unavailable" }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
    await server.connect(transport);
    const observedAuth: Array<string | undefined> = [];
    const httpServer = createServer((req, res) => {
      observedAuth.push(req.headers.authorization);
      if (req.headers.authorization !== "Bearer test-token") {
        res.writeHead(401).end();
        return;
      }
      void transport.handleRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    let host: McpHost | undefined;
    try {
      // Exercise the public transport dispatcher as well as the SDK handshake.
      host = await connectMcpServers([{
        id: "remote",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: "Bearer test-token" },
      }]);
      expect(host).toBeDefined();
      expect(host!.serverIds()).toEqual(["remote"]);
      expect(host!.registeredTools().map((tool) => tool.name)).toEqual([
        "mcp__remote__platform.core.search", "mcp__remote__fail",
      ]);
      const result = await host!.callTool("mcp__remote__platform.core.search", { message: "hello" });
      expect(result).toEqual({ success: true, output: { text: "remote: hello" } });
      expect(await host!.callTool("mcp__remote__fail", {})).toEqual({
        success: false, output: null, error: "service unavailable",
      });
      expect(observedAuth.length).toBeGreaterThanOrEqual(4);
      expect(observedAuth.every((value) => value === "Bearer test-token")).toBe(true);
    } finally {
      await host?.closeAll();
      await server.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
    expect(host!.serverIds()).toEqual([]);
  }, 15_000);

  it("rejects redirects before forwarding authentication to the redirected endpoint", async () => {
    const requests: Array<{ url: string | undefined; auth: string | undefined }> = [];
    const httpServer = createServer((req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization });
      if (req.url === "/mcp") res.writeHead(307, { Location: "/credential-sink" }).end();
      else res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const host = new McpHost();
    try {
      await expect(host.connectHttp({
        id: "redirect",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: "Bearer private-token" },
      })).rejects.toThrow();
      expect(host.serverIds()).toEqual([]);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((request) => request.url === "/mcp")).toBe(true);
      expect(requests[0]?.auth).toBe("Bearer private-token");
    } finally {
      await host.closeAll();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  }, 15_000);
});

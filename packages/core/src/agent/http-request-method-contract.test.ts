import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolExecutor, getToolsForRole } from "./tools.js";
import { toNativeToolDef } from "./native-tooldef.js";
import { ScopePolicy } from "../scope/scope.js";
import { withScopeEnforcement } from "../scope/activation.js";

let server: Server;
let executor: ToolExecutor;
let target: string;
let requests: Array<{ method: string; authorization?: string; body: string }>;
const approval = { pluginId: "scope" as const, enabled: true, projectPath: process.cwd(), message: "Synthetic loopback fixture approval" };
function request(method?: string, url = `${target}/probe`) {
  return withScopeEnforcement(approval, () => executor.execute({ name: "http_request", arguments: { url, ...(method === undefined ? {} : { method }) } }));
}
beforeEach(async () => {
  requests = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ method: req.method!, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.setHeader("allow", "GET, HEAD, OPTIONS, POST");
    res.end(`${req.method} fixture response`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  executor = new ToolExecutor({ target, scanId: "http-method-fixture", findings: [], attackResults: [], targetInfo: {},
    scope: ScopePolicy.fromJson({ in_scope: ["127.0.0.1"] }),
    authConfig: { type: "bearer", token: "synthetic-method-fixture-secret" },
  }, null);
});
afterEach(async () => {
  await executor.cleanup();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe("http_request method contract", () => {
  it("advertises supported HEAD and OPTIONS while retaining the optional POST default", () => {
    const tool = getToolsForRole("attack", { webMode: true }).find(tool => tool.name === "http_request")!;
    const native = toNativeToolDef(tool);
    const methods = native.input_schema.properties.method as { enum: string[] };
    expect(methods.enum).toEqual(["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH"]);
    expect(methods.enum).not.toContain("UNKNOWN");
    expect(native.input_schema.required).toEqual(["url"]);
    expect(tool.parameters.method!.description).toContain("defaults to POST");
  });
  it("sends HEAD exactly once with configured authentication and returns no body", async () => {
    const result = await request("HEAD");
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ status: 200, body: "", headers: { allow: "GET, HEAD, OPTIONS, POST" } });
    expect(requests).toEqual([{ method: "HEAD", authorization: "Bearer synthetic-method-fixture-secret", body: "" }]);
  });
  it("sends OPTIONS exactly once without substituting GET", async () => {
    const result = await request("OPTIONS");
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ status: 200, body: "OPTIONS fixture response", headers: { allow: "GET, HEAD, OPTIONS, POST" } });
    expect(requests).toEqual([{ method: "OPTIONS", authorization: "Bearer synthetic-method-fixture-secret", body: "" }]);
  });
  it("preserves POST when the optional method is omitted", async () => {
    expect((await request()).success).toBe(true);
    expect(requests.map(req => req.method)).toEqual(["POST"]);
  });
  it.each(["HEAD", "OPTIONS"])("refuses out-of-scope %s before the loopback transport", async method => {
    const result = await request(method, target.replace("127.0.0.1", "localhost"));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/scope/i);
    expect(requests).toEqual([]);
  });
});

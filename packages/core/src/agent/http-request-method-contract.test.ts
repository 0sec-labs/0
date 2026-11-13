import { afterEach, describe, expect, it, vi } from "vitest";
// The engagement authorization plugin is explicitly enabled for these tests.
vi.mock("../plugins/enablement.js", async importOriginal => ({
  ...await importOriginal<object>(),
  readEnablement: () => ({ schema: 1, project: process.cwd(), enabled: { scope: { version: "1.0.0", capabilities: [], enabledAt: 1 } } }),
}));
import { ToolExecutor, getToolsForRole } from "./tools.js";
import { toNativeToolDef } from "./native-tooldef.js";
import { ScopePolicy } from "../scope/scope.js";
import type { ToolContext } from "./types.js";

// Replace only the HTTP transport. The real executor still checks scope and
// authentication and constructs the request; no DNS or target network is used.
const fetchStub = vi.hoisted(() => vi.fn(async (_url: string, _init?: RequestInit) =>
  new Response(null, { status: 200, headers: { allow: "GET, HEAD, OPTIONS" } })));
vi.mock("../http.js", async importOriginal => ({
  ...await importOriginal<object>(), fetchScoped: fetchStub,
}));
afterEach(() => fetchStub.mockClear());

function executor() {
  const ctx: ToolContext = {
    target: "https://method-contract.example", scanId: "http-method-contract",
    findings: [], attackResults: [], targetInfo: {},
    scope: ScopePolicy.fromJson({ in_scope: ["method-contract.example"] }),
    scopeEnforcement: { pluginId: "scope", enabled: true, projectPath: process.cwd(), message: "Test scope" },
    authConfig: { type: "bearer", token: "fixture-only-not-a-real-secret" },
  };
  return new ToolExecutor(ctx, null);
}

describe("http_request advertised and executed methods", () => {
  it("offers HEAD and OPTIONS to native agents without changing the optional method contract", () => {
    const tool = getToolsForRole("attack", { webMode: true }).find(tool => tool.name === "http_request")!;
    expect(tool).toBeDefined();
    const native = toNativeToolDef(tool);
    expect(native.input_schema.properties.method).toMatchObject({ enum: expect.arrayContaining(["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH"]) });
    expect(native.input_schema.required).toEqual(["url"]);
    expect(tool.parameters.method!.description).toContain("defaults to POST");
  });

  it.each(["HEAD", "OPTIONS"])("sends exactly one %s request, preserving authentication, without GET substitution", async method => {
    const ex = executor();
    try {
      const result = await ex.execute({ name: "http_request", arguments: { url: "https://method-contract.example/health", method } });
      expect(result.success).toBe(true);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(fetchStub).toHaveBeenCalledWith("https://method-contract.example/health", expect.objectContaining({
        method, redirect: "manual", headers: expect.objectContaining({ Authorization: "Bearer fixture-only-not-a-real-secret" }),
      }), expect.anything());
    } finally { await ex.cleanup(); }
  });

  it("retains the existing POST default when method is omitted", async () => {
    const ex = executor();
    try {
      expect((await ex.execute({ name: "http_request", arguments: { url: "https://method-contract.example/health" } })).success).toBe(true);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(fetchStub.mock.calls[0]![1]?.method).toBe("POST");
    } finally { await ex.cleanup(); }
  });

  it.each(["HEAD", "OPTIONS"])("refuses an out-of-scope %s request before transport", async method => {
    const ex = executor();
    try {
      const result = await ex.execute({ name: "http_request", arguments: { url: "https://out-of-scope.example/", method } });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/scope|origin/i);
      expect(fetchStub).not.toHaveBeenCalled();
    } finally { await ex.cleanup(); }
  });
});

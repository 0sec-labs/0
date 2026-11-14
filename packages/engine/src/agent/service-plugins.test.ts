import { afterEach, describe, expect, it, vi } from "vitest";
import { connectServicePlugins, testServicePluginConnection, type ServicePluginConnection } from "./service-plugins.js";
import { McpHost } from "./mcp-host.js";

const fields: Record<string, Record<string, string>> = {
  github: { token: "test-secret" }, semgrep: { token: "test-secret", deploymentId: "123" },
  snyk: { token: "test-secret", organizationId: "org" }, linear: { token: "test-secret" },
  jira: { token: "test-secret", email: "test@example.com", url: "https://example.atlassian.net" },
  cloudflare: { token: "test-secret" }, slack: { token: "test-secret" }, teams: { token: "test-secret" },
};
const conn = (id: string): ServicePluginConnection => ({ id, enabled: true, fields: fields[id]! });
const success = { ok: true, success: true, result: { status: "active" }, deployments: [{ id: 123, slug: "test-org" }], data: { viewer: { id: "123" } } };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("vendor service plugins", () => {
  it.each(Object.keys(fields))("validates %s account and discovers real tool schemas", async id => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(success)));
    vi.stubGlobal("fetch", fetcher);
    const result = await testServicePluginConnection(conn(id));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.tools.length).toBeGreaterThanOrEqual(2);
    expect(result.tools.length).toBeLessThanOrEqual(10);
    expect(result.tools.every(t => t.name.startsWith(`mcp__${id}__`))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(fetcher.mock.calls[0]![1].redirect).toBe("error");
    expect(fetcher.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("passes explicit action parameters and authentication, preserving the MCP untrusted fence", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(success)));
    vi.stubGlobal("fetch", fetcher);
    const host = await connectServicePlugins([conn("github")]);
    expect(host?.registeredTools()[0]?.description).toContain("untrusted");
    const result = await host!.callTool("mcp__github__create_issue", { owner: "team", repository: "repo", title: "Fix", body: "Finding" });
    expect(result.success).toBe(true);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe("https://api.github.com/repos/team/repo/issues");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-secret");
    expect(JSON.parse(init.body)).toEqual({ title: "Fix", body: "Finding" });
    await host!.closeAll();
  });

  it("resolves Semgrep deployment IDs to the documented slug endpoint", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(success)));
    vi.stubGlobal("fetch", fetcher);
    const host = await connectServicePlugins([conn("semgrep")]);
    const result = await host!.callTool("mcp__semgrep__list_findings", {});
    expect(result.success).toBe(true);
    expect(String(fetcher.mock.calls[1]![0])).toBe("https://semgrep.dev/api/v1/deployments/test-org/findings?page_size=100&issue_type=sast");
    await host!.closeAll();
  });

  it("omits disabled/expired integrations without interfering with an existing host", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("token test-secret", { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const host = new McpHost();
    expect(await connectServicePlugins([{ ...conn("slack"), enabled: false }, conn("teams")], host)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(host.registeredTools()).toEqual([]);
  });

  it("rejects application-level errors even with HTTP 200 and never exposes credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: "test-secret" }))));
    await expect(testServicePluginConnection(conn("slack"))).rejects.toThrow("service rejected");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({ errors: [{ message: "test-secret" }] }))));
    await expect(testServicePluginConnection(conn("linear"))).rejects.toThrow("service rejected");
  });

  it("redacts echoed token and authorization from successful outputs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({ echo: "test-secret", auth: "Bearer test-secret" }))));
    const host = await connectServicePlugins([conn("github")]);
    const result = await host!.callTool("mcp__github__list_repositories", {});
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("test-secret");
    await host!.closeAll();
  });

  it("redacts credentials encoded as JSON unicode escapes", async () => {
    const escaped = [..."test-secret"].map(char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(`{"echo":"${escaped}"}`)));
    const host = await connectServicePlugins([conn("github")]);
    const result = await host!.callTool("mcp__github__list_repositories", {});
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(JSON.stringify(result)).toContain("[redacted]");
    await host!.closeAll();
  });

  it("rejects response overflow and invalid tool input before acting", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response("x".repeat(1_048_577)));
    vi.stubGlobal("fetch", fetcher);
    const host = await connectServicePlugins([conn("github")]);
    const invalid = await host!.callTool("mcp__github__create_issue", { owner: "..", repository: "repo", title: "X", body: "X" });
    expect(invalid.success).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    const oversized = await host!.callTool("mcp__github__list_repositories", {});
    expect(oversized.success).toBe(false);
    expect(oversized.error).toContain("response too large");
    await host!.closeAll();
  });

  it("rejects unsafe endpoints and Snyk origins before sending secrets", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(testServicePluginConnection({ ...conn("jira"), fields: { ...fields.jira, url: "http://evil.example" } })).rejects.toThrow("HTTPS");
    await expect(testServicePluginConnection({ ...conn("snyk"), fields: { ...fields.snyk, url: "https://evil.example" } })).rejects.toThrow("supported Snyk");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("connects Elastic using its official MCP endpoint and API key", async () => {
    const spy = vi.spyOn(McpHost.prototype, "connectHttp").mockResolvedValue([]);
    await testServicePluginConnection({ id: "elastic", enabled: true, fields: { url: "https://example.kb.elastic.co/s/security", token: "test-secret" } });
    expect(spy).toHaveBeenCalledWith({ id: "elastic", url: "https://example.kb.elastic.co/s/security/api/agent_builder/mcp", headers: { Authorization: "ApiKey test-secret", "kbn-xsrf": "true" } });
  });
});

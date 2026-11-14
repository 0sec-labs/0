import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, lstatSync, readFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHost } from "@0/engine";
import { CustomMcpServices, assertRemoteAllowed, connectCustomMcpServers, normalizeMcpConfig, type McpConnector } from "./custom-mcp.js";

vi.mock("../console-execution.js", () => ({ consoleExecutionProfile: () => "local" }));

describe("custom MCP servers", () => {
  let home: string; let workspace: string; let services: CustomMcpServices;
  const connector = vi.fn<McpConnector>();
  const resolveHost = vi.fn(async () => ["93.184.216.34"]);
  const stdio = { name: "Docs Search", transport: "stdio", command: "node", args: ["server.js"], env: { API_KEY: "super-secret-value" } };
  const call = (path: string, method: string, body?: unknown) => services.handle(path, method, body);
  async function create(config: unknown = stdio, enable = false) {
    const preview = await call("mcp-servers/preview", "POST", { config });
    const fingerprint = (preview!.data as { approval: { fingerprint: string } }).approval.fingerprint;
    return call("mcp-servers", "POST", { config, approvedFingerprint: fingerprint, enable });
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "zero-mcp-home-")); workspace = realpathSync(mkdtempSync(join(tmpdir(), "zero-mcp-ws-")));
    connector.mockReset(); connector.mockResolvedValue({ tools: [{ name: "search", description: "Search docs super-secret-value" }], resources: [{ uri: "doc://a", name: "A" }], version: "1.2.3" });
    services = new CustomMcpServices({ homeDir: home, workspaceRoot: () => workspace, connector, resolveHost });
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });

  it("previews the exact command without saving or running anything", async () => {
    const preview = await call("mcp-servers/preview", "POST", { config: stdio });
    expect(preview?.status).toBe(200);
    const approval = (preview!.data as { approval: { summary: { command: string; args: string[]; cwd: string; envKeys: string[] } } }).approval;
    expect(approval.summary).toMatchObject({ command: "node", args: ["server.js"], cwd: workspace, envKeys: ["API_KEY"] });
    expect(JSON.stringify(preview)).not.toContain("super-secret-value");
    expect(((await call("mcp-servers", "GET"))!.data as { items: unknown[] }).items).toHaveLength(0);
    expect(connector).not.toHaveBeenCalled();
  });

  it("requires the reviewed fingerprint, saves disabled, and never returns env values", async () => {
    const refused = await call("mcp-servers", "POST", { config: stdio, approvedFingerprint: "nope" });
    expect(refused?.status).toBe(409); expect((refused!.data as { code: string }).code).toBe("approval_required");
    const created = await create();
    expect(created?.status).toBe(201);
    const item = (created!.data as { item: Record<string, unknown> }).item;
    expect(item).toMatchObject({ id: "custom-docs-search", kind: "custom-mcp", enabled: false, status: "disabled", envKeys: ["API_KEY"], approved: true, skillCount: 0 });
    expect(String(item.logo)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(JSON.stringify(created)).not.toContain("super-secret-value");
    expect(lstatSync(join(home, ".0", "mcp-servers.json")).mode & 0o777).toBe(0o600);
    expect(connector).not.toHaveBeenCalled();
  });

  it("tests a server, reports counts and names, and redacts secrets", async () => {
    await create();
    const tested = await call("mcp-servers/custom-docs-search/test", "POST", {});
    expect(tested?.status).toBe(200);
    expect(tested!.data).toMatchObject({ ok: true, toolCount: 1, resourceCount: 1, serverVersion: "1.2.3" });
    expect(JSON.stringify(tested)).not.toContain("super-secret-value");
    expect(connector).toHaveBeenCalledWith(expect.objectContaining({ transport: "stdio", cwd: workspace, env: { API_KEY: "super-secret-value" } }));
    connector.mockRejectedValue(new Error("boom super-secret-value"));
    const failed = await call("mcp-servers/custom-docs-search/test", "POST", {});
    expect(failed?.status).toBe(409); expect(JSON.stringify(failed)).not.toContain("super-secret-value");
  });

  it("enabling or editing needs a fresh approval; disabling does not", async () => {
    await create();
    const unapproved = await call("mcp-servers/custom-docs-search", "PATCH", { enabled: true });
    expect(unapproved?.status).toBe(409);
    const fingerprint = (unapproved!.data as { approval: { fingerprint: string } }).approval.fingerprint;
    const enabled = await call("mcp-servers/custom-docs-search", "PATCH", { enabled: true, approvedFingerprint: fingerprint });
    expect((enabled!.data as { item: { enabled: boolean } }).item.enabled).toBe(true);
    const edit = await call("mcp-servers/custom-docs-search", "PATCH", { config: { command: "python3" } });
    expect(edit?.status).toBe(409);
    const edited = await call("mcp-servers/custom-docs-search", "PATCH", { config: { command: "python3" }, approvedFingerprint: (edit!.data as { approval: { fingerprint: string } }).approval.fingerprint });
    expect(edited!.data).toMatchObject({ item: { command: "python3", enabled: false, status: "disabled", envKeys: ["API_KEY"] } });
    // The stored secret survives an edit that does not resend it.
    expect(readFileSync(join(home, ".0", "mcp-servers.json"), "utf8")).toContain("super-secret-value");
    const off = await call("mcp-servers/custom-docs-search", "PATCH", { enabled: false });
    expect(off?.status).toBe(200);
  });

  describe("env and header values are bound to the approval without being exposed", () => {
    const fp = (r: { data: unknown } | null) => (r!.data as { approval: { fingerprint: string } }).approval.fingerprint;
    const id = "mcp-servers/custom-docs-search";
    it("a value-only env change needs a fresh approval and the key never leaves the server", async () => {
      await create(stdio, true);
      const approved = fp(await call("mcp-servers/preview", "POST", { config: stdio }));
      const changedConfig = { ...stdio, env: { API_KEY: "different-value-123" } };
      const refused = await call(id, "PATCH", { config: { env: { API_KEY: "different-value-123" } }, approvedFingerprint: approved });
      expect(refused?.status).toBe(409); expect((refused!.data as { code: string }).code).toBe("approval_required");
      const next = fp(await call("mcp-servers/preview", "POST", { config: changedConfig }));
      expect(next).not.toBe(approved);
      const ok = await call(id, "PATCH", { config: { env: { API_KEY: "different-value-123" } }, approvedFingerprint: next });
      expect(ok?.status).toBe(200); expect((ok!.data as { item: { enabled: boolean } }).item.enabled).toBe(false);
      const text = JSON.stringify([refused, ok]);
      expect(text).not.toContain("different-value-123"); expect(text).not.toContain("super-secret-value");
      expect(readFileSync(join(home, ".0", "mcp-fingerprint.key")).length).toBe(32);
      expect(lstatSync(join(home, ".0", "mcp-fingerprint.key")).mode & 0o777).toBe(0o600);
    });
    it("a header value change on a remote server needs a fresh approval", async () => {
      const remote = { name: "Remote Docs", transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer token-one-1234" } };
      await create(remote);
      const rid = "mcp-servers/custom-remote-docs";
      const old = fp(await call("mcp-servers/preview", "POST", { config: remote }));
      const stale = await call(rid, "PATCH", { config: { headers: { Authorization: "Bearer token-two-5678" } }, approvedFingerprint: old });
      expect(stale?.status).toBe(409); expect(JSON.stringify(stale)).not.toContain("token-two");
      expect(fp(await call("mcp-servers/preview", "POST", { config: { ...remote, headers: { Authorization: "Bearer token-two-5678" } } }))).not.toBe(old);
    });
    it("different installs derive different fingerprints for the same config", async () => {
      const other = mkdtempSync(join(tmpdir(), "zero-mcp-home2-"));
      try {
        const second = new CustomMcpServices({ homeDir: other, workspaceRoot: () => workspace, connector, resolveHost });
        const a = fp(await call("mcp-servers/preview", "POST", { config: stdio }));
        const b = fp(await second.handle("mcp-servers/preview", "POST", { config: stdio }));
        expect(a).not.toBe(b);
      } finally { rmSync(other, { recursive: true, force: true }); }
    });
    it("code-loading env needs an explicit dangerous-env approval shown in the payload", async () => {
      const config = { ...stdio, env: { PATH: "/tmp/evil-bin", NODE_PATH: "/tmp/lib" } };
      const preview = await call("mcp-servers/preview", "POST", { config });
      const approval = (preview!.data as { approval: { fingerprint: string; dangerousEnv: string[]; warnings: string[] } }).approval;
      expect(approval.dangerousEnv).toEqual(["NODE_PATH", "PATH"]);
      expect(approval.warnings.join(" ")).toContain("PATH");
      const plain = await call("mcp-servers", "POST", { config, approvedFingerprint: approval.fingerprint });
      expect(plain?.status).toBe(409); expect((plain!.data as { code: string }).code).toBe("dangerous_env_approval_required");
      const partial = await call("mcp-servers", "POST", { config, approvedFingerprint: approval.fingerprint, approvedDangerousEnv: ["PATH"] });
      expect(partial?.status).toBe(409);
      const ok = await call("mcp-servers", "POST", { config, approvedFingerprint: approval.fingerprint, approvedDangerousEnv: ["PATH", "NODE_PATH"] });
      expect(ok?.status).toBe(201);
      expect(JSON.stringify(ok)).not.toContain("/tmp/evil-bin");
    });
    it("still hard-blocks loader injection variables", () => {
      for (const name of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS"]) expect(() => normalizeMcpConfig({ ...stdio, env: { [name]: "x" } }), name).toThrow();
    });
  });

  describe("approval is bound to the final config at request time", () => {
    const fp = (r: { data: unknown } | null) => (r!.data as { approval: { fingerprint: string } }).approval.fingerprint;
    const id = "mcp-servers/custom-docs-search";
    const stored = () => JSON.parse(readFileSync(join(home, ".0", "mcp-servers.json"), "utf8"))[0] as { command: string; enabled: boolean };
    const preview = async (config: unknown) => fp(await call("mcp-servers/preview", "POST", { config }));
    const secretFree = (r: unknown) => { const t = JSON.stringify(r); expect(t).not.toContain("super-secret-value"); expect(t).not.toContain("other-secret-value"); };

    it("rejects enabling with no fingerprint, a stale one, or another server's", async () => {
      await create(); await create({ ...stdio, name: "Other", command: "deno", env: { API_KEY: "other-secret-value" } });
      const none = await call(id, "PATCH", { enabled: true });
      expect(none?.status).toBe(409); expect((none!.data as { code: string }).code).toBe("approval_required"); secretFree(none);
      const foreign = await call(id, "PATCH", { enabled: true, approvedFingerprint: await preview({ ...stdio, command: "deno" }) });
      expect(foreign?.status).toBe(409);
      expect((await call(id, "PATCH", { enabled: true, approvedFingerprint: "0".repeat(64) }))?.status).toBe(409);
      expect(stored().enabled).toBe(false);
    });

    it("a stored approval from before an edit does not enable; a stale fingerprint is rejected", async () => {
      await create();
      const old = await preview(stdio);
      const edit = await call(id, "PATCH", { config: { command: "python3" }, approvedFingerprint: await preview({ ...stdio, command: "python3" }) });
      expect(edit?.status).toBe(200); expect(stored().enabled).toBe(false);
      const stale = await call(id, "PATCH", { enabled: true, approvedFingerprint: old });
      expect(stale?.status).toBe(409); expect(stored().enabled).toBe(false);
      expect((await call(id, "PATCH", { enabled: true }))?.status).toBe(409);
      const ok = await call(id, "PATCH", { enabled: true, approvedFingerprint: await preview({ ...stdio, command: "python3" }) });
      expect(ok?.status).toBe(200); secretFree(ok);
    });

    it("config change with the old fingerprint is rejected atomically with the new approval payload", async () => {
      await create(stdio, true);
      const old = await preview(stdio);
      const before = readFileSync(join(home, ".0", "mcp-servers.json"), "utf8");
      const res = await call(id, "PATCH", { config: { command: "evil", args: ["x"] }, approvedFingerprint: old });
      expect(res?.status).toBe(409);
      const approval = (res!.data as { approval: { fingerprint: string; summary: { command: string } } }).approval;
      expect(approval.summary.command).toBe("evil"); expect(approval.fingerprint).not.toBe(old);
      expect(readFileSync(join(home, ".0", "mcp-servers.json"), "utf8")).toBe(before);
      secretFree(res);
    });

    it("config change with the matching new fingerprint is saved but never keeps the enabled state", async () => {
      await create(stdio, true);
      const next = { ...stdio, command: "python3" };
      const res = await call(id, "PATCH", { config: { command: "python3" }, approvedFingerprint: await preview(next) });
      expect(res?.status).toBe(200);
      expect(res!.data).toMatchObject({ item: { command: "python3", enabled: false, status: "disabled", approved: true } }); secretFree(res);
      // Changing url on a remote server likewise disables it.
      await create({ name: "Remote", transport: "http", url: "https://ok.example/mcp" }, true);
      const remote = { name: "Remote", transport: "http", url: "https://ok.example/other" };
      const moved = await call("mcp-servers/custom-remote", "PATCH", { config: { url: remote.url }, approvedFingerprint: await preview(remote) });
      expect(moved!.data).toMatchObject({ item: { enabled: false } });
      expect(((await call("mcp-servers/custom-remote", "PATCH", { config: { url: "https://ok.example/third" }, enabled: true }))!.data as { code: string }).code).toBe("approval_required");
    });

    it("a concurrent edit between preview and approve invalidates the preview", async () => {
      await create();
      const previewed = await preview({ ...stdio, command: "node" });
      await call(id, "PATCH", { config: { args: ["other.js"] }, approvedFingerprint: await preview({ ...stdio, args: ["other.js"] }) });
      const res = await call(id, "PATCH", { enabled: true, approvedFingerprint: previewed });
      expect(res?.status).toBe(409); expect(stored().enabled).toBe(false);
    });

    it("disabling needs no approval and POST binds to the submitted config", async () => {
      await create(stdio, true);
      expect((await call(id, "PATCH", { enabled: false }))?.status).toBe(200); expect(stored().enabled).toBe(false);
      const other = await call("mcp-servers", "POST", { config: { ...stdio, name: "Z", command: "evil" }, approvedFingerprint: await preview(stdio), enable: true });
      expect(other?.status).toBe(409);
    });
  });

  it("deletes servers and their stored secrets", async () => {
    await create(); await call("mcp-servers/custom-docs-search", "DELETE");
    expect(readFileSync(join(home, ".0", "mcp-servers.json"), "utf8")).not.toContain("super-secret-value");
    expect((await call("mcp-servers/custom-docs-search/test", "POST", {}))?.status).toBe(404);
  });

  it("rejects unsafe config", () => {
    for (const config of [
      { ...stdio, command: "node server.js" }, { ...stdio, cwd: "../escape" }, { ...stdio, cwd: "/etc" },
      { ...stdio, env: { LD_PRELOAD: "/tmp/x.so" } }, { ...stdio, env: { "bad key": "x" } }, { ...stdio, args: ["ok", 3] },
      { name: "r", transport: "http", url: "http://example.com/mcp" }, { name: "r", transport: "http", url: "https://u:p@example.com/mcp" },
      { name: "r", transport: "sse", url: "https://example.com/mcp", headers: { "X-Bad": "a\nb" } }, { name: "", transport: "stdio", command: "x" },
    ]) expect(() => normalizeMcpConfig(config), JSON.stringify(config)).toThrow();
  });

  it("applies the network guard to remote URLs (loopback, private DNS)", async () => {
    await expect(assertRemoteAllowed("https://localhost/mcp")).rejects.toThrow();
    await expect(assertRemoteAllowed("https://169.254.169.254/mcp")).rejects.toThrow();
    await expect(assertRemoteAllowed("https://internal.example/mcp", async () => ["10.0.0.5"])).rejects.toThrow();
    await expect(assertRemoteAllowed("https://ok.example/mcp", async () => ["93.184.216.34"])).resolves.toBeUndefined();
    const blocked = await call("mcp-servers/preview", "POST", { config: { name: "x", transport: "http", url: "https://127.0.0.1/mcp" } });
    expect(blocked?.status).toBe(400); expect((blocked!.data as { code: string }).code).toBe("network_blocked");
    const ok = await create({ name: "Remote", transport: "sse", url: "https://ok.example/mcp", headers: { Authorization: "Bearer remote-secret-token" } });
    expect(ok?.status).toBe(201); expect(JSON.stringify(ok)).not.toContain("remote-secret-token");
    expect((ok!.data as { item: { headerNames: string[] } }).item.headerNames).toEqual(["Authorization"]);
  });

  it("keeps the launch directory inside the workspace even through symlinks", async () => {
    const outside = mkdtempSync(join(tmpdir(), "zero-mcp-out-"));
    try {
      symlinkSync(outside, join(workspace, "link")); mkdirSync(join(workspace, "ok"));
      expect((await create({ ...stdio, name: "inside", cwd: "ok" }))?.status).toBe(201);
      const escaped = await call("mcp-servers/preview", "POST", { config: { ...stdio, cwd: "link" } });
      expect(escaped?.status).toBe(400);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

describe("custom MCP servers reach missions like built-ins (real stdio, no network)", () => {
  it("exposes enabled, approved servers as mcp__custom-*__ tools with a scrubbed environment", async () => {
    const home = mkdtempSync(join(tmpdir(), "zero-mcp-e2e-home-")); const workspace = realpathSync(mkdtempSync(join(tmpdir(), "zero-mcp-e2e-ws-")));
    const sdk = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"); const stdioSdk = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    writeFileSync(join(workspace, "server.mjs"), `
import { McpServer } from ${JSON.stringify(sdk)};
import { StdioServerTransport } from ${JSON.stringify(stdioSdk)};
const server = new McpServer({ name: "fake", version: "9.9.9" });
server.registerTool("probe", { description: "probe" }, async () => ({ content: [{ type: "text", text: JSON.stringify({ declared: process.env.DECLARED, leaked: process.env.UNDECLARED_PARENT_SECRET ?? null, cwd: process.cwd() }) }] }));
await server.connect(new StdioServerTransport());
`);
    process.env.UNDECLARED_PARENT_SECRET = "parent-secret";
    const services = new CustomMcpServices({ homeDir: home, workspaceRoot: () => workspace });
    let host: McpHost | undefined;
    try {
      const config = { name: "Fake", transport: "stdio", command: process.execPath, args: ["server.mjs"], env: { DECLARED: "declared-value" } };
      const preview = await services.handle("mcp-servers/preview", "POST", { config });
      const fingerprint = (preview!.data as { approval: { fingerprint: string } }).approval.fingerprint;
      await services.handle("mcp-servers", "POST", { config, approvedFingerprint: fingerprint });
      // Disabled: nothing launches for missions.
      expect(await connectCustomMcpServers(undefined, workspace, { homeDir: home })).toBeUndefined();
      await services.handle("mcp-servers/custom-fake", "PATCH", { enabled: true, approvedFingerprint: fingerprint });
      const test = await services.handle("mcp-servers/custom-fake/test", "POST", {});
      expect(test!.data).toMatchObject({ ok: true, toolCount: 1, serverVersion: "9.9.9" });
      host = await connectCustomMcpServers(undefined, workspace, { homeDir: home });
      expect(host!.registeredTools().map(tool => tool.name)).toEqual(["mcp__custom-fake__probe"]);
      const result = await host!.callTool("mcp__custom-fake__probe", {});
      const out = JSON.parse((result.output as { text: string }).text);
      expect(out).toEqual({ declared: "declared-value", leaked: null, cwd: workspace });
    } finally { delete process.env.UNDECLARED_PARENT_SECRET; await host?.closeAll(); rmSync(home, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); }
  }, 30_000);
});

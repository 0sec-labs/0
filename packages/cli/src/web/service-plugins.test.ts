import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServicePluginConnections, ServicePluginServices, type ServicePluginConnection } from "./service-plugins.js";

vi.mock("../console-execution.js", () => ({ consoleExecutionProfile: () => "local" }));
describe("service plugin operator connections", () => {
  let homeDir: string;
  let services: ServicePluginServices;
  const probe = vi.fn(async (_connection: ServicePluginConnection) => ({ tools: [{ name: "github_list_repositories", description: "List repositories" }] }));
  const connect = (fields: unknown = { token: "private-test-token" }) => services.handle("service-plugins/github/connect", "POST", { approved: true, fields });
  beforeEach(() => { homeDir = mkdtempSync(join(tmpdir(), "zero-service-plugins-")); probe.mockReset(); probe.mockResolvedValue({ tools: [{ name: "github_list_repositories", description: "List repositories" }] }); services = new ServicePluginServices({ homeDir, probe }); });
  afterEach(() => rmSync(homeDir, { recursive: true, force: true }));
  it("lists all nine plugins without private credentials", async () => {
    const result = await services.handle("service-plugins", "GET", undefined);
    expect(result?.status).toBe(200);
    expect((result?.data as { items: unknown[] }).items).toHaveLength(9);
    expect(probe).not.toHaveBeenCalled();
  });
  it("probes before saving credentials and writes private permissions", async () => {
    const result = await connect();
    expect(result?.status).toBe(200);
    expect(probe).toHaveBeenCalledWith({ id: "github", enabled: true, fields: { token: "private-test-token" } });
    expect(JSON.stringify(result)).not.toContain("private-test-token");
    expect(loadServicePluginConnections(homeDir)).toEqual([{ id: "github", enabled: true, fields: { token: "private-test-token" } }]);
    expect(lstatSync(join(homeDir, ".0", "service-plugins.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(homeDir, ".0")).mode & 0o777).toBe(0o700);
  });
  it("rejects missing approval, unknown fields and malformed input before probing", async () => {
    expect((await services.handle("service-plugins/github/connect", "POST", { fields: { token: "test" } }))?.status).toBe(400);
    for (const fields of [null, [], { token: 12 }, { token: "test", endpoint: "https://evil.invalid" }, { token: "test\nheader" }, { token: "x".repeat(8193) }]) expect((await connect(fields))?.status).toBe(400);
    expect(probe).not.toHaveBeenCalled();
  });
  it("rejects unknown IDs and credential-bearing or unsafe URLs", async () => {
    expect((await services.handle("service-plugins/unknown/connect", "POST", { approved: true, fields: {} }))?.status).toBe(404);
    for (const url of ["http://external.invalid", "https://username:password@example.com", "https://example.com?token=secret", "https://example.com/#fragment"]) {
      const result = await services.handle("service-plugins/elastic/connect", "POST", { approved: true, fields: { token: "test", url } });
      expect(result?.status).toBe(400);
    }
    expect(probe).not.toHaveBeenCalled();
  });
  it("does not save a failed connection or leak provider error credentials", async () => {
    probe.mockRejectedValue(new Error("Bearer private-test-token https://user:password@example.com"));
    const result = await connect();
    expect(result?.status).toBe(409);
    expect(JSON.stringify(result)).not.toContain("private-test-token");
    expect(JSON.stringify(result)).not.toContain("password");
    expect(existsSync(join(homeDir, ".0", "service-plugins.json"))).toBe(false);
  });
  it("redacts echoed secrets in discovered tool descriptions", async () => {
    probe.mockResolvedValue({ tools: [{ name: "github_read", description: "Bearer private-test-token https://user:password@example.com" }] });
    const result = await connect();
    expect(result?.status).toBe(200);
    expect(JSON.stringify(result)).not.toContain("private-test-token");
    expect(JSON.stringify(result)).not.toContain("password");
  });
  it("preserves stored secrets on reconnect and preserves connection on failed replacement", async () => {
    await connect();
    expect((await connect({}))?.status).toBe(200);
    expect(probe.mock.calls[1]?.[0]).toMatchObject({ fields: { token: "private-test-token" } });
    probe.mockRejectedValue(new Error("replacement failed"));
    expect((await connect({ token: "replacement" }))?.status).toBe(409);
    expect(loadServicePluginConnections(homeDir)[0]?.fields.token).toBe("private-test-token");
  });
  it("persists disable without a network test and tests before re-enabling", async () => {
    await connect(); probe.mockClear();
    expect((await services.handle("service-plugins/github", "PATCH", { enabled: false }))?.status).toBe(200);
    expect(probe).not.toHaveBeenCalled();
    expect(loadServicePluginConnections(homeDir)[0]?.enabled).toBe(false);
    probe.mockRejectedValue(new Error("revoked"));
    expect((await services.handle("service-plugins/github", "PATCH", { enabled: true }))?.status).toBe(409);
    expect(loadServicePluginConnections(homeDir)[0]?.enabled).toBe(false);
  });
  it("exposes nonsecret URL configuration only and forgets a connection", async () => {
    const result = await services.handle("service-plugins/elastic/connect", "POST", { approved: true, fields: { token: "test", url: "https://elastic.example.com/" } });
    const item = (result?.data as { items: Array<{ id: string; values: object }> }).items.find((item) => item.id === "elastic");
    expect(item?.values).toEqual({ url: "https://elastic.example.com" });
    expect((await services.handle("service-plugins/elastic", "DELETE", undefined))?.status).toBe(200);
    expect(loadServicePluginConnections(homeDir)).toEqual([]);
  });
  it("refuses symlinked file and directory without exposing or modifying their targets", async () => {
    const target = join(homeDir, "target.json"); writeFileSync(target, "[]");
    mkdirSync(join(homeDir, ".0")); symlinkSync(target, join(homeDir, ".0", "service-plugins.json"));
    expect((await connect())?.status).toBe(500);
    expect(readFileSync(target, "utf8")).toBe("[]");
    rmSync(join(homeDir, ".0"), { recursive: true });
    const targetDirectory = join(homeDir, "directory"); mkdirSync(targetDirectory); symlinkSync(targetDirectory, join(homeDir, ".0"));
    expect((await connect())?.status).toBe(500);
    expect(existsSync(join(targetDirectory, "service-plugins.json"))).toBe(false);
  });
  it("fails closed on malformed persisted configuration and leaves it intact", async () => {
    mkdirSync(join(homeDir, ".0"));
    const path = join(homeDir, ".0", "service-plugins.json");
    writeFileSync(path, JSON.stringify([{ id: "github", enabled: true, fields: { token: 7 }, tools: [], testedAt: "now" }]));
    expect(() => loadServicePluginConnections(homeDir)).toThrow();
    expect((await services.handle("service-plugins", "GET", undefined))?.status).toBe(400);
    expect(readFileSync(path, "utf8")).toContain('"token":7');
  });
  it("does not intercept other operator routes", async () => {
    expect(await services.handle("plugins", "GET", undefined)).toBe(null);
  });
});

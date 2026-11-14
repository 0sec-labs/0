import { describe, expect, it } from "vitest";
import type { PluginItem } from "./contracts";
import type { McpServerEntry } from "./mcp-contract";
import { buildExploreEntries, buildPluginView, exploreCategories, exploreSections, paginate, parsePluginRef, permissionWording, pluginPath, sliceMore, type ServiceLike } from "./plugin-detail-model";

const plugin = (over: Partial<PluginItem> = {}): PluginItem => ({ id: "recon", kind: "plugin", name: "Recon", version: "1.2.0", description: "Maps a target.", capabilities: ["network", "filesystem-read", "mystery"], signature: "unverified", state: "available", loaded: false, error: null, ...over });
const mcp = (over: Partial<McpServerEntry> = {}): McpServerEntry => ({ id: "custom-1", name: "Docs", transport: "stdio", status: "untested", enabled: false, command: "npx", args: ["-y", "docs server"], envKeys: ["API_KEY"], headerNames: [], toolCount: 0, resourceCount: 0, skillCount: 0, tools: [], approved: false, ...over });
const service = (over: Partial<ServiceLike> = {}): ServiceLike => ({ id: "cloudflare", name: "Cloudflare", description: "Inspect zones.", category: "Cloud", docsUrl: "https://developers.cloudflare.com/x", configured: true, enabled: true, testedAt: null, tools: [{ name: "zones", description: "List zones" }], ...over });

describe("plugin refs", () => {
  it("round-trips kind:id and accepts a bare id", () => {
    expect(parsePluginRef(pluginPath({ kind: "mcp", id: "custom-1" })!.replace("/plugins/", ""))).toEqual({ kind: "mcp", id: "custom-1" });
    expect(parsePluginRef("cloudflare")).toEqual({ id: "cloudflare" });
    expect(parsePluginRef(undefined)).toBeNull();
    expect(parsePluginRef("%E0%A4%A")).toBeNull();
  });
});

describe("permission wording and slicing", () => {
  it("words known capabilities in plain English and passes unknown ones through", () => {
    expect(permissionWording("process-exec")).toBe("Run programs on this machine");
    expect(permissionWording("mystery")).toBe("mystery");
  });
  it("shows five rows and a View N more label", () => {
    const rows = Array.from({ length: 16 }, (_, i) => i);
    expect(sliceMore(rows)).toMatchObject({ hidden: 11, label: "View 11 more" });
    expect(sliceMore(rows).visible).toHaveLength(5);
    expect(sliceMore(rows, 5, true)).toMatchObject({ hidden: 0, label: null });
    expect(sliceMore([1, 2, 3]).label).toBeNull();
  });
});

describe("buildPluginView", () => {
  it("never marks an unsigned registry plugin verified", () => {
    const view = buildPluginView({ kind: "plugin", item: plugin() });
    expect(view.verified).toBe(false);
    expect(view.rail.find(entry => entry.label === "Verified by")).toBeUndefined();
    expect(view.status).toMatchObject({ label: "Not added", added: false });
    expect(view.permissions).toEqual(["Send and receive data over the network", "Read files in your workspace", "mystery"]);
    expect(view.reportUrl).toBeUndefined();
  });
  it("marks a signed plugin verified and shows Added when enabled", () => {
    const view = buildPluginView({ kind: "plugin", item: plugin({ signature: "verified", state: "enabled" }) });
    expect(view).toMatchObject({ verified: true, verifiedBy: "Registry signature", status: { label: "Added", added: true } });
  });
  it("shows repository and pinned sha for a GitHub install, with an issues link", () => {
    const view = buildPluginView({ kind: "plugin", item: plugin({ source: "github", repo: "acme/recon", sha: "0123456789abcdef0123", state: "installed" }) });
    expect(view.rail[0]).toMatchObject({ label: "Repository", value: "acme/recon @ 0123456789ab", href: "https://github.com/acme/recon" });
    expect(view.rail.find(entry => entry.label === "Made by")?.value).toBe("acme");
    expect(view.rail.find(entry => entry.label === "Version")?.value).toMatch(/pinned/);
    expect(view.reportUrl).toBe("https://github.com/acme/recon/issues");
    expect(view.status.label).toBe("Installed, off");
  });
  it("does not build links from a malformed repo string", () => {
    const view = buildPluginView({ kind: "plugin", item: plugin({ source: "github", repo: "javascript:alert(1)", sha: "abc" }) });
    expect(view.rail[0]!.href).toBeUndefined();
    expect(view.reportUrl).toBeUndefined();
  });
  it("describes a custom MCP server without ever exposing env values", () => {
    const view = buildPluginView({ kind: "mcp", item: mcp({ status: "ok", enabled: true, toolCount: 2, testedAt: "2026-05-01T10:00:00Z", tools: [{ name: "a", description: "" }, { name: "b", description: "" }] }) });
    expect(view.kindLabel).toBe("MCP server");
    expect(view.mcp).toMatchObject({ transport: "Command (stdio)", target: { label: "Command", value: 'npx -y "docs server"' }, envKeys: ["API_KEY"], lastTest: "Passed on 2026-05-01, 2 tools" });
    expect(view.status.added).toBe(true);
    expect(view.verified).toBe(false);
    expect(view.permissions[0]).toBe("Run a program on this machine as your user");
    expect(JSON.stringify(view)).not.toMatch(/secret/i);
  });
  it("uses the host for remote servers and reports a failed test", () => {
    const view = buildPluginView({ kind: "mcp", item: mcp({ transport: "http", command: undefined, url: "https://mcp.example.com/v1", status: "error", statusMessage: "401", enabled: true }) });
    expect(view.permissions[0]).toBe("Connect to mcp.example.com");
    expect(view.mcp?.lastTest).toBe("Failed: 401");
    expect(view.status.label).toBe("Needs attention");
  });
  it("treats built-in connectors as first-party and hides tools until connected", () => {
    expect(buildPluginView({ kind: "service", item: service() })).toMatchObject({ verified: true, verifiedBy: "0", status: { label: "Added", added: true } });
    const off = buildPluginView({ kind: "service", item: service({ configured: false }) });
    expect(off.status.label).toBe("Needs connection");
    expect(off.tools).toEqual([]);
  });
  it("drops a description that is only a list of tool ids", () => {
    expect(buildPluginView({ kind: "plugin", item: plugin({ description: "scan_a, scan_b" }) }).description).toBe("");
  });
});

describe("explore", () => {
  const entries = buildExploreEntries({
    plugins: [plugin(), plugin({ id: "gh", name: "Gh tool", source: "github", repo: "a/b", state: "installed" }), plugin({ id: "signed", name: "Signed", signature: "verified" })],
    services: [service(), service({ id: "slack", name: "Slack", category: "Messaging", configured: false })],
    mcp: [mcp()],
  });
  it("files each entry once under a derived category", () => {
    expect(exploreSections(entries).map(section => section.category)).toEqual(["Cloud", "Messaging", "Registry", "Installed"]);
    expect(entries).toHaveLength(6);
    expect(exploreCategories(entries)).toContain("Installed");
  });
  it("flags only signed plugins and built-ins as verified, and only registry plugins as installable", () => {
    expect(entries.filter(entry => entry.verified).map(entry => entry.name).sort()).toEqual(["Cloudflare", "Signed", "Slack"]);
    expect(entries.filter(entry => entry.installable).map(entry => entry.name).sort()).toEqual(["Recon", "Signed"]);
  });
  it("searches name, description and category", () => {
    expect(exploreSections(entries, "messaging").flatMap(section => section.entries.map(entry => entry.name))).toEqual(["Slack"]);
    expect(exploreSections(entries, "zones")[0]!.entries[0]!.name).toBe("Cloudflare");
    expect(exploreSections(entries, "", "Installed").flatMap(section => section.entries)).toHaveLength(2);
  });
  it("paginates only past 40 rows", () => {
    const rows = Array.from({ length: 85 }, (_, i) => i);
    expect(paginate(rows.slice(0, 40), 1).pages).toBe(1);
    expect(paginate(rows, 3)).toMatchObject({ page: 3, pages: 3 });
    expect(paginate(rows, 3).rows).toHaveLength(5);
    expect(paginate(rows, 99).page).toBe(3);
  });
});

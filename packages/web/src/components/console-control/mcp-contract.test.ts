import { describe, expect, it } from "vitest";
import { connectionsClient, isUnsupported, mcpClient, normalizeApproval, normalizeConnections, normalizeMcpServer, normalizeMcpServers, normalizeReview, normalizeTest, type FetchJson } from "./mcp-contract";

const recorder = (responses: Record<string, unknown>) => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetchJson = (async (path: string, init?: RequestInit) => { calls.push({ path, init }); const key = `${init?.method ?? "GET"} ${path}`; if (!(key in responses)) throw new Error("404 Not Found"); return responses[key]; }) as FetchJson;
  return { calls, fetchJson };
};

describe("isUnsupported", () => {
  it("recognises an old host and not real failures", () => {
    expect(isUnsupported(new Error("404 Not Found"))).toBe(true);
    expect(isUnsupported(new Error("Not found"))).toBe(true);
    expect(isUnsupported(new Error("owner_required"))).toBe(false);
    expect(isUnsupported("404")).toBe(false);
  });
});

describe("normalizeMcpServer", () => {
  it("never carries secrets and drops remote logos", () => {
    const item = normalizeMcpServer({ id: "custom-docs", name: "Docs", transport: "stdio", enabled: true, status: "ok", command: "npx", args: ["-y", 3], envKeys: ["API_KEY"], env: { API_KEY: "s3cret" }, toolCount: 2, tools: [{ name: "a", description: "d" }, { nope: 1 }], logo: "https://evil.example/x.png", fingerprint: "ff", approved: true });
    expect(item).toMatchObject({ id: "custom-docs", status: "ok", args: ["-y"], envKeys: ["API_KEY"], toolCount: 2, logo: undefined, approved: true });
    expect(item!.tools).toEqual([{ name: "a", description: "d" }]);
    expect(JSON.stringify(item)).not.toContain("s3cret");
  });
  it("defaults and rejects unusable rows", () => {
    expect(normalizeMcpServer({ id: "x" })).toBeNull();
    expect(normalizeMcpServer({ id: "custom-a", name: "A" })).toMatchObject({ enabled: false, status: "untested", transport: "stdio", skillCount: 0, toolCount: 0 });
    expect(normalizeMcpServers({ items: [{ id: "custom-a", name: "A", transport: "sse", logo: "data:image/svg+xml;base64,AAAA" }, 3] })).toHaveLength(1);
    expect(normalizeMcpServers(undefined)).toEqual([]);
  });
});

describe("approval, test and review payloads", () => {
  it("requires a fingerprint for approvals", () => {
    expect(() => normalizeApproval({})).toThrow(/approval/);
    expect(normalizeApproval({ approval: { fingerprint: "ab", transport: "stdio", summary: { command: "npx", args: ["-y"], envKeys: ["K"] }, warnings: ["w"] } })).toMatchObject({ fingerprint: "ab", warnings: ["w"], summary: { command: "npx", args: ["-y"], envKeys: ["K"], headerNames: [] } });
  });
  it("normalizes a test response", () => { expect(normalizeTest({ ok: true, toolCount: 1, resources: [{}, {}], tools: [{ name: "t" }] })).toMatchObject({ toolCount: 1, resourceCount: 2, tools: [{ name: "t", description: "" }] }); });
  it("requires review id, sha and permission hash", () => {
    expect(() => normalizeReview({ review: { sha: "a" } })).toThrow(/reviewable/);
    const review = normalizeReview({ review: { reviewId: "r", sha: "a".repeat(40), permissionHash: "h", repo: "o/n", ref: "main", id: "p", capabilities: ["network"], tools: [{ name: "t", capabilities: ["network"] }], alreadyInstalled: true } });
    expect(review).toMatchObject({ reviewId: "r", name: "p", capabilities: ["network"], alreadyInstalled: true });
  });
});

describe("mcpClient", () => {
  const config = { name: "Docs", transport: "stdio" as const, command: "npx", args: ["-y"], env: { K: "v" } };
  it("previews, then creates with the reviewed fingerprint", async () => {
    const { calls, fetchJson } = recorder({ "POST /api/console/mcp-servers/preview": { approval: { fingerprint: "fp" } }, "POST /api/console/mcp-servers": { item: { id: "custom-docs", name: "Docs" }, items: [] } });
    const client = mcpClient(fetchJson);
    const approval = await client.preview(config);
    const item = await client.create(config, approval.fingerprint, false);
    expect(item?.id).toBe("custom-docs");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ config });
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ config, approvedFingerprint: "fp", enable: false });
  });
  it("encodes ids and sends the approval with enable", async () => {
    const { calls, fetchJson } = recorder({ "PATCH /api/console/mcp-servers/custom-a%2Fb": {}, "POST /api/console/mcp-servers/custom-a%2Fb/test": { toolCount: 0 }, "DELETE /api/console/mcp-servers/custom-a%2Fb": {} });
    const client = mcpClient(fetchJson);
    await client.update("custom-a/b", { enabled: true, approvedFingerprint: "fp" });
    await client.test("custom-a/b"); await client.remove("custom-a/b");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ enabled: true, approvedFingerprint: "fp" });
    expect(calls).toHaveLength(3);
  });
  it("pins the reviewed commit and permissions when approving a GitHub plugin", async () => {
    const { calls, fetchJson } = recorder({ "POST /api/console/plugins/install-github": { review: { reviewId: "r", sha: "a".repeat(40), permissionHash: "h" } }, "POST /api/console/plugins/install-github/approve": { ok: true } });
    const client = mcpClient(fetchJson);
    await client.githubReview({ repo: "o/n", ref: "HEAD" });
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ repo: "o/n" });
    await client.githubApprove({ reviewId: "r", sha: "a".repeat(40), permissionHash: "h" });
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ reviewId: "r", sha: "a".repeat(40), permissionHash: "h", approved: true });
  });
  it("surfaces an old host as unsupported", async () => {
    const { fetchJson } = recorder({});
    await expect(mcpClient(fetchJson).list()).rejects.toSatisfy(isUnsupported);
  });
});

describe("connections", () => {
  const raw = { connections: [{ id: "openrouter:work", providerId: "openrouter", accountId: "work", kind: "api_key", label: "Work key", defaultLabel: "work", active: true, order: 1, disabledModels: ["x/y", 4], usage: { available: true, window: { limit: 10, remaining: 4 } } }, { id: "bad" }], spread: { openrouter: true, codex: "yes" } };
  it("normalizes labels, order, spread and usage", () => {
    const state = normalizeConnections(raw);
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({ label: "Work key", order: 1, disabledModels: ["x/y"], usage: { available: true } });
    expect(state.spread).toEqual({ openrouter: true, codex: false });
    expect(normalizeConnections(null)).toEqual({ connections: [], spread: {} });
  });
  it("sends rename, order, spread and model switches to the contract routes", async () => {
    const { calls, fetchJson } = recorder({ "PATCH /api/console/connections/openrouter%3Awork": raw, "PUT /api/console/connections/order": raw, "PUT /api/console/connections/spread": raw, "PUT /api/console/connections/openrouter%3Awork/models": {} });
    const client = connectionsClient(fetchJson);
    await client.rename("openrouter:work", null); await client.reorder("openrouter", ["work", "default"]); await client.spread("openrouter", true); await client.setDisabledModels("openrouter:work", ["x/y"]);
    expect(calls.map(call => JSON.parse(String(call.init!.body)))).toEqual([{ label: null }, { providerId: "openrouter", accountIds: ["work", "default"] }, { providerId: "openrouter", enabled: true }, { disabled: ["x/y"] }]);
  });
});

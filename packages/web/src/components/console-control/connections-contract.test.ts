import { describe, expect, it } from "vitest";
import { connectionsClient, isUnsupported, normalizeConnections, type FetchJson } from "./connections-contract";

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

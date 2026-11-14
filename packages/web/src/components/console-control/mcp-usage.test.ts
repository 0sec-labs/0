import { describe, expect, it } from "vitest";
import { connectionsClient, normalizeConnectionUsage, usageUnavailableNote } from "./mcp-contract";
import { usageBar } from "./mcp-model";

const openrouter = { usage: { available: true, source: "openrouter-key", reason: null, window: { kind: "credit-limit", limit: 10, remaining: 7.5, usedTotal: 2.5, usedDaily: 0.5, usedWeekly: null, usedMonthly: null, currency: "USD" } } };

describe("connection usage", () => {
  it("normalizes real OpenRouter usage into a bar", () => {
    const usage = normalizeConnectionUsage(openrouter);
    expect(usage.available).toBe(true);
    expect(usageBar(usage)?.usedPercent).toBe(25);
  });
  it("never fabricates numbers for providers that do not expose usage", () => {
    const usage = normalizeConnectionUsage({ usage: { available: false, source: null, window: null, reason: "not_exposed" } });
    expect(usage).toEqual({ available: false, window: null, reason: "not_exposed" });
    expect(usageBar(usage)).toBeNull();
    expect(usageUnavailableNote(usage.reason)).toBe("Usage isn't available for this provider.");
  });
  it("treats malformed or empty responses as unavailable", () => {
    expect(normalizeConnectionUsage(null).available).toBe(false);
    expect(normalizeConnectionUsage({ usage: { available: true, window: null } }).available).toBe(false);
    expect(usageUnavailableNote("provider_unreachable")).toMatch(/reach/);
    expect(usageUnavailableNote("mystery")).toBe(usageUnavailableNote("not_exposed"));
  });
  it("requests the whole connection id URL-encoded", async () => {
    const paths: string[] = [];
    const client = connectionsClient((async (path: string) => { paths.push(path); return openrouter; }) as never);
    await client.usage("openrouter:work key");
    expect(paths).toEqual(["/api/console/connections/openrouter%3Awork%20key/usage"]);
  });
});

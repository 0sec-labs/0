import { describe, expect, it, vi } from "vitest";
import { ConnectionHealthMonitor, classifyDiscoveryMessage, classifyStatus, probeProviderKey } from "./connection-health.js";

describe("health classification", () => {
  it("maps discovery outcomes", () => {
    expect(classifyDiscoveryMessage("deepseek", undefined)).toBe("ok");
    expect(classifyDiscoveryMessage("deepseek", "Model discovery failed (HTTP 401)")).toBe("rejected");
    expect(classifyDiscoveryMessage("xai", "HTTP 400 Incorrect API key")).toBe("rejected");
    expect(classifyDiscoveryMessage("deepseek", "HTTP 400 bad")).toBe("unknown");
    expect(classifyDiscoveryMessage("deepseek", "Model discovery cancelled.")).toBe("unreachable");
    expect(classifyDiscoveryMessage("deepseek", "could not reach host")).toBe("unreachable");
    expect(classifyDiscoveryMessage("openai", "HTTP 404")).toBe("unknown");
  });
  it("maps auth-probe statuses", () => {
    expect([200, 401, 403, 500].map(classifyStatus)).toEqual(["ok", "rejected", "rejected", "unknown"]);
  });
  it("never trusts a public catalog snapshot", async () => {
    const discover = vi.fn(async () => ({ models: [{ source: "catalog" }], diagnostics: [] }));
    expect(await probeProviderKey("deepseek", "k", undefined, {}, 1000, { discover })).toBe("unknown");
  });
  it("uses the authenticated endpoint where the model list is public", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    expect(await probeProviderKey("openrouter", "k", undefined, {}, 1000, { discover: vi.fn(), fetchImpl })).toBe("rejected");
  });
});

describe("health monitor", () => {
  it("probes lazily, caches for the ttl, re-probes when the key changes, and invalidates", async () => {
    let now = 0; const probe = vi.fn(async () => "ok" as const);
    const monitor = new ConnectionHealthMonitor(probe, () => now);
    expect(monitor.read("p", "a")).toMatchObject({ state: "unknown", checking: true });
    await monitor.settle(["p"]);
    expect(monitor.read("p", "a")).toMatchObject({ state: "ok", checking: false });
    now = 4 * 60_000; monitor.read("p", "a");
    expect(probe).toHaveBeenCalledTimes(1);
    monitor.read("p", "b"); expect(probe).toHaveBeenCalledTimes(2);
    await monitor.settle(["p"]);
    now = 10 * 60_000; monitor.read("p", "b"); expect(probe).toHaveBeenCalledTimes(3);
    await monitor.settle(["p"]); monitor.invalidate();
    expect(monitor.peek("p", "b")).toBe("unknown");
  });
  it("coalesces concurrent probes and treats a thrown probe as unknown", async () => {
    const probe = vi.fn(async () => { throw new Error("x"); });
    const monitor = new ConnectionHealthMonitor(probe as never);
    monitor.read("p", "a"); monitor.read("p", "a");
    await monitor.settle(["p"]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(monitor.peek("p", "a")).toBe("unknown");
  });
});

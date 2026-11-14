import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subagentBatchLimit, subagentConcurrency, subagentWorkerLimit } from "./subagent-limits.js";
import { AuditWorkerTree } from "./worker-tree.js";

const settings = [
  ["ZERO_SUBAGENT_MAX_FANOUT", subagentBatchLimit, 1024],
  ["ZERO_SUBAGENT_MAX_WORKERS", subagentWorkerLimit, 4096],
  ["ZERO_SUBAGENT_CONCURRENCY", subagentConcurrency, 32],
] as const;

beforeEach(() => { for (const [name] of settings) vi.stubEnv(name, undefined); });
afterEach(() => vi.unstubAllEnvs());

describe("swarm capacity configuration", () => {
  it("keeps batch capacity, audit capacity, and execution concurrency independent", () => {
    for (const [, resolve, fallback] of settings) expect(resolve()).toBe(fallback);
    vi.stubEnv("ZERO_SUBAGENT_MAX_FANOUT", "2000");
    vi.stubEnv("ZERO_SUBAGENT_MAX_WORKERS", "12000");
    vi.stubEnv("ZERO_SUBAGENT_CONCURRENCY", "128");
    expect(subagentBatchLimit()).toBe(2000);
    expect(subagentWorkerLimit()).toBe(12000);
    expect(subagentConcurrency()).toBe(128);
  });

  it.each(settings)("rejects malformed %s before it controls admission or execution", (name, resolve) => {
    for (const value of ["", " ", "0", "-1", "1.5", "Infinity", "NaN", "4workers", "9007199254740992"]) {
      vi.stubEnv(name, value);
      expect(resolve).toThrow(`${name} must be a positive safe integer`);
    }
  });

  it("admits a thousand registered workers and only discovers siblings under the same coordinator", () => {
    const tree = new AuditWorkerTree("audit");
    const coordinator = tree.acquire("coordinator", "audit");
    const leases = Array.from({ length: 1000 }, (_, index) => tree.acquire(`agent-${index}`, "coordinator"));
    expect(tree.peers("coordinator")).toHaveLength(1000);
    expect(tree.peers("audit")).toEqual(["coordinator"]);
    expect(tree.peers("unknown")).toEqual([]);
    leases[0]!.release();
    expect(tree.peers("coordinator")).not.toContain("agent-0");
    for (const lease of leases) lease.release();
    coordinator.release();
    expect(tree.hasLiveWorkers()).toBe(false);
  });

  it("honors configured audit capacity and removes stopping peers from discovery immediately", async () => {
    vi.stubEnv("ZERO_SUBAGENT_MAX_WORKERS", "2");
    const tree = new AuditWorkerTree("audit");
    const first = tree.acquire("first", "audit");
    const second = tree.acquire("second", "audit");
    expect(() => tree.acquire("third", "audit")).toThrow("Audit worker capacity reached (2)");
    const stopping = tree.stop("first");
    expect(first.signal.aborted).toBe(true);
    expect(tree.peers("audit")).toEqual(["second"]);
    first.release();
    await stopping;
    const third = tree.acquire("third", "audit");
    second.release();
    third.release();
    expect(tree.hasLiveWorkers()).toBe(false);
  });
});

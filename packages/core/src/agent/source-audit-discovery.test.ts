import { describe, expect, it, vi } from "vitest";
import { DeferredToolRegistry } from "./deferred-tools.js";
import { withLocalSourceBoundary } from "../scope/local-source-boundary.js";
import { ToolExecutor } from "./tools.js";
import type { ToolContext } from "./types.js";

describe("scoped source-audit deferred discovery", () => {
  it.each([
    { role: "audit", bounded: false },
    { role: "review", bounded: false },
    { role: "audit", bounded: true },
  ] as const)("allows metadata discovery for $role (source boundary=$bounded) without granting execution", async ({ role, bounded }) => {
    const registry = new DeferredToolRegistry();
    registry.seed(["spawn_agents", "bash"].map(name => ({ name, description: name, parameters: {}, required: [] })));
    const escalate = vi.fn<NonNullable<ToolContext["escalateScopedAudit"]>>(async () => false);
    const ctx: ToolContext & { deferredTools: DeferredToolRegistry } = {
      target: "local-source", scanId: "discovery-guard-test", findings: [], attackResults: [], targetInfo: {},
      role, scopePath: process.cwd(), autonomyMode: bounded ? "yolo" : "standard", deferredTools: registry,
      escalateScopedAudit: escalate,
    };
    await withLocalSourceBoundary(bounded ? process.cwd() : undefined, async () => {
    const executor = new ToolExecutor(ctx, null);
    const catalog = await executor.execute({ name: "list_tools", arguments: { query: "spawn_agents" } });
    expect(catalog.success).toBe(true);
    expect(catalog.output).toContain("spawn_agents");
    const loaded = await executor.execute({ name: "load_tool", arguments: { names: ["spawn_agents", "bash"] } });
    expect(loaded.success).toBe(true);
    expect(registry.isLoaded("spawn_agents")).toBe(true);
    expect(registry.isLoaded("bash")).toBe(true);
    expect(escalate).not.toHaveBeenCalled();

    // Loading a definition never grants execution authority. The normal guard
    // still handles the actual effectful call before dispatch.
    const result = await executor.execute({ name: "bash", arguments: { command: "this-command-must-never-execute" } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not available in a scoped source audit");
    expect(escalate).toHaveBeenCalledTimes(bounded ? 0 : 1);
    if (!bounded) expect(escalate.mock.calls[0]?.[0]).toMatchObject({ call: { name: "bash" } });
    });
  });
});

import { describe, expect, it } from "vitest";
import { ToolExecutor, TOOL_DEFINITIONS, getToolsForRole } from "../tools.js";
import type { ToolContext } from "../types.js";
import { VISUALIZATION_LIMITS } from "../../shared/visualization.js";

function executor(): ToolExecutor {
  const ctx: ToolContext = { target: "https://example.com", scanId: "viz-test", findings: [], attackResults: [], targetInfo: {} };
  let n = 0;
  return new ToolExecutor(ctx, null, () => `id${++n}`);
}
const args = {
  kind: "attack-graph",
  title: "Path",
  summary: "A reaches B.",
  spec: { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] },
};

describe("visualize tool", () => {
  it("is registered, advertised to every role, and not echoed to the model", async () => {
    expect(TOOL_DEFINITIONS.visualize).toBeDefined();
    for (const role of ["attack", "audit", "review"]) expect(getToolsForRole(role).map((t) => t.name)).toContain("visualize");
    const result = await executor().execute({ name: "visualize", arguments: args });
    expect(result.success).toBe(true);
    expect(result.meta?.kind).toBe("visual");
    expect(result.meta?.visual).toMatchObject({ id: "viz-id1", version: 1, kind: "attack-graph", title: "Path" });
    // The model-facing output carries no spec.
    expect(JSON.stringify(result.output)).not.toContain('"nodes"');
  });

  it("returns an actionable error instead of throwing on invalid or hostile specs", async () => {
    const ex = executor();
    const bad = await ex.execute({ name: "visualize", arguments: { ...args, spec: { nodes: [{ id: "a", label: "<script>x</script>" }] } } });
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/nodes\.0\.label.*HTML/);
    expect((await ex.execute({ name: "visualize", arguments: { kind: "table" } })).success).toBe(false);
  });

  it("enforces the per-session quota", async () => {
    const ex = executor();
    for (let i = 0; i < VISUALIZATION_LIMITS.perSession; i++) expect((await ex.execute({ name: "visualize", arguments: args })).success).toBe(true);
    const over = await ex.execute({ name: "visualize", arguments: args });
    expect(over.success).toBe(false);
    expect(over.error).toMatch(/quota/);
  });
});

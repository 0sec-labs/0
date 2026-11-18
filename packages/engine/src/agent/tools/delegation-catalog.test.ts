import { describe, expect, it } from "vitest";
import { getToolsForRole } from "../tools.js";
import { toNativeToolDef } from "../native-tooldef.js";
import { TOOL_DEFINITIONS } from "./index.js";

describe("public delegation catalog", () => {
  it("offers one delegation tool, spawn_agent, and no read-only switch", () => {
    const names = getToolsForRole().map(tool => tool.name);
    expect(names).toContain("spawn_agent");
    for (const gone of ["spawn_agents", "spawn_persistent_agent", "monitor"]) expect(names).not.toContain(gone);
    const schema = JSON.stringify(toNativeToolDef(TOOL_DEFINITIONS.spawn_agent!).input_schema);
    expect(schema).not.toMatch(/read_only|read-only/);
  });

  it("offers a typed per-task tool allowlist in every delegation shape", () => {
    const single = toNativeToolDef(TOOL_DEFINITIONS.spawn_agent!).input_schema.properties;
    const tasks = single.tasks as { items: { properties: Record<string, unknown> } };
    for (const properties of [single, tasks.items.properties]) {
      expect(properties.allowed_tools).toMatchObject({ type: "array", items: { type: "string" } });
    }
  });

  it("keeps workspace identity contracts in both single and batch native schemas", () => {
    const native = toNativeToolDef(TOOL_DEFINITIONS.spawn_agent!);
    expect(native.input_schema.required).not.toContain("task");
    const single = native.input_schema.properties.expected_workspace as Record<string, unknown>;
    expect(single.required).toEqual(["path", "head"]);
    expect(single.additionalProperties).toBe(false);
    const tasks = native.input_schema.properties.tasks as { items: { required: string[]; properties: Record<string, unknown> } };
    expect(tasks.items.required).toEqual(["task"]);
    expect(tasks.items.properties.expected_workspace).toEqual(single);
    expect(native.input_schema.properties.wait).toMatchObject({ type: "boolean" });
    expect(native.input_schema.properties.agent_id).toMatchObject({ type: "string" });
    expect(native.input_schema.properties).not.toHaveProperty("max_turns");
    expect(tasks.items.properties).not.toHaveProperty("max_turns");
  });
});

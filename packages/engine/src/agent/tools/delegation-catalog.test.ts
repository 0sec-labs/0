import { describe, expect, it } from "vitest";
import { toNativeToolDef } from "../native-tooldef.js";
import { TOOL_DEFINITIONS } from "./index.js";

describe("public delegation catalog", () => {
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
  });
});

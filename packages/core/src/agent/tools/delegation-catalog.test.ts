import { describe, expect, it } from "vitest";
import { getToolsForRole } from "../tools.js";
import { toNativeToolDef } from "../native-tooldef.js";
import { TOOL_DEFINITIONS, LEGACY_DELEGATION_TOOL_NAMES } from "./index.js";
import { TOOL_DISPATCH } from "./dispatch.js";

describe("public delegation catalog", () => {
  it("offers one delegation tool while retaining legacy dispatch compatibility", () => {
    for (const role of ["audit", "review"]) {
      for (const hasScope of [false, true]) {
        const names = getToolsForRole(role, { hasScope }).map(tool => tool.name);
        expect(names).toContain("spawn_agent");
        for (const alias of LEGACY_DELEGATION_TOOL_NAMES) expect(names).not.toContain(alias);
      }
    }
    for (const alias of LEGACY_DELEGATION_TOOL_NAMES) {
      expect(TOOL_DEFINITIONS[alias]).toBeDefined();
      expect(TOOL_DISPATCH[alias]).toBeDefined();
    }
  });

  it("offers typed per-task tool and HTTP-method policies in every delegation shape", () => {
    const single = toNativeToolDef(TOOL_DEFINITIONS.spawn_agent!).input_schema.properties;
    const tasks = single.tasks as { items: { properties: Record<string, unknown> } };
    const legacy = toNativeToolDef(TOOL_DEFINITIONS.spawn_agents!).input_schema.properties.tasks as { items: { properties: Record<string, unknown> } };
    const persistent = toNativeToolDef(TOOL_DEFINITIONS.spawn_persistent_agent!).input_schema.properties;
    for (const properties of [single, tasks.items.properties, legacy.items.properties, persistent]) {
      expect(properties.allowed_tools).toMatchObject({ type: "array", items: { type: "string" } });
      expect(properties.allowed_http_methods).toMatchObject({ type: "array", items: { type: "string", enum: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH"] } });
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

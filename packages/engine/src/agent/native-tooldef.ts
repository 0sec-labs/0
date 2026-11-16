import type { NativeToolDef } from "../runtime/types.js";
import type { ToolDefinition } from "./types.js";

/**
 * Convert a registry `ToolDefinition` to the runtime's native tool schema.
 *
 * Shared by the console turn engine (`console/turn-engine.ts`) and the native
 * agent loop (`agent/native-loop.ts`) so the two cannot drift. They previously
 * kept private copies, and the console copy had dropped `param.items` — which
 * silently mis-described array-typed tool parameters to the model. Keep this the
 * single source of truth.
 */
export function toNativeToolDef(tool: ToolDefinition): NativeToolDef {
  const properties: Record<string, unknown> = {};
  for (const [key, param] of Object.entries(tool.parameters)) {
    const prop: Record<string, unknown> = { type: param.type, description: param.description };
    if (param.enum) prop.enum = param.enum;
    if (param.items) prop.items = param.items;
    if (param.properties) prop.properties = param.properties;
    if (param.required) prop.required = param.required;
    if (param.additionalProperties !== undefined) prop.additionalProperties = param.additionalProperties;
    properties[key] = prop;
  }
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { type: "object", properties, required: tool.required ?? [] },
  };
}

/** Pure: an input schema as the model may see it. Everything the server wrote is clamped plain text; nothing is trusted. */
import { isToolName, safeText } from "./sanitize.js";

const MAX_DEPTH = 5;
const MAX_KEYS = 40;
const MAX_TEXT = 200;
const TEXTY = new Set(["description", "title", "default", "examples", "example", "const", "pattern", "format", "$comment"]);

function clean(value: unknown, depth: number): unknown {
  if (typeof value === "string") return safeText(value, MAX_TEXT);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= MAX_DEPTH || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map(v => clean(v, depth + 1)).filter(v => v !== undefined);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
    if (k === "$ref" || k === "$defs" || k === "definitions") continue;
    const key = safeText(k, 64); if (!key) continue;
    const c = TEXTY.has(k) && typeof v !== "string" ? safeText(JSON.stringify(v) ?? "", MAX_TEXT) : clean(v, depth + 1);
    if (c !== undefined) out[key] = c;
  }
  return out;
}

/** `properties` with names validated like tool names, and every nested description, enum value and default sanitised and clamped. */
export function sanitizeProperties(properties: unknown): Record<string, unknown> {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(properties as Record<string, unknown>).slice(0, MAX_KEYS)) if (isToolName(name)) { const c = clean(schema, 1); if (c !== undefined) out[name] = c; }
  return out;
}

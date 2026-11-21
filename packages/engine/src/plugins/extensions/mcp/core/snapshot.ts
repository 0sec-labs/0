/**
 * Pure: a small, plain-text picture of what a tool says about itself, kept when the operator approves so the next
 * approval prompt can show WHAT changed instead of only that a hash differs. Display only: the hash stays the authority.
 */
import { isToolName, safeText } from "./sanitize.js";
import type { McpToolInfo } from "./tool-hash.js";

export interface ToolSnapshot { readonly description: string; readonly params: Readonly<Record<string, string>>; readonly required: readonly string[] }
export type ToolSnapshots = Readonly<Record<string, ToolSnapshot>>;

const typeOf = (schema: unknown): string => {
  const t = schema && typeof schema === "object" ? (schema as { type?: unknown }).type : undefined;
  return safeText(Array.isArray(t) ? t.join("|") : typeof t === "string" ? t : "any", 24) || "any";
};

export function snapshotOf(tools: readonly McpToolInfo[]): ToolSnapshots {
  const out: Record<string, ToolSnapshot> = {};
  for (const t of tools.slice(0, 200)) {
    if (!isToolName(t.name)) continue;
    const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema as { properties?: unknown; required?: unknown } : {};
    const props = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? Object.entries(schema.properties as Record<string, unknown>).filter(([k]) => isToolName(k)).slice(0, 40) : [];
    Object.defineProperty(out, t.name, {
      value: {
        description: safeText(t.description, 300),
        params: Object.fromEntries(props.map(([k, v]) => [k, typeOf(v)])),
        required: (Array.isArray(schema.required) ? schema.required.filter((r): r is string => isToolName(r)) : []).slice(0, 40).sort(),
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

const clamp = (s: string, n: number) => safeText(s, n) || "(empty)";
const names = (list: readonly string[]) => (list.length ? list.slice(0, 6).join(", ") + (list.length > 6 ? ` and ${list.length - 6} more` : "") : "none");

/** One schema-change sentence: parameters added, removed, retyped, and the required set. Empty when equal. */
export function schemaChange(before: ToolSnapshot, after: ToolSnapshot): string {
  const b = Object.keys(before.params); const a = Object.keys(after.params);
  const parts = [
    a.filter(k => !b.includes(k)).length ? `adds ${names(a.filter(k => !b.includes(k)).map(k => `${k}:${after.params[k]}`))}` : "",
    b.filter(k => !a.includes(k)).length ? `removes ${names(b.filter(k => !a.includes(k)))}` : "",
    a.filter(k => b.includes(k) && before.params[k] !== after.params[k]).length ? `retypes ${names(a.filter(k => b.includes(k) && before.params[k] !== after.params[k]).map(k => `${k} ${before.params[k]}->${after.params[k]}`))}` : "",
    before.required.join(",") !== after.required.join(",") ? `required becomes ${names(after.required)}` : "",
  ].filter(Boolean);
  return parts.join("; ");
}

/** Lines for the prompt: every changed tool as an old-versus-new description and schema summary, new and removed tools by name. */
export function changeLines(previous: ToolSnapshots | undefined, current: ToolSnapshots, review: { changed: readonly string[]; added: readonly string[]; removed: readonly string[] }): string[] {
  const shown = (list: readonly string[]) => list.filter(isToolName);
  const lines: string[] = [];
  for (const name of shown(review.changed).slice(0, 8)) {
    const was = previous && Object.hasOwn(previous, name) ? previous[name] : undefined;
    const now = Object.hasOwn(current, name) ? current[name] : undefined;
    if (!now) { lines.push(`changed ${name}: its new definition has details that cannot be shown safely`); continue; }
    if (!was) { lines.push(`changed ${name}: no earlier text is on record. Now: "${clamp(now.description, 160)}"`); continue; }
    const schema = schemaChange(was, now);
    const text = was.description === now.description ? "description unchanged" : `description was "${clamp(was.description, 160)}" and now reads "${clamp(now.description, 160)}"`;
    lines.push(`changed ${name}: ${text}${schema ? `; schema ${schema}` : was.description === now.description ? "; only annotations or schema details changed" : ""}`);
  }
  for (const name of shown(review.added).slice(0, 8)) { const now = Object.hasOwn(current, name) ? current[name] : undefined; lines.push(`new ${name}: "${clamp(now?.description ?? "", 160)}"${now && Object.keys(now.params).length ? ` (takes ${names(Object.entries(now.params).map(([k, v]) => `${k}:${v}`))})` : ""}`); }
  if (review.removed.length) lines.push(`removed: ${names(shown(review.removed))}`);
  const hidden = review.changed.length + review.added.length - shown(review.changed).length - shown(review.added).length;
  if (hidden > 0) lines.push(`${hidden} tool(s) have names that are not valid tool names and are not shown`);
  return lines;
}

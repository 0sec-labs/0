/**
 * Read-only view of an extension's MCP servers for the Extensions page and `0 skills extensions info`: what the operator
 * approved (pins) against what each server showed the last time it connected. Connects to nothing.
 */
import type { ExtensionManifest } from "../core/manifest.js";
import type { McpPinRecord } from "../core/state.js";
import { reviewHashes } from "./core/review.js";
import type { McpObservation } from "./ports.js";

export interface McpToolStatus { name: string; approvedHash: string | null; seenHash: string | null; state: "approved" | "changed" | "new" | "removed" | "unreviewed" }
export interface McpServerStatus {
  server: string; transport: string; target: string;
  /** `not-connected`: never started, nothing approved. `approved`: matches. `needs-approval`: changed, new or removed tools (or never approved). */
  state: "not-connected" | "approved" | "needs-approval";
  /** One line, empty when fine. */
  reason: string; tools: McpToolStatus[]; seenAt: string | null;
}

export function mcpServerStatuses(manifest: ExtensionManifest, pins: Readonly<Record<string, McpPinRecord>>, observed: Readonly<Record<string, McpObservation>>): McpServerStatus[] {
  return manifest.mcpServers.map((decl): McpServerStatus => {
    const approved = pins[decl.name]?.tools; const seen = observed[decl.name];
    const base = { server: decl.name, transport: decl.transport, target: decl.url ?? [decl.command, ...decl.args].join(" ") };
    if (!seen) return { ...base, state: approved ? "approved" : "not-connected", reason: approved ? "" : "not started yet: its tools are reviewed the first time it connects", seenAt: null, tools: Object.entries(approved ?? {}).map(([name, hash]) => ({ name, approvedHash: hash, seenHash: null, state: "approved" })) };
    const blocked = typeof seen.blocked === "string" && seen.blocked.length > 0;
    const review = blocked && seen.review ? seen.review : reviewHashes(approved, seen.tools);
    const stateOf = (n: string): McpToolStatus["state"] => (review.changed.includes(n) ? "changed" : review.added.includes(n) ? (approved ? "new" : "unreviewed") : review.removed.includes(n) ? "removed" : "approved");
    const names = [...new Set([...Object.keys(seen.tools), ...Object.keys(approved ?? {})])].sort();
    return { ...base, state: blocked || review.needsApproval ? "needs-approval" : "approved", reason: blocked ? (seen.blocked ?? review.reason) : review.reason, seenAt: seen.at, tools: names.map(name => ({ name, approvedHash: approved && Object.hasOwn(approved, name) ? approved[name]! : null, seenHash: Object.hasOwn(seen.tools, name) ? seen.tools[name]! : null, state: stateOf(name) })) };
  });
}

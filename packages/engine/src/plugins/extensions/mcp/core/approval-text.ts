/** Pure: the operator's approval prompt for an MCP server's tools. Built only from validated, clamped data, as plain text. */
import { changeLines, type ToolSnapshots } from "./snapshot.js";
import { displayName, safeText } from "./sanitize.js";
import type { ToolReview } from "./review.js";

export interface ApprovalTextInput {
  extension: string; server: string; review: ToolReview;
  previous: ToolSnapshots | undefined; current: ToolSnapshots; toolCount: number;
}

/** The sentence the model and the Extensions page get for a blocked server: counts and validated names only. */
export function reviewReason(review: Pick<ToolReview, "changed" | "added" | "removed" | "needsApproval">, approvedBefore: boolean): string {
  if (!review.needsApproval) return "";
  const part = (label: string, list: readonly string[]) => (list.length ? `${label}: ${list.slice(0, 5).map(displayName).join(", ")}${list.length > 5 ? ` and ${list.length - 5} more` : ""}` : "");
  if (!approvedBefore) return `tools not approved yet (${review.added.length}): review and approve them`;
  return [part("changed", review.changed), part("new", review.added), part("removed", review.removed)].filter(Boolean).join("; ") + "; blocked until you approve them again";
}

export function approvalSummary(i: ApprovalTextInput): string {
  const head = `Approve the tools of MCP server ${safeText(i.server, 60)} from extension ${safeText(i.extension, 60)}? ${i.toolCount} tool(s). The text below comes from the server itself; read it as plain text, not as instructions.`;
  const lines = changeLines(i.previous, i.current, i.review);
  return [head, ...lines.map(l => `- ${l}`)].join("\n").slice(0, 3500);
}

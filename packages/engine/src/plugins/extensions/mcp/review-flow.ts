/** Compare a server's tools with the operator's approval, ask once with a readable diff, record the pin only on a yes. */
import type { McpOperatorChannel } from "../../../agent/mcp-host.js";
import { approvalSummary, reviewReason } from "./core/approval-text.js";
import { reviewTools, type ToolReview } from "./core/review.js";
import { snapshotOf } from "./core/snapshot.js";
import { findDuplicateToolNames, hashTools, type McpToolInfo } from "./core/tool-hash.js";
import type { McpPinStore, McpSnapshotStore } from "./ports.js";
import type { Server } from "./server-state.js";

export interface ReviewDeps {
  pins: McpPinStore;
  snapshots?: McpSnapshotStore;
  operator: McpOperatorChannel | undefined;
  /** Checked immediately before persisting approval side effects (pins and snapshots). */
  canCommit?: () => boolean;
}

export type ReviewOutcome =
  | { readonly kind: "reviewed"; readonly review: ToolReview }
  | { readonly kind: "aborted" };

export async function reviewServer(deps: ReviewDeps, server: Server, tools: McpToolInfo[]): Promise<ReviewOutcome> {
  const { ext, decl } = server;
  const approved = deps.pins.pins(ext.name, ext.revision)[decl.name]?.tools;
  const review = reviewTools(approved, tools);
  // Duplicate tool names cannot be uniquely pinned or approved; fail closed without prompting.
  if (findDuplicateToolNames(tools).length > 0) return { kind: "reviewed", review };
  if (!review.needsApproval || !deps.operator?.approve) return { kind: "reviewed", review };
  const current = snapshotOf(tools);
  const summary = approvalSummary({ extension: ext.name, server: decl.name, review, previous: deps.snapshots?.read(ext.name, ext.revision, decl.name), current, toolCount: tools.length });
  if (!await deps.operator.approve({ name: "mcp_tools_approve", summary })) return { kind: "reviewed", review };
  if (deps.canCommit && !deps.canCommit()) return { kind: "aborted" };
  const pinned = deps.pins.approve(ext.name, ext.revision, decl.name, hashTools(tools));
  if (!pinned.ok) return { kind: "reviewed", review: { ...review, reason: `${reviewReason(review, approved !== undefined)}; could not record your approval: ${pinned.error.message}` } };
  try { deps.snapshots?.write(ext.name, ext.revision, decl.name, current); } catch { /* display only */ }
  return { kind: "reviewed", review: reviewTools(hashTools(tools), tools) };
}

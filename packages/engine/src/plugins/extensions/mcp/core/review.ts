/** Pure: compare the tools a server shows now with the hashes the operator approved. Fail closed. */
import type { McpToolInfo } from "./tool-hash.js";
import { findDuplicateToolNames, hashTools } from "./tool-hash.js";
import { reviewReason } from "./approval-text.js";
import { displayName } from "./sanitize.js";

export interface ToolReview {
  /** Tools whose hash matches the approval: the only ones that may be advertised or called. */
  readonly allowed: readonly string[];
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** True when anything is changed, new or removed (or nothing was ever approved): the operator must approve again. */
  readonly needsApproval: boolean;
  /** One line for the model, the operator and the Extensions page; empty when everything matches. */
  readonly reason: string;
}

/**
 * `pinned` is undefined when the operator never approved this server's tools: every tool is then New. A tool that is
 * changed, new or removed is not callable until the operator approves again, and a server that rewrote one tool is not
 * trusted for the rest: nothing is allowed while anything differs.
 */
export function reviewHashes(pinned: Readonly<Record<string, string>> | undefined, current: Readonly<Record<string, string>>): ToolReview {
  const names = Object.keys(current).sort();
  if (!pinned) return { allowed: [], changed: [], added: names, removed: [], needsApproval: true, reason: reviewReason({ changed: [], added: names, removed: [], needsApproval: true }, false) };
  const changed = names.filter(n => Object.hasOwn(pinned, n) && pinned[n] !== current[n]);
  const added = names.filter(n => !Object.hasOwn(pinned, n));
  const removed = Object.keys(pinned).filter(n => !Object.hasOwn(current, n)).sort();
  const needsApproval = changed.length + added.length + removed.length > 0;
  const reason = reviewReason({ changed, added, removed, needsApproval }, true);
  return { allowed: needsApproval ? [] : names, changed, added, removed, needsApproval, reason };
}

export function reviewTools(pinned: Readonly<Record<string, string>> | undefined, current: readonly McpToolInfo[]): ToolReview {
  const duplicates = findDuplicateToolNames(current);
  if (duplicates.length > 0) {
    const shown = duplicates.slice(0, 5).map(displayName).join(", ");
    const suffix = duplicates.length > 5 ? ` and ${duplicates.length - 5} more` : "";
    return {
      allowed: [],
      changed: duplicates,
      added: [],
      removed: [],
      needsApproval: true,
      reason: `duplicate tool names (${shown}${suffix}); refused`,
    };
  }
  return reviewHashes(pinned, hashTools(current));
}

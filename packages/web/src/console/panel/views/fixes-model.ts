import type { Workflow, WebFix } from "@/components/console-control/contracts";

/**
 * There is no `GET /api/console/fixes` list route. Fix records are only reachable through
 * `GET /api/console/workflows?sessionId=` (jobs of kind `fix-*` carry `result.fix`), so the list is derived from workflows.
 */
export const FIXES_WORKFLOWS_PATH = (sessionId: string) => `/api/console/workflows?sessionId=${encodeURIComponent(sessionId)}`;
const ACTIVE_WORKFLOW = new Set(["queued", "running", "cancelling"]);
export const isActiveWorkflow = (status: string) => ACTIVE_WORKFLOW.has(status);

export type FixStage = "pr-opened" | "applied" | "retested" | "proposed" | "prepared" | "ineligible";
export const FIX_STAGE_LABEL: Record<FixStage, string> = {
  "pr-opened": "PR opened", applied: "Applied", retested: "Re-tested", proposed: "Proposed", prepared: "Prepared", ineligible: "Not fixable",
};

export function fixStage(fix: WebFix): FixStage {
  if (fix.published?.prUrl) return "pr-opened";
  if (fix.applied || fix.application?.applied) return "applied";
  if (fix.verification) return "retested";
  if (fix.result) return "proposed";
  return fix.eligible ? "prepared" : "ineligible";
}

/** Capy-style tab buckets: open work, ready to merge (PR opened), finished (applied locally). */
export type FixBucket = "open" | "ready" | "applied";
export function fixBucket(stage: FixStage): FixBucket {
  return stage === "pr-opened" ? "ready" : stage === "applied" ? "applied" : "open";
}

export type PanelFix = { fix: WebFix; workflowId: string; updatedAt: string; active: boolean };

/** Fixes for one chat, one entry per fix id (latest workflow wins), newest first. */
export function fixesFromWorkflows(workflows: readonly Workflow[] | undefined, sessionId: string | undefined): PanelFix[] {
  if (!workflows || !sessionId) return [];
  const byId = new Map<string, PanelFix>();
  for (const workflow of workflows) {
    const fix = workflow.result?.fix;
    if (!workflow.kind.startsWith("fix-") || !fix || fix.sessionId !== sessionId) continue;
    const entry = { fix, workflowId: workflow.id, updatedAt: workflow.updatedAt, active: isActiveWorkflow(workflow.status) || Boolean(fix.activeWorkflowId) };
    const existing = byId.get(fix.id);
    if (!existing || existing.updatedAt <= entry.updatedAt) byId.set(fix.id, entry);
  }
  return [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** The diff worth showing: published branch diff, then applied, verified, proposed. */
export function fixDiffText(fix: WebFix): string {
  return fix.publication?.diff || fix.application?.diff || fix.verification?.diff || fix.result?.diff || "";
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";
export type DiffLine = { kind: DiffLineKind; text: string };

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity ") || line.startsWith("rename ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

export const MAX_DIFF_LINES = 1500;
export function parseDiff(diff: string): { lines: DiffLine[]; added: number; removed: number; files: string[]; truncated: boolean } {
  const all = diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (!diff.trim()) return { lines: [], added: 0, removed: 0, files: [], truncated: false };
  let added = 0, removed = 0;
  const files: string[] = [];
  const lines: DiffLine[] = [];
  for (const text of all) {
    const kind = classifyDiffLine(text);
    if (kind === "add") added++;
    else if (kind === "del") removed++;
    else if (kind === "meta" && text.startsWith("+++ ")) {
      const path = text.slice(4).replace(/^b\//, "").trim();
      if (path && path !== "/dev/null") files.push(path);
    }
    if (lines.length < MAX_DIFF_LINES) lines.push({ kind, text });
  }
  return { lines, added, removed, files, truncated: all.length > MAX_DIFF_LINES };
}

/** Only https URLs without credentials are opened; anything else is treated as no PR link. */
export function safePrUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
export function prLabel(url: string): string {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? `#${match[1]}` : "Pull request";
}

export const countLabel = (count: number, singular: string) => `${count} ${singular}${count === 1 ? "" : "s"}`;

import type { SecurityWorkflowExecution } from "./security-workflows.js";
import { z } from "zod";

export const RunRecordSchema = z.object({
  id: z.string().min(1), kind: z.enum(["workflow", "scan"]), title: z.string(), target: z.string(),
  status: z.string(), createdAt: z.string(), updatedAt: z.string(),
  conversation: z.object({ sessionId: z.string().min(1) }).strict().nullable(),
  native: z.object({ workflowExecutionId: z.string().optional(), workflowId: z.string().optional(),
    jobId: z.string().optional(), scanIds: z.array(z.string()) }).strict(),
}).strict();

/** A read model, not a new executor or a replacement for native evidence. */
export interface RunRecord {
  id: string;
  kind: "workflow" | "scan";
  title: string;
  target: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  /** Conversation identity is explicit; a scan ID is never a session ID. */
  conversation: { sessionId: string } | null;
  native: { workflowExecutionId?: string; workflowId?: string; jobId?: string; scanIds: string[] };
}

export interface RunScanSource {
  id: string;
  target: string;
  status: string;
  startedAt: string;
  completedAt?: string | null;
}

// Historical standalone CLI producers used this owner sentinel without a chat.
// New records carry explicit nullable conversation provenance instead.
const legacyStandaloneWorkflowIds = new Set(["cli-scan", "cli-review", "cli-audit", "cli-fix", "cli-verify", "cli-research", "cli-deep-review"]);
function conversationForExecution(execution: SecurityWorkflowExecution): RunRecord["conversation"] {
  if (execution.conversationSessionId !== undefined) return execution.conversationSessionId ? { sessionId: execution.conversationSessionId } : null;
  if (execution.sessionId === "cli" && !execution.jobId && legacyStandaloneWorkflowIds.has(execution.workflowId)) return null;
  return execution.sessionId ? { sessionId: execution.sessionId } : null;
}

/** Fold child scans into their workflow, retaining every native evidence link. */
export function buildRunRecords(workflows: readonly SecurityWorkflowExecution[], scans: readonly RunScanSource[]): RunRecord[] {
  const linkedScans = new Set<string>();
  const records: RunRecord[] = workflows.map(execution => {
    const scanIds = [...new Set(Object.values(execution.nodeResults).flatMap(result => [
      ...(result.scanId ? [result.scanId] : []), ...(result.scanIds ?? []),
    ]))];
    for (const scanId of scanIds) linkedScans.add(scanId);
    return {
      id: `workflow:${execution.id}`, kind: "workflow", title: execution.workflow.name,
      target: execution.workflow.target, status: execution.status,
      createdAt: execution.createdAt, updatedAt: execution.updatedAt,
      conversation: conversationForExecution(execution),
      native: { workflowExecutionId: execution.id, workflowId: execution.workflowId,
        ...(execution.jobId ? { jobId: execution.jobId } : {}), scanIds },
    };
  });
  for (const scan of scans) {
    if (linkedScans.has(scan.id)) continue;
    records.push({ id: `scan:${scan.id}`, kind: "scan", title: scan.target,
      target: scan.target, status: scan.status, createdAt: scan.startedAt,
      updatedAt: scan.completedAt ?? scan.startedAt, conversation: null, native: { scanIds: [scan.id] } });
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

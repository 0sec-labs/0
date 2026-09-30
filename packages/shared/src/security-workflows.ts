import { z } from "zod";
import type { ScanPlan } from "./types.js";

/** Saving a definition is a draft operation, never permission to execute it. */
export const DEFAULT_SECURITY_WORKFLOW_PLAN: Readonly<ScanPlan> = Object.freeze({ goal: "known-vulnerabilities", depth: "default", runCount: 1, executionMode: "sequential", timeCapMs: 600_000, costCapUsd: 5 });
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !["__proto__", "constructor", "prototype"].includes(value), "Reserved identifier.");
const planSchema = z.object({
  goal: z.enum(["known-vulnerabilities", "unknown-vulnerabilities", "misconfigurations"]),
  depth: z.enum(["quick", "default", "deep"]), runCount: z.number().int().min(1).max(16),
  executionMode: z.enum(["sequential", "parallel"]), timeCapMs: z.number().int().finite().positive().max(86_400_000), costCapUsd: z.number().finite().positive().max(1000),
}).strict();
const nodeSchema = z.object({ id: identifier, type: z.enum(["trigger", "audit", "report"]), label: z.string().trim().min(1).max(160), enabled: z.boolean(), plan: planSchema.optional() }).strict();
export interface SecurityWorkflowNode { id: string; type: "trigger" | "audit" | "report"; label: string; enabled: boolean; plan?: ScanPlan }
export interface SecurityWorkflowInput { id?: string; revision?: number; name: string; instructions: string; target: string; nodes: SecurityWorkflowNode[]; edges: Array<{ source: string; target: string }> }
export interface SecurityWorkflow extends SecurityWorkflowInput { id: string; revision: number; createdAt: string; updatedAt: string }
export const SecurityWorkflowInputSchema = z.object({
  id: identifier.optional(), revision: z.number().int().positive().optional(), name: z.string().trim().min(1).max(160),
  instructions: z.string().trim().max(16_000), target: z.string().trim().max(4096),
  nodes: z.array(nodeSchema).min(2).max(16), edges: z.array(z.object({ source: identifier, target: identifier }).strict()).min(1).max(120),
}).strict().superRefine((workflow, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const ids = new Set(workflow.nodes.map(node => node.id));
  if (ids.size !== workflow.nodes.length) issue("Workflow node IDs must be unique.");
  const triggers = workflow.nodes.filter(node => node.type === "trigger");
  if (triggers.length !== 1) issue("A workflow requires exactly one trigger.");
  if (triggers.some(node => !node.enabled)) issue("The manual trigger must remain enabled.");
  if (!workflow.nodes.some(node => node.type === "audit")) issue("A workflow requires at least one audit.");
  if (workflow.nodes.filter(node => node.type === "report").length > 1) issue("A workflow supports at most one report.");
  if (workflow.nodes.some(node => node.type !== "audit" && node.plan !== undefined)) issue("Only audit nodes accept scan plans.");
  const edges = new Set<string>();
  const successors = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) issue("Edges must reference existing nodes.");
    const key = `${edge.source}:${edge.target}`;
    if (edges.has(key)) issue("Workflow edges must be unique.");
    edges.add(key);
    successors.set(edge.source, [...(successors.get(edge.source) ?? []), edge.target]);
    const source = workflow.nodes.find(node => node.id === edge.source);
    const target = workflow.nodes.find(node => node.id === edge.target);
    if (target?.type === "trigger" || source?.type === "report") issue("Triggers must start the graph and reports must end it.");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const next of successors.get(id) ?? []) if (!visit(next)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  if (workflow.nodes.some(node => !visit(node.id))) issue("Workflow graphs cannot contain cycles.");
  if (triggers.length === 1) {
    const reachable = new Set<string>();
    const walk = (id: string) => { if (reachable.has(id)) return; reachable.add(id); for (const next of successors.get(id) ?? []) walk(next); };
    walk(triggers[0]!.id);
    if (workflow.nodes.some(node => !reachable.has(node.id))) issue("Every node must be reachable from the trigger.");
  }
});
export function parseSecurityWorkflowInput(value: unknown): SecurityWorkflowInput {
  const workflow = SecurityWorkflowInputSchema.parse(value);
  return { ...workflow, nodes: workflow.nodes.map(node => node.type === "audit" ? { ...node, plan: node.plan ?? { ...DEFAULT_SECURITY_WORKFLOW_PLAN } } : node) };
}
export type SecurityWorkflowExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface SecurityWorkflowNodeResult { status: string; jobId?: string; scanId?: string; scanIds?: string[]; dbPaths?: string[]; error?: string }
export interface SecurityWorkflowExecution { id: string; workflowId: string; workflowRevision: number; workflow: SecurityWorkflow; sessionId: string; ownerPid: number; runnerInstanceId: string; status: SecurityWorkflowExecutionStatus; jobId?: string; nodeResults: Record<string, SecurityWorkflowNodeResult>; error?: string; createdAt: string; updatedAt: string }

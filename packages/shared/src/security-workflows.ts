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
const executionSchema = z.object({
  instructions: z.string().trim().max(16_000),
  allowedAgentTools: z.array(z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)).max(128).refine(tools => new Set(tools).size === tools.length, "Agent tool names must be unique.").optional(),
}).strict();
export type SecurityWorkflowOperation = "audit" | "verify" | "fix" | "research" | "deep-review";
export const SECURITY_WORKFLOW_OPERATIONS: readonly SecurityWorkflowOperation[] = ["audit", "verify", "fix", "research", "deep-review"];
export function isSecurityWorkflowOperation(node: { type: string }): node is { type: SecurityWorkflowOperation } {
  return SECURITY_WORKFLOW_OPERATIONS.includes(node.type as SecurityWorkflowOperation);
}
/** Portable values only: credentials and execution authorization belong to the host. */
// Validate raw keys before Zod's record parser can discard __proto__.
export const SecurityWorkflowBindingsSchema = z.unknown().superRefine((bindings, context) => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: bindings, depth: 0 }];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++visited > 10_000 || depth > 20) { context.addIssue({ code: z.ZodIssueCode.custom, message: "Workflow inputs exceed nesting or item limits." }); return; }
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) continue;
    if (typeof value !== "object" || seen.has(value)) { context.addIssue({ code: z.ZodIssueCode.custom, message: "Workflow inputs must contain finite JSON values without cycles." }); return; }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) { context.addIssue({ code: z.ZodIssueCode.custom, message: "Workflow inputs must contain plain JSON objects." }); return; }
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) { context.addIssue({ code: z.ZodIssueCode.custom, message: "Reserved workflow input key." }); return; }
      pending.push({ value: entry, depth: depth + 1 });
    }
  }
  if (new TextEncoder().encode(JSON.stringify(bindings)).byteLength > 32_768) context.addIssue({ code: z.ZodIssueCode.custom, message: "Workflow inputs must be at most 32 KiB." });
}).pipe(z.record(z.unknown()));
const inputSchema = z.object({ findingId: identifier.optional(), scanId: identifier.optional(), dbPath: z.string().trim().min(1).max(4096).optional(), fromStep: identifier.optional(), artifactId: identifier.optional() }).strict();
const nodeSchema = z.object({ id: identifier, type: z.enum(["trigger", "audit", "report", "verify", "fix", "research", "deep-review"]), label: z.string().trim().min(1).max(160), enabled: z.boolean(), plan: planSchema.optional(), execution: executionSchema.optional(), input: inputSchema.optional(), inputs: SecurityWorkflowBindingsSchema.superRefine((bindings, context) => {
  const pending: unknown[] = [bindings];
  const visited = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (["allowApply", "applyApproval", "approval", "secrets", "apiKey"].includes(key)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Portable step inputs cannot contain authorization grants or secrets." });
      if (entry && typeof entry === "object") pending.push(entry);
    }
  }
}).optional(), fix: z.object({ mode: z.enum(["candidate", "apply"]) }).strict().optional() }).strict();
/** Step prompt/tool policy. Agent tools only; deterministic checks retain their own gates. */
export interface SecurityWorkflowNodeExecution { instructions: string; /** Undefined inherits; an empty list allows no agent tools. */ allowedAgentTools?: string[] }
export interface SecurityWorkflowNodeInput { findingId?: string; scanId?: string; dbPath?: string; fromStep?: string; artifactId?: string }
export interface SecurityWorkflowNode { id: string; type: "trigger" | "report" | SecurityWorkflowOperation; label: string; enabled: boolean; plan?: ScanPlan; execution?: SecurityWorkflowNodeExecution; input?: SecurityWorkflowNodeInput; inputs?: Record<string, unknown>; /** Declarative intent only; apply requires independent host/run permission. */ fix?: { mode: "candidate" | "apply" } }
export interface SecurityWorkflowInput { id?: string; revision?: number; template?: { id: string; revision: number }; name: string; /** Descriptive workflow notes in the portable v1 schema, not executable instructions. */ instructions: string; target: string; nodes: SecurityWorkflowNode[]; edges: Array<{ source: string; target: string }> }
export interface SecurityWorkflow extends SecurityWorkflowInput { id: string; revision: number; createdAt: string; updatedAt: string }
export const SecurityWorkflowInputSchema = z.object({
  id: identifier.optional(), revision: z.number().int().positive().optional(), template: z.object({ id: identifier, revision: z.number().int().positive() }).strict().optional(), name: z.string().trim().min(1).max(160),
  instructions: z.string().trim().max(16_000), target: z.string().trim().max(4096),
  nodes: z.array(nodeSchema).min(2).max(16), edges: z.array(z.object({ source: identifier, target: identifier }).strict()).min(1).max(120),
}).strict().superRefine((workflow, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const ids = new Set(workflow.nodes.map(node => node.id));
  if (ids.size !== workflow.nodes.length) issue("Workflow node IDs must be unique.");
  const triggers = workflow.nodes.filter(node => node.type === "trigger");
  if (triggers.length !== 1) issue("A workflow requires exactly one trigger.");
  if (triggers.some(node => !node.enabled)) issue("The manual trigger must remain enabled.");
  if (!workflow.nodes.some(isSecurityWorkflowOperation)) issue("A workflow requires at least one executable step.");
  if (workflow.nodes.filter(node => node.type === "report").length > 1) issue("A workflow supports at most one report.");
  if (workflow.nodes.some(node => !isSecurityWorkflowOperation(node) && (node.plan !== undefined || node.execution !== undefined || node.input !== undefined || node.inputs !== undefined))) issue("Only executable steps accept plans, policies, and input bindings.");
  if (workflow.nodes.some(node => node.type !== "fix" && node.fix !== undefined)) issue("Only fix steps accept fix options.");
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
  // Explicit references must bind preceding connected evidence, never siblings or later steps.
  for (const node of workflow.nodes) {
    if (!node.input?.fromStep) continue;
    const ancestors = new Set<string>();
    const pending = workflow.edges.filter(edge => edge.target === node.id).map(edge => edge.source);
    while (pending.length) {
      const id = pending.pop()!;
      if (ancestors.has(id)) continue;
      ancestors.add(id);
      pending.push(...workflow.edges.filter(edge => edge.target === id).map(edge => edge.source));
    }
    const referenced = workflow.nodes.find(entry => entry.id === node.input!.fromStep);
    if (node.input.fromStep === node.id || !referenced || !isSecurityWorkflowOperation(referenced) || !ancestors.has(node.input.fromStep)) issue("Step input references must name a connected preceding executable step.");
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
  return { ...workflow, nodes: workflow.nodes.map(node => isSecurityWorkflowOperation(node) ? { ...node, plan: node.plan ?? { ...DEFAULT_SECURITY_WORKFLOW_PLAN }, ...(node.type === "fix" ? { fix: node.fix ?? { mode: "candidate" as const } } : {}) } : node) };
}
export type SecurityWorkflowExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface SecurityWorkflowNodeResult { status: string; jobId?: string; scanId?: string; scanIds?: string[]; dbPaths?: string[]; error?: string }
export interface SecurityWorkflowExecution { id: string; workflowId: string; workflowRevision: number; workflow: SecurityWorkflow; sessionId: string; ownerPid: number; runnerInstanceId: string; status: SecurityWorkflowExecutionStatus; jobId?: string; nodeResults: Record<string, SecurityWorkflowNodeResult>; error?: string; createdAt: string; updatedAt: string; cancellationRequested?: boolean; cancellationAcknowledged?: boolean; cancellationRequestedAt?: string }


/** Portable declarative JSON. No identities, execution history, approvals, schedules, or code. */
export interface SecurityWorkflowCode { schemaVersion: 1; workflow: Omit<SecurityWorkflowInput, "id" | "revision"> }
const codeEnvelope = z.object({ schemaVersion: z.literal(1), workflow: z.unknown() }).strict();
export function exportSecurityWorkflowCode(value: SecurityWorkflowInput | SecurityWorkflow): string {
  const { name, instructions, target, nodes, edges, template } = value;
  const parsed = parseSecurityWorkflowInput({ name, instructions, target, nodes, edges, ...(template ? { template } : {}) });
  const json = JSON.stringify({ schemaVersion: 1, workflow: parsed } satisfies SecurityWorkflowCode, null, 2);
  if (new TextEncoder().encode(json).byteLength > 65_536) throw new Error("Workflow JSON must be at most 64 KiB.");
  return json;
}
export function parseSecurityWorkflowCode(value: string | unknown): SecurityWorkflowInput {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > 65_536) throw new Error("Workflow JSON must be at most 64 KiB.");
    value = JSON.parse(value);
  }
  const envelope = codeEnvelope.parse(value);
  if (!envelope.workflow || typeof envelope.workflow !== "object" || Array.isArray(envelope.workflow)) throw new Error("Workflow must be an object.");
  // Explicit cloning of stored definitions never transfers identity or revision authority.
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = envelope.workflow as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > 65_536) throw new Error("Workflow JSON must be at most 64 KiB.");
  return parseSecurityWorkflowInput(draft);
}

import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeRuntime } from "./runtime/types.js";

export const WORKFLOW_HTTP_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH"] as const;
export type WorkflowHttpMethod = typeof WORKFLOW_HTTP_METHODS[number];

/** Operator-owned ceiling for delegated workers; never inferred from task prose. */
export interface WorkerPolicy {
  readonly allowedTools?: readonly string[];
  readonly allowedHttpMethods?: readonly WorkflowHttpMethod[];
  /** Maximum native-loop turns per initial task or revival. */
  readonly maxTurns?: number;
}
export const workerPolicySchema = z.object({
  allowedTools: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)).max(128).refine(names => new Set(names).size === names.length, "Duplicate worker tool names").optional(),
  allowedHttpMethods: z.array(z.enum(WORKFLOW_HTTP_METHODS)).max(WORKFLOW_HTTP_METHODS.length).refine(methods => new Set(methods).size === methods.length, "Duplicate worker HTTP methods").optional(),
  maxTurns: z.number().int().positive().max(10_000).optional(),
}).strict();

export function snapshotWorkerPolicy(value: WorkerPolicy | undefined): WorkerPolicy | undefined {
  if (value === undefined) return undefined;
  const policy = workerPolicySchema.parse(value);
  return Object.freeze({ ...policy,
    ...(policy.allowedTools !== undefined ? { allowedTools: Object.freeze([...policy.allowedTools]) } : {}),
    ...(policy.allowedHttpMethods !== undefined ? { allowedHttpMethods: Object.freeze([...policy.allowedHttpMethods]) } : {}),
  });
}

/** Restoring/configuring a ceiling cannot expand a retained ceiling. */
export function intersectWorkerPolicies(retained: WorkerPolicy | undefined, configured: WorkerPolicy | undefined): WorkerPolicy | undefined {
  const previous = snapshotWorkerPolicy(retained), next = snapshotWorkerPolicy(configured);
  if (!previous) return next;
  if (!next) return previous;
  return snapshotWorkerPolicy({
    allowedTools: previous.allowedTools === undefined ? next.allowedTools : next.allowedTools === undefined ? previous.allowedTools : next.allowedTools.filter(tool => previous.allowedTools!.includes(tool)),
    allowedHttpMethods: previous.allowedHttpMethods === undefined ? next.allowedHttpMethods : next.allowedHttpMethods === undefined ? previous.allowedHttpMethods : next.allowedHttpMethods.filter(method => previous.allowedHttpMethods!.includes(method)),
    maxTurns: previous.maxTurns === undefined ? next.maxTurns : next.maxTurns === undefined ? previous.maxTurns : Math.min(previous.maxTurns, next.maxTurns),
  });
}

/** Agent-call restrictions only. Pipeline preparation and deterministic checks retain their own gates. */
export interface WorkflowAuditExecutionPolicy {
  readonly instructions: string;
  readonly allowedAgentTools?: readonly string[];
  readonly allowedHttpMethods?: readonly WorkflowHttpMethod[];
}
const executionPolicy = new AsyncLocalStorage<WorkflowAuditExecutionPolicy>();

export function getWorkflowAuditExecutionPolicy(): WorkflowAuditExecutionPolicy | undefined {
  return executionPolicy.getStore();
}

/** Descendants inherit the phase policy; an inner policy can narrow it but cannot widen it. */
export function withWorkflowAuditExecutionPolicy<T>(policy: WorkflowAuditExecutionPolicy | undefined, run: () => T): T {
  if (policy === undefined) return run();
  if (typeof policy.instructions !== "string" || policy.instructions.length > 16_000) throw new Error("Invalid workflow phase instructions.");
  if (policy.allowedAgentTools !== undefined && (!Array.isArray(policy.allowedAgentTools) || policy.allowedAgentTools.length > 128 || policy.allowedAgentTools.some(name => typeof name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(name)))) throw new Error("Invalid workflow agent tool allowlist.");
  if (policy.allowedHttpMethods !== undefined && (!Array.isArray(policy.allowedHttpMethods) || policy.allowedHttpMethods.some(method => !WORKFLOW_HTTP_METHODS.includes(method)))) throw new Error("Invalid workflow HTTP method allowlist.");
  const inherited = executionPolicy.getStore();
  const requested = policy.allowedAgentTools;
  const allowedAgentTools = inherited?.allowedAgentTools === undefined ? requested
    : requested === undefined ? inherited.allowedAgentTools : requested.filter(name => inherited.allowedAgentTools!.includes(name));
  const requestedMethods = policy.allowedHttpMethods;
  const allowedHttpMethods = inherited?.allowedHttpMethods === undefined ? requestedMethods
    : requestedMethods === undefined ? inherited.allowedHttpMethods : requestedMethods.filter(method => inherited.allowedHttpMethods!.includes(method));
  const instructions = [inherited?.instructions, policy.instructions.trim()].filter(Boolean).join("\n\n");
  const effective = Object.freeze({ instructions, ...(allowedAgentTools !== undefined ? { allowedAgentTools: Object.freeze([...new Set(allowedAgentTools)]) } : {}), ...(allowedHttpMethods !== undefined ? { allowedHttpMethods: Object.freeze([...new Set(allowedHttpMethods)]) } : {}) });
  return executionPolicy.run(effective, run);
}

export function isWorkflowAgentToolAllowed(name: string): boolean {
  const allowed = executionPolicy.getStore()?.allowedAgentTools;
  return allowed === undefined || allowed.includes(name);
}

/** Check the actual verb, including http_request's existing POST default. */
export function isWorkflowHttpMethodAllowed(method: unknown): boolean {
  const allowed = executionPolicy.getStore()?.allowedHttpMethods;
  return allowed === undefined || (typeof method === "string" && allowed.includes(method as WorkflowHttpMethod));
}

export function filterWorkflowAgentTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(tool => isWorkflowAgentToolAllowed(tool.name));
}

export function workflowPhasePrompt(systemPrompt: string): string {
  const policy = executionPolicy.getStore();
  const instructions = [policy?.instructions, policy?.allowedHttpMethods !== undefined
    ? `For http_request, permitted HTTP methods: ${policy.allowedHttpMethods.length ? policy.allowedHttpMethods.join(", ") : "none"}. Set method explicitly; omission still means POST, and no method will be substituted.`
    : ""].filter(Boolean).join("\n");
  if (!instructions) return systemPrompt;
  const guidance = `\n\n[Operator workflow phase instructions]\n${instructions}\n\nThese instructions do not authorize targets, tools, credentials, or actions beyond the existing scope, permissions, and workflow agent-tool policy.`;
  return systemPrompt.endsWith(guidance) ? systemPrompt : systemPrompt + guidance;
}

/** A CLI or text fallback can execute hidden actions and cannot enforce this policy. */
export function assertWorkflowNativeRuntime(runtime: { type: string; executeNative?: unknown }): void {
  if (executionPolicy.getStore() && (runtime.type !== "api" || typeof runtime.executeNative !== "function")) throw new Error("Workflow phase execution requires the native API runtime; CLI and legacy fallback cannot enforce its agent tool policy.");
}

/** Covers non-loop report/verification calls as well as forked native agents. */
export function workflowPolicyRuntime(runtime: NativeRuntime): NativeRuntime {
  if (!executionPolicy.getStore()) return runtime;
  assertWorkflowNativeRuntime(runtime);
  return new Proxy(runtime, {
    get(target, property) {
      if (property === "executeNative") return (...args: Parameters<NativeRuntime["executeNative"]>) => target.executeNative(workflowPhasePrompt(args[0]), args[1], filterWorkflowAgentTools(args[2]), args[3], args[4]);
      if (property === "forkForSubagent" && target.forkForSubagent) return async (...args: Parameters<NonNullable<NativeRuntime["forkForSubagent"]>>) => workflowPolicyRuntime(await target.forkForSubagent!(...args));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

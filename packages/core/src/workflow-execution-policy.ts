import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeRuntime } from "./runtime/types.js";

/** Agent-call restrictions only. Pipeline preparation and deterministic checks retain their own gates. */
export interface WorkflowAuditExecutionPolicy {
  readonly instructions: string;
  readonly allowedAgentTools?: readonly string[];
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
  const inherited = executionPolicy.getStore();
  const requested = policy.allowedAgentTools;
  const allowedAgentTools = inherited?.allowedAgentTools === undefined ? requested
    : requested === undefined ? inherited.allowedAgentTools : requested.filter(name => inherited.allowedAgentTools!.includes(name));
  const instructions = [inherited?.instructions, policy.instructions.trim()].filter(Boolean).join("\n\n");
  const effective = Object.freeze({ instructions, ...(allowedAgentTools !== undefined ? { allowedAgentTools: Object.freeze([...new Set(allowedAgentTools)]) } : {}) });
  return executionPolicy.run(effective, run);
}

export function isWorkflowAgentToolAllowed(name: string): boolean {
  const allowed = executionPolicy.getStore()?.allowedAgentTools;
  return allowed === undefined || allowed.includes(name);
}

export function filterWorkflowAgentTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(tool => isWorkflowAgentToolAllowed(tool.name));
}

export function workflowPhasePrompt(systemPrompt: string): string {
  const instructions = executionPolicy.getStore()?.instructions;
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

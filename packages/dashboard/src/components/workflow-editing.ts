import type { SecurityWorkflow, SecurityWorkflowInput, SecurityWorkflowNode } from "@0/shared";
import { DEFAULT_SECURITY_WORKFLOW_PLAN, parseSecurityWorkflowInput } from "@0/shared/dist/security-workflows.js";

export function workflowInput(definition: SecurityWorkflow): SecurityWorkflowInput {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = definition;
  return input;
}

/** Structural edits preserve a simple chain. Branched graphs use the definition editor. */
export function linearWorkflowNodes(definition: SecurityWorkflowInput): SecurityWorkflowNode[] | null {
  const trigger = definition.nodes.find(node => node.type === "trigger");
  if (!trigger || definition.edges.length !== definition.nodes.length - 1) return null;
  const ordered: SecurityWorkflowNode[] = [];
  const visited = new Set<string>();
  let current: SecurityWorkflowNode | undefined = trigger;
  while (current && !visited.has(current.id)) {
    visited.add(current.id); ordered.push(current);
    const outgoing = definition.edges.filter(edge => edge.source === current!.id);
    if (outgoing.length > 1 || definition.edges.filter(edge => edge.target === current!.id).length > (current.type === "trigger" ? 0 : 1)) return null;
    current = outgoing.length ? definition.nodes.find(node => node.id === outgoing[0]!.target) : undefined;
  }
  return ordered.length === definition.nodes.length ? ordered : null;
}

export function addWorkflowPhase(definition: SecurityWorkflow): SecurityWorkflowInput {
  const nodes = linearWorkflowNodes(definition);
  if (!nodes) throw new Error("Edit the definition to add a phase to a branched graph.");
  const newNode: SecurityWorkflowNode = { id: `review_${crypto.randomUUID().replaceAll("-", "")}`, type: "audit", label: "Security review", enabled: true, plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN } };
  const reportIndex = nodes.findIndex(node => node.type === "report");
  nodes.splice(reportIndex < 0 ? nodes.length : reportIndex, 0, newNode);
  return parseSecurityWorkflowInput({ ...workflowInput(definition), nodes, edges: nodes.slice(1).map((node, index) => ({ source: nodes[index]!.id, target: node.id })) });
}

export function removeWorkflowPhase(definition: SecurityWorkflow, id: string): SecurityWorkflowInput {
  const ordered = linearWorkflowNodes(definition);
  if (!ordered) throw new Error("Edit the definition to remove a phase from a branched graph.");
  const phase = ordered.find(node => node.id === id);
  if (!phase || phase.type === "trigger") throw new Error("The manual trigger must remain in the workflow.");
  if (phase.type === "audit" && ordered.filter(node => node.type === "audit").length < 2) throw new Error("Keep at least one review phase.");
  const nodes = ordered.filter(node => node.id !== id);
  return parseSecurityWorkflowInput({ ...workflowInput(definition), nodes, edges: nodes.slice(1).map((node, index) => ({ source: nodes[index]!.id, target: node.id })) });
}

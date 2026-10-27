import type { SecurityWorkflow, SecurityWorkflowNode, SecurityWorkflowTemplate } from "@0/shared";

export const WHITEBOX_CODE_PENTEST = "Whitebox pentest";
const SOURCE_TEMPLATES = new Set(["repository-review", "contract-review", "native-code-review"]);

/** Display source analysis distinctly from a running web target; IDs stay portable. */
export function assessmentLabel(definition: Pick<SecurityWorkflow, "target" | "template">): string {
  const target = (definition.target ?? "").trim();
  const localSource = target.startsWith("/") || target.startsWith("./") || target.startsWith("../") || target.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(target)
    || (!/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("@") && target.includes("/"));
  if (SOURCE_TEMPLATES.has(definition.template?.id ?? "") || localSource || /\.git(?:$|[?#])/i.test(target)) return WHITEBOX_CODE_PENTEST;
  return /^https?:\/\//i.test(target) ? "Web pentest" : "Security assessment";
}

export function workflowOperationLabel(node: Pick<SecurityWorkflowNode, "type" | "fix">, definition: Pick<SecurityWorkflow, "target" | "template">): string {
  switch (node.type) {
    case "trigger": return "Manual trigger";
    case "audit": return assessmentLabel(definition);
    case "deep-review": return WHITEBOX_CODE_PENTEST;
    case "verify": return "Finding verification";
    case "fix": return "Fix candidate";
    case "research": return "Security research";
    case "report": return "Result collection";
  }
}

export function workflowTemplateOperationLabel(template: SecurityWorkflowTemplate): string {
  return template.executor === "assessment"
    ? template.compatibleTargetTypes.every(type => type === "url" || type === "web-app") ? "Web pentest" : assessmentLabel({ target: "", template: { id: template.id, revision: template.revision } })
    : workflowOperationLabel({ type: template.executor }, { target: "", template: undefined });
}

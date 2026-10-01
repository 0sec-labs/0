import { describe, expect, it } from "vitest";
import { SECURITY_WORKFLOW_TEMPLATES, createSecurityWorkflowTemplate } from "./security-workflow-templates.js";
import { exportSecurityWorkflowCode, parseSecurityWorkflowCode, parseSecurityWorkflowInput } from "./security-workflows.js";

describe("built-in security workflow templates", () => {
  it("provides eight bounded multi-phase drafts using real scan plans and execution instructions", () => {
    expect(SECURITY_WORKFLOW_TEMPLATES).toHaveLength(8);
    expect(new Set(SECURITY_WORKFLOW_TEMPLATES.map(template => template.id)).size).toBe(8);
    for (const template of SECURITY_WORKFLOW_TEMPLATES) {
      const draft = parseSecurityWorkflowInput(template.definition);
      expect(draft.target).toBe(""); expect(draft.id).toBeUndefined(); expect(draft.revision).toBeUndefined();
      const phases = draft.nodes.filter(node => node.type === "audit");
      expect(phases.length).toBeGreaterThanOrEqual(2);
      expect(new Set(phases.map(node => node.execution?.instructions)).size).toBe(phases.length);
      for (const phase of phases) { expect(phase.execution?.instructions.length).toBeGreaterThan(40); expect(phase.plan?.timeCapMs).toBe(600000); expect(phase.plan?.costCapUsd).toBe(5); }
      expect(parseSecurityWorkflowCode(exportSecurityWorkflowCode(draft))).toEqual(draft);
    }
  });
  it("clones independently without changing the catalog or another user's draft", () => {
    const first = createSecurityWorkflowTemplate("scoped-penetration-test");
    first.nodes[1]!.execution!.instructions = "Changed"; first.nodes[1]!.plan!.costCapUsd = 9;
    const second = createSecurityWorkflowTemplate("scoped-penetration-test");
    expect(second.nodes[1]?.execution?.instructions).not.toBe("Changed"); expect(second.nodes[1]?.plan?.costCapUsd).toBe(5);
    expect(() => createSecurityWorkflowTemplate("nonexistent")).toThrow(/Unknown/);
  });
});

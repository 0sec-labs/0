import { describe, expect, it } from "vitest";
import { SECURITY_WORKFLOW_TEMPLATES, createSecurityWorkflowTemplate, getSecurityWorkflowTemplate, checkSecurityWorkflowTemplateTarget } from "./security-workflow-templates.js";
import { exportSecurityWorkflowCode, parseSecurityWorkflowCode, parseSecurityWorkflowInput } from "./security-workflows.js";

describe("built-in security workflow templates", () => {
  it("provides bounded assessment sequences and typed operation drafts using real scan plans and execution instructions", () => {
    expect(SECURITY_WORKFLOW_TEMPLATES).toHaveLength(12);
    expect(new Set(SECURITY_WORKFLOW_TEMPLATES.map(template => template.id)).size).toBe(12);
    for (const template of SECURITY_WORKFLOW_TEMPLATES) {
      const draft = parseSecurityWorkflowInput(template.definition);
      expect(draft.target).toBe(""); expect(draft.id).toBeUndefined(); expect(draft.revision).toBeUndefined();
      if (template.executor !== "assessment") {
        expect(draft.nodes.filter(node => node.type === template.executor)).toHaveLength(1);
        expect(draft.nodes.find(node => node.type === template.executor)?.plan?.costCapUsd).toBe(5);
        expect(parseSecurityWorkflowCode(exportSecurityWorkflowCode(draft))).toEqual(draft);
        continue;
      }
      const phases = draft.nodes.filter(node => node.type === "audit");
      expect(phases.length).toBeGreaterThanOrEqual(2);
      expect(new Set(phases.map(node => node.execution?.instructions)).size).toBe(phases.length);
      for (const phase of phases) { expect(phase.execution?.instructions.length).toBeGreaterThan(40); expect(phase.plan?.timeCapMs).toBe(600000); expect(phase.plan?.costCapUsd).toBe(5); }
      expect(parseSecurityWorkflowCode(exportSecurityWorkflowCode(draft))).toEqual(draft);
    }
  });
  it("declares real executor support and rejects incompatible targets and stale revisions", () => {
    for (const template of SECURITY_WORKFLOW_TEMPLATES) {
      expect(template.revision).toBe(1);
      expect(["assessment", "verify", "fix", "research", "deep-review"]).toContain(template.executor);
      expect(template.profile).toBe("default");
      expect(template.compatibleTargetTypes.length).toBeGreaterThan(0);
      expect(template.expectedOutputs).toContain("artifacts");
      for (const targetType of template.compatibleTargetTypes) expect(() => checkSecurityWorkflowTemplateTarget(template, targetType)).not.toThrow();
    }
    expect(() => createSecurityWorkflowTemplate("repository-review", { targetType: "url" })).toThrow(/does not support/);
    expect(() => createSecurityWorkflowTemplate("api-security", { targetType: "source-code" })).toThrow(/does not support/);
    expect(() => getSecurityWorkflowTemplate("repository-review", 2)).toThrow(/revision mismatch/);
    const resolved = createSecurityWorkflowTemplate("repository-review", { target: "/project", targetType: "source-code", revision: 1 });
    expect(resolved.target).toBe("/project");
    expect(resolved.template).toEqual({ id: "repository-review", revision: 1 });
    expect(parseSecurityWorkflowCode(exportSecurityWorkflowCode(resolved)).template).toEqual(resolved.template);
    const selected = getSecurityWorkflowTemplate("repository-review");
    selected.compatibleTargetTypes = ["url"];
    selected.definition.nodes[1]!.label = "Changed";
    expect(getSecurityWorkflowTemplate("repository-review").compatibleTargetTypes).toEqual(["source-code"]);
    expect(getSecurityWorkflowTemplate("repository-review").definition.nodes[1]!.label).not.toBe("Changed");
  });
  it("declares finding requirements and never grants fix application", () => {
    const fix = getSecurityWorkflowTemplate("fix-candidate");
    const step = fix.definition.nodes.find(node => node.type === "fix")!;
    expect(step.fix).toEqual({ mode: "candidate" });
    expect(step.inputs).toBeUndefined();
    expect(fix.inputRequirements.some(input => input.names.includes("testCommand") && input.required)).toBe(true);
    expect(getSecurityWorkflowTemplate("finding-verification").inputRequirements.some(input => input.names.includes("runner") && input.required)).toBe(true);
    expect(getSecurityWorkflowTemplate("security-research").definition.nodes.find(node => node.type === "research")?.inputs).toEqual({ engine: "pipeline" });
  });
  it("clones independently without changing the catalog or another user's draft", () => {
    const first = createSecurityWorkflowTemplate("scoped-penetration-test");
    first.nodes[1]!.execution!.instructions = "Changed"; first.nodes[1]!.plan!.costCapUsd = 9;
    const second = createSecurityWorkflowTemplate("scoped-penetration-test");
    expect(second.nodes[1]?.execution?.instructions).not.toBe("Changed"); expect(second.nodes[1]?.plan?.costCapUsd).toBe(5);
    expect(() => createSecurityWorkflowTemplate("nonexistent")).toThrow(/Unknown/);
  });
});

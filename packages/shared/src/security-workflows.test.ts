import { describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_WORKFLOW_PLAN, exportSecurityWorkflowCode, parseSecurityWorkflowCode, parseSecurityWorkflowInput } from "./security-workflows.js";
const draft = () => ({ name: "Review repository", instructions: "Review dependencies", target: "", nodes: [{ id: "start", type: "trigger", label: "Manual", enabled: true }, { id: "audit", type: "audit", label: "Audit", enabled: true }, { id: "report", type: "report", label: "Report", enabled: true }], edges: [{ source: "start", target: "audit" }, { source: "audit", target: "report" }] });
describe("security workflow definition validation", () => {
  it("accepts a draft without authorization target and supplies independent finite audit limits", () => {
    const parsed = parseSecurityWorkflowInput(draft());
    expect(parsed.target).toBe(""); expect(parsed.nodes[1]?.plan).toEqual(DEFAULT_SECURITY_WORKFLOW_PLAN);
    parsed.nodes[1]!.plan!.costCapUsd = 7;
    expect(DEFAULT_SECURITY_WORKFLOW_PLAN.costCapUsd).toBe(5);
  });
  it.each([
    ["cycle", (value: ReturnType<typeof draft>) => { value.edges.push({ source: "audit", target: "start" }); }],
    ["disconnected audit", (value: ReturnType<typeof draft>) => { value.nodes.push({ id: "other", type: "audit", label: "Other", enabled: true }); }],
    ["duplicate IDs", (value: ReturnType<typeof draft>) => { value.nodes[1]!.id = "start"; }],
    ["unknown edge", (value: ReturnType<typeof draft>) => { value.edges[0]!.target = "missing"; }],
    ["report not terminal", (value: ReturnType<typeof draft>) => { value.edges.push({ source: "report", target: "audit" }); }],
    ["multiple triggers", (value: ReturnType<typeof draft>) => { value.nodes[1]!.type = "trigger"; }],
  ] as const)("rejects %s", (_name, change) => { const value = draft(); change(value); expect(() => parseSecurityWorkflowInput(value)).toThrow(); });
  it("rejects arbitrary executors and plans exceeding actual launch bounds", () => {
    expect(() => parseSecurityWorkflowInput({ ...draft(), command: "curl" })).toThrow();
    expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => ({ ...node, id: "__proto__" })) })).toThrow();
    expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: [{ ...draft().nodes[0], plan: DEFAULT_SECURITY_WORKFLOW_PLAN }, ...draft().nodes.slice(1)] })).toThrow();
    for (const limits of [{ costCapUsd: Infinity }, { costCapUsd: 1001 }, { timeCapMs: 1.5 }, { timeCapMs: 0 }, { runCount: 17 }]) {
      expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, plan: { ...DEFAULT_SECURITY_WORKFLOW_PLAN, ...limits } } : node) })).toThrow();
    }
  });
});


describe("portable security workflow JSON and phase policies", () => {
  it("round-trips execution policy without transferring saved identity or approvals", () => {
    const source = { ...draft(), id: "stored-identity", revision: 9, createdAt: "2026-01-01", updatedAt: "2026-02-01", nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, execution: { instructions: "Inspect authentication", allowedAgentTools: [] } } : node) };
    const exported = JSON.parse(exportSecurityWorkflowCode(source));
    expect(exported.schemaVersion).toBe(1);
    expect(exported.workflow).not.toHaveProperty("id"); expect(exported.workflow).not.toHaveProperty("revision"); expect(exported.workflow).not.toHaveProperty("createdAt");
    const imported = parseSecurityWorkflowCode(JSON.stringify(exported));
    expect(imported.nodes[1]?.execution).toEqual({ instructions: "Inspect authentication", allowedAgentTools: [] });
    const clone = parseSecurityWorkflowCode({ schemaVersion: 1, workflow: source });
    expect(clone).not.toHaveProperty("id"); expect(clone).not.toHaveProperty("revision");
  });
  it("rejects unknown code versions, executors, and malformed phase restrictions", () => {
    expect(() => parseSecurityWorkflowCode({ schemaVersion: 2, workflow: draft() })).toThrow();
    expect(() => parseSecurityWorkflowCode({ schemaVersion: 1, script: "process.exit()", workflow: draft() })).toThrow();
    for (const execution of [{ instructions: "x", command: "bash" }, { instructions: "x".repeat(16001) }, { instructions: "x", allowedAgentTools: ["http_request", "http_request"] }, { instructions: "x", allowedAgentTools: ["shell --anything"] }, { instructions: "x", allowedAgentTools: Array.from({ length: 129 }, (_, index) => `tool_${index}`) }]) {
      expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, execution } : node) })).toThrow();
    }
    expect(() => parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "trigger" ? { ...node, execution: { instructions: "x" } } : node) })).toThrow();
    expect(() => parseSecurityWorkflowCode(" ".repeat(65537))).toThrow(/64 KiB/);
  });
  it("preserves inheriting and explicit-empty tool policies as different states", () => {
    const parsed = parseSecurityWorkflowInput({ ...draft(), nodes: draft().nodes.map(node => node.type === "audit" ? { ...node, execution: { instructions: "x", allowedAgentTools: ["mcp.server:query", "custom-tool"] } } : node) });
    expect(parsed.nodes[1]?.execution?.allowedAgentTools).toEqual(["mcp.server:query", "custom-tool"]);
    expect(parseSecurityWorkflowInput(draft()).nodes[1]?.execution).toBeUndefined();
  });
});
